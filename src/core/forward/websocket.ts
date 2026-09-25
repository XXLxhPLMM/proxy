import http from "node:http";
import type { Duplex } from "node:stream";
import type { ConfigAccessor } from "@/config/accessor.js";
import {
  formatAuthority,
  isStrippableOutboundHeader,
  isSocksProto,
  isTlsUpstreamProto,
  parseTargetParts,
  resolveForwardTargets,
  resolveRoute,
  socksVersionOf,
  upstreamAuthValue,
  type TargetParts,
} from "@/core/proxy-helpers.js";
import { awaitStatusLine, socksUpstreamGuard } from "@/core/guard.js";
import {
  CRLF,
  DOUBLE_CRLF,
  HEADER_NAME_HOST_LOWER,
  HEADER_NAME_HOST_TITLE,
  HEADER_NAME_PROXY_AUTHORIZATION,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
  STATUS_GATEWAY_TIMEOUT,
  STATUS_SWITCHING_PROTOCOLS,
} from "@/utils/constants.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import {
  RequestTerminal,
  associateRequestTerminal,
  requestTerminalFor,
} from "@/core/request-terminal.js";
import { DialTimeoutError } from "./dial.js";
import { ForwarderBase } from "./base.js";

/**
 * 构建 Upgrade 请求（剔除 proxy-* 头，重写 Host）
 * @param req - 原始 Upgrade 请求
 * @param host - 握手 Host 回写主机（客户端请求的目标）
 * @param port - 握手 Host 回写端口
 * @param path - origin-form 请求目标（server 直连与经 SOCKS 隧道时使用）
 * @param toUpstreamProxy - 是否发给有效模式为 client 的 http/https 上游代理：
 *   true 时 request-target 保留客户端的 absolute-form——上游代理收到 origin-form 的
 *   `GET /ws` 会当成「发给代理自身的请求」而不会转发升级；并注入 Proxy-Authorization
 *   （上游凭证，仅显式配 upstreamUsername 时携带）。经 SOCKS 隧道或路由名单命中直连
 *   已直达真实目标，必须用 origin-form 且绝不能带上游凭证
 * @param config - 配置访问器，必须显式注入（决定出站头剥离判据与上游凭证读取）
 * @description Host 回写走 `formatAuthority`：解析侧已剥去 IPv6 方括号，
 *   拼装侧必须补回（否则 `::1:80` 是畸形 authority，上游/源站无法解析）
 */
function buildUpgradeReq(
  req: http.IncomingMessage,
  host: string,
  port: number,
  path: string,
  toUpstreamProxy: boolean,
  config: ConfigAccessor,
): string {
  const target = toUpstreamProxy ? (req.url ?? path) : path;
  const requestLine = `${req.method} ${target} HTTP/${req.httpVersion}${CRLF}`;

  const headerLines: string[] = [];

  const raw = req.rawHeaders ?? [];

  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];

    // 出站净化与 sanitizeHeaders 同谓词：任意 proxy- 前缀 + 命中代理凭证的 authorization
    if (isStrippableOutboundHeader(name, value, config)) {
      continue;
    }

    if (name.toLowerCase() === HEADER_NAME_HOST_LOWER) {
      headerLines.push(`${HEADER_NAME_HOST_TITLE}: ${formatAuthority(host, port)}`);
    } else {
      headerLines.push(`${name}: ${value}`);
    }
  }

  // 仅向 http/https 上游代理注入（与 forwardViaRequest 同规则）：socks 隧道/直连直达真实目标，不得携带
  if (toUpstreamProxy) {
    const auth = upstreamAuthValue(config);

    if (auth) {
      headerLines.push(`${HEADER_NAME_PROXY_AUTHORIZATION}: ${auth}`);
    }
  }

  return `${requestLine}${headerLines.join(CRLF)}${DOUBLE_CRLF}`;
}

/**
 * WebSocket/Upgrade 转发器
 * Upgrade 语义与 HTTP 类似，但需等 101 才桥接
 * - 拨号器与事件槽（dialer/emit）继承自 {@link ForwarderBase}
 * - 拒绝收尾统一写原始状态行报文（见 {@link WsForwarder.refuse}）：407/403 同款形态，
 *   不再「名单拒绝写 403、拨号失败静默 destroy」两套语义并存
 */
export class WsForwarder extends ForwarderBase {
  /**
   * Upgrade 入口：client+socks 上游分流走隧道（内部再做路由判定），其余按有效模式直拨/串联等 101
   * @param req 握手请求 @param socket 下游 @param head 已读半包
   */
  handle(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    terminal?: RequestTerminal,
  ): void {
    const requestTerminal = terminal ?? requestTerminalFor(req) ?? new RequestTerminal();
    associateRequestTerminal(req, requestTerminal);

    // 配置模式仅用于 socks 上游早分支（目标尚未解析，无法做路由判定；分支内自行 resolveRoute）
    // 读取本转发器显式注入的访问器，不直接依赖任何全局配置状态
    const mode = this.config.get("proxyMode");
    const proto = this.config.get("upstreamProtocol");

    // socks 上游需真实目标建隧道，而非 upstreamHost（自环/名单/路由判定在 viaSocks 内做）
    if (mode === "client" && isSocksProto(proto)) {
      this.viaSocks(req, socket, head, proto, requestTerminal);
      return;
    }

    // 拨号目标与客户端请求的目标成对解析（名单判 dest、拨号用 dial、route 判路由），见 resolveForwardTargets
    const targets = resolveForwardTargets(req.url, req.headers.host as string, this.config);

    if (!targets) {
      this.refuse(socket, STATUS_BAD_REQUEST);
      requestTerminal.reject("invalid-target", "parse", STATUS_BAD_REQUEST);
      return;
    }

    // 自环看有效拨号地址（名单命中直连时即真实目标）、名单看客户端请求的目标，与 http/tunnel/socks 共用同一前置守卫
    if (
      this.preDial({
        req,
        dial: targets.dial,
        dest: targets.dest,
        deny: (status) => {
          this.refuse(socket, status);
          if (status === STATUS_BAD_REQUEST) {
            requestTerminal.reject("bad-request", "parse", status);
          } else if (status === STATUS_FORBIDDEN) {
            requestTerminal.reject("target-denied", "access", status);
          } else {
            requestTerminal.fail(new Error("proxy loop detected"), "dial");
          }
        },
      })
    ) {
      return;
    }

    // preDial 已过：client 配置恰发一条路由事件（server 配置在 emitRoute 内短路）
    this.emitRoute(targets.dest, targets.route);

    // 有效模式（client 配置 + 名单命中回落 server），后续分支一律用它、不再裸读 proxyMode
    const route = targets.route;

    // secure 映射：有效 client 且 https/sockss* 走 TLS，其余明文（isTlsUpstreamProto 唯一判据）
    const secure = route.mode === "client" && isTlsUpstreamProto(proto);

    this.upgradeOver(
      req,
      socket,
      head,
      targets.dest,
      this.dialer.choose(socket, targets.dial.host, targets.dial.port, secure, {
        // 守卫不写报文、保客户端：成败应答归 upgradeOver 的 catch（超时 504、错误 502），
        // 成因经 onEvent 上抛到日志
        ...socksUpstreamGuard("upgrade", (e) => this.emit(e)),
        target: `${targets.dial.host}:${targets.dial.port}`,
      }),
      route.mode,
      false,
      requestTerminal,
    );
  }

  /**
   * 拨号成功后接管 Upgrade：写握手报文（剔 proxy 头 + 重写 Host）→ 回灌已读半包 → 等 101 桥接；
   * 失败落盘并按成因写 504（超时）/502（其余）收尾（与 denyIfForbidden 时代的 403 同款写报文语义）
   * @param target - 客户端请求的目标（握手报文 Host 按它回写；直拨与 socks 上游即建链目标，
   *                 client 模式经 http/https 上游时它是上游的服务器上真正要访问的站点，与拨号地址不同）
   * @param upstreamDial - 上游拨号 Promise
   * @param mode - **有效模式**（调用方取自 resolveRoute；client 命中路由名单回落即 server），
   *   toUpstreamProxy 的唯一判据之一，不再裸读 proxyMode
   * @param viaSocks - 是否经 SOCKS 隧道（影响 toUpstreamProxy 与失败日志文案）
   */
  private upgradeOver(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: TargetParts,
    upstreamDial: Promise<Duplex>,
    mode: "server" | "client",
    viaSocks: boolean,
    terminal: RequestTerminal,
  ): void {
    upstreamDial
      .then((upstream) => {
        // 有效 client 经 http/https 上游：request-target 保留 absolute-form + 注入上游凭证；
        // server 直连（含路由名单命中回落）与经 SOCKS 隧道已直达真实目标，用 origin-form 且不带上游凭证
        const toUpstreamProxy = mode === "client" && !viaSocks;

        upstream.write(
          buildUpgradeReq(req, target.host, target.port, target.path, toUpstreamProxy, this.config),
        );

        if (head.length) {
          upstream.write(head);
        }

        void this.relay(socket, upstream, `${target.host}:${target.port}`, terminal);
      })
      .catch((err: Error) => {
        // 拨号失败成因必须落盘（守卫 keepClientOnFailure 留了客户端），随后按成因写状态行收尾
        this.emit({
          type: "upstream-error",
          message: `[upgrade] upstream error ${viaSocks ? "via socks " : ""}${target.host}:${target.port}: ${err.message}`,
          err,
        });
        this.refuseByCause(socket, err);
        terminal.fail(err, "dial");
      });
  }

  /**
   * 经 SOCKS 隧道发 Upgrade：隧道直达真实目标后走同 dial 流程；
   * client 配置命中 upstream 路由名单时回落直拨真实目标（origin-form、无上游凭证）
   */
  private viaSocks(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    proto: string,
    terminal: RequestTerminal,
  ): void {
    const real = parseTargetParts(req.url ?? "", req.headers.host as string);

    if (!real) {
      this.refuse(socket, STATUS_BAD_REQUEST);
      terminal.reject("invalid-target", "parse", STATUS_BAD_REQUEST);
      return;
    }

    // 真实目标的自环/名单判定与其余三个转发器共用前置守卫（socks 隧道拨的是上游，另在下方判上游自环）
    if (
      this.preDial({
        req,
        dial: real,
        dest: real,
        deny: (status) => {
          this.refuse(socket, status);
          if (status === STATUS_BAD_REQUEST) {
            terminal.reject("bad-request", "parse", status);
          } else if (status === STATUS_FORBIDDEN) {
            terminal.reject("target-denied", "access", status);
          } else {
            terminal.fail(new Error("proxy loop detected"), "dial");
          }
        },
      })
    ) {
      return;
    }

    // preDial 已过：路由判定（本早分支仅在配置 client 时进入，必发一条路由事件）
    const route = resolveRoute(real, this.config);
    this.emitRoute(real, route);

    if (route.route === "direct") {
      // upstream 路由名单命中 → 直拨真实目标（有效模式回落 server：origin-form、无上游凭证）
      this.upgradeOver(
        req,
        socket,
        head,
        real,
        this.dialer.choose(socket, real.host, real.port, false, {
          // 守卫不写报文、保客户端：成败应答归 upgradeOver 的 catch（超时 504、错误 502）
          ...socksUpstreamGuard("upgrade", (e) => this.emit(e)),
          target: `${real.host}:${real.port}`,
        }),
        route.mode,
        false,
        terminal,
      );
      return;
    }

    // 上游自环：socks 隧道拨的是上游，上游指回自身监听地址会成环（真实目标的自环已在上方判过；名单不判上游）
    if (
      this.denyUpstreamLoopAuto(
        () => {
          this.refuse(socket, STATUS_BAD_GATEWAY);
          terminal.fail(new Error("upstream proxy loop detected"), "dial");
        },
        { req },
      )
    ) {
      return;
    }

    this.upgradeOver(
      req,
      socket,
      head,
      real,
      this.dialer.dialSocks(
        socket,
        real.host,
        real.port,
        socksVersionOf(proto),
        undefined,
        // 守卫不写报文、保客户端：成败应答归 upgradeOver 的 catch（超时 504、错误 502）
        socksUpstreamGuard("upgrade", (e) => this.emit(e)),
      ),
      route.mode,
      true,
      terminal,
    );
  }

  /**
   * 等 101 桥接：严格解析状态行判 101；非 101 原样回透响应后按上游 EOF 语义收尾
   * - 状态行用 RE_HTTP_STATUS_LINE 提取三位码严格比对，避免 `302` + `Content-Length: 1010`
   *   之类子串被 `includes("101")` 误判为升级成功
   * - 等待收口在 `awaitStatusLine`：定时器归其所有（缺省 upstreamTimeout），上游失败时由它销毁，
   *   超时/超限成因经 upstream-error 上抛，客户端按成因写 504/502 收尾（不再静默双毁）
   * - 非 101 不再截断：首包（`head` + `rest`）写完后继续把上游剩余 body relay 给客户端，
   *   否则 `Content-Length` 大于首包时客户端挂等；上游错误/关闭的收尾归 `guardDialing` 既有 handler
   * @param addr - 目标地址（失败日志路由）
   */
  private async relay(
    client: Duplex,
    upstream: Duplex,
    addr: string,
    terminal: RequestTerminal,
  ): Promise<void> {
    const res = await awaitStatusLine(upstream, {
      timeout: this.config.get("upstreamTimeout") as number,
      onTimeout: () => {
        this.emit({
          type: "upstream-error",
          message: `[upgrade] upstream response timeout ${addr}`,
        });
      },
      onOverflow: () => {
        this.emit({
          type: "upstream-error",
          message: `[upgrade] upstream response overflow ${addr}`,
        });
      },
    });

    if (!res.ok) {
      // 超时/超限：上游已由 awaitStatusLine 销毁、成因已落盘；客户端按成因写 504/502 后收尾
      const error =
        res.cause === "timeout"
          ? new DialTimeoutError(`upgrade response timeout ${addr}`)
          : new Error(`upgrade response overflow ${addr}`);
      this.refuse(client, res.cause === "timeout" ? STATUS_GATEWAY_TIMEOUT : STATUS_BAD_GATEWAY);
      terminal.fail(error, "forward");
      return;
    }

    // 严格取状态码：仅 101 视为升级成功，杜绝 `302` + `Content-Length: 1010` 之类子串误判
    if (res.statusCode === String(STATUS_SWITCHING_PROTOCOLS)) {
      client.write(res.head);

      if (res.rest.length) {
        client.write(res.rest);
      }

      terminal.complete(101);
      this.dialer.bridge(client, upstream);
    } else {
      client.write(Buffer.concat([res.head, res.rest]));
      terminal.fail(new Error(`upgrade expected 101, got ${res.statusCode}`), "forward");

      // 非 101：响应体可能超出首包（Content-Length 大于已读字节），继续 relay 剩余 body。
      // 必须保留 readableEnded 分支：上游若在同一轮读取里 push 了 EOF（响应 + Connection: close
      // 的常见形态），'end' 可能早于本续体挂 pipe 之前发出，直接 pipe 会漏掉 end → 客户端挂死。
      // 上游错误/关闭的收尾归 guardDialing 既有 handler，这里不额外 destroy
      if (upstream.readableEnded) {
        client.end();
      } else {
        upstream.pipe(client);
      }
    }
  }
}

export function forwardUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  config: ConfigAccessor,
  sink?: PipeEventSink,
  terminal?: RequestTerminal,
): void {
  new WsForwarder(sink, config).handle(req, socket, head, terminal);
}
