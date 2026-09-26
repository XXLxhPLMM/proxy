import http from "node:http";
import type { Duplex } from "node:stream";
import type { ConfigAccessor } from "@/config/index.js";
import type { CoreContext } from "@/core/context.js";
import {
  formatAuthority,
  isStrippableOutboundHeader,
  resolveForwardTargets,
  upstreamAuthValue,
  type TargetParts,
} from "@/core/helpers/index.js";
import { awaitStatusLine } from "@/core/guard.js";
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
} from "@/utils/constants/index.js";
import type { RequestScope } from "@/core/request-scope.js";
import { associateRequestTerminal } from "@/core/request-terminal.js";
import type { BufferedCharge, TrafficAccount } from "@/core/traffic/index.js";
import { connectorFor, directConnector } from "./connector/index.js";
import type { UpstreamConnector } from "./connector/index.js";
import { DialTimeoutError } from "./dial.js";
import { ForwarderBase } from "./base.js";

/**
 * 本条链路是不是「SOCKS 隧道」
 *
 * @description
 * **唯一判据是连接器身份**（`connector.kind`，由 registry 构造期钉死），**不再从
 * `upstreamProtocol` 二次推导** —— 那正是连接器层要消灭的第二真相源。
 * 只用它决定两件事，二者都只影响**日志/报文形态**、不影响控制流：
 * - `upgradeOver` 的 `toUpstreamProxy` 必须为 false（SOCKS 隧道直达源站，用 origin-form
 *   且绝不能带上游凭证）
 * - 拨号失败日志的 `"via socks "` 尾巴
 *
 * 注意 `targetForm` **判不出这件事**：直连与 SOCKS 同为 `"origin"`（对端都是源站），
 * 区别只在「中间是否有一次 SOCKS 握手」。
 */
function isSocksTunnel(connector: UpstreamConnector): boolean {
  return connector.kind === "socks4" || connector.kind === "socks5";
}

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
 * - **单一路径**（与 http/tunnel/socks 同一形状）：「怎么到达 dest」一律经 `forward/connector/`
 *   的 `transport()`（直连回落直连、有效 client 经 http(s) 上游、经 SOCKS 隧道），本类不再直接拨号、
 *   **不再按 `upstreamProtocol` 分流**（Phase 2c 收掉 client 档的绕过，2d 收掉 socks 早分支）
 * - 事件一律经 `scope.emit` 发出（逐请求闭包，身份维度只在 `createRequestScope` 注一次）；
 *   `dialer` 只服务 {@link WsForwarder.relay} 的桥接
 * - 拒绝收尾统一写原始状态行报文（见 {@link WsForwarder.refuse}）：407/403 同款形态，
 *   不再「名单拒绝写 403、拨号失败静默 destroy」两套语义并存
 */
export class WsForwarder extends ForwarderBase {
  /**
   * @param ctx - 依赖上下文，必须显式注入
   * @description 逐请求的事件槽与终态守卫经 {@link WsForwarder.handle} 的 `scope` 参数传入，
   * **不进构造期**：本实例由 `HttpProxy` 在服务构造期建一次、跨请求复用。
   */
  constructor(ctx: CoreContext, traffic: TrafficAccount) {
    super(ctx, traffic);
  }

  /**
   * Upgrade 入口：**单一路径** —— 解析目标 + 路由判定 → 前置守卫 → 选连接器 → 经连接器取
   * 传输层 → 写 Upgrade 报文并等 101
   *
   * @description
   * 形状与 `http.handle` / `tunnel.handle` / `socks.connect` 一致：任何上游协议
   * （http/https/socks4/sockss4/socks5/sockss5）都只由 `resolveForwardTargets` 出的
   * **有效路由**决定，**本方法不再读 `proxyMode`、不再按 `upstreamProtocol` 分流**。
   * 此前那条「client + socks 上游」早分支（目标尚未解析就自行 `resolveRoute`）已删除，
   * 它带来的三处差异现在全部是连接器的声明式数据：`kind`（是否 SOCKS 隧道）、
   * `targetForm`（已在 `buildUpgradeReq` 内经 `toUpstreamProxy` 生效）、`peerTarget()`。
   * @param req 握手请求 @param socket 下游 @param head 已读半包
   * @param scope - 本次请求的作用域（事件出口 + 身份维度 + 终态守卫）：**逐次传入，绝不存字段**
   */
  handle(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    scope: RequestScope,
  ): void {
    const requestTerminal = scope.terminal;
    associateRequestTerminal(req, requestTerminal);

    // 拨号目标与客户端请求的目标成对解析（名单判 dest、拨号用 dial、route 判路由），见 resolveForwardTargets
    const targets = resolveForwardTargets(req.url, req.headers.host as string, this.config);

    if (!targets) {
      this.refuse(socket, STATUS_BAD_REQUEST);
      requestTerminal.reject("invalid-target", "parse", STATUS_BAD_REQUEST);
      return;
    }

    // 拒绝收尾（400 解析 / 403 名单 / 502 自环）三条守卫共用一个闭包：两条 preDial 完全同形
    const deny = (status: number): void => {
      this.refuse(socket, status);

      if (status === STATUS_BAD_REQUEST) {
        requestTerminal.reject("bad-request", "parse", status);
      } else if (status === STATUS_FORBIDDEN) {
        requestTerminal.reject("target-denied", "access", status);
      } else {
        requestTerminal.fail(new Error("proxy loop detected"), "dial");
      }
    };

    // ① 前置守卫：自环看**有效拨号地址**（client 模式即上游 → 上游自环由这一次判掉）、
    //    名单看客户端请求的目标，与 http/tunnel/socks 共用同一前置守卫
    if (this.preDial({ req, dial: targets.dial, dest: targets.dest, deny }, scope)) {
      return;
    }

    // preDial 已过：client 配置恰发一条路由事件（server 配置在 emitRoute 内短路）
    this.emitRoute(targets.dest, targets.route, scope);

    // 有效模式（client 配置 + 名单命中回落 server），后续分支一律用它、不再裸读 proxyMode
    const route = targets.route;

    // ② 选连接器（唯一写法）：`route.route === "direct"` ⟺ 该拨真实目标，
    //    命中 upstream 路由名单回落直连的请求**必须**走 directConnector（绝不碰 connectorFor）。
    //    未登记的上游协议由 registry fail-closed 抛错（server 层 catch 转 forward.error），
    //    绝不静默回落直连——静默直连是流量旁路。
    const connector =
      route.route === "direct"
        ? directConnector(this.ctx)
        : connectorFor(this.config.get("upstreamProtocol"), this.ctx);

    // ③ **传输对端 ≠ 有效拨号地址**才补判一次守卫 —— 这一步是**保住「真实目标自环」判定**：
    //    ①判的是 `targets.dial`（SOCKS 上游时即**上游**），而 SOCKS 隧道实际落到**真实目标**，
    //    于是「客户端请求代理自己的监听地址」这条自环在 ① 里根本没被看到。若只跑一次 ①，
    //    客户端就能让本代理经 SOCKS 隧道连回它自己的监听地址（成环）。
    //    两种判据并存（不是同一个东西抄两遍）：①判「有效拨号地址」（自环/名单的通用判据）、
    //    ③判「这条管道实际落到谁」（代理型即上游、直连/SOCKS 即 dest）。两者恒有一方是多余的，
    //    故按地址是否相同决定要不要补判，而不是无脑判两遍（无脑判两遍会多发一条名单事件）。
    //    与 `http.handle` 的同名模式逐字同源（那里同样靠它保住 SOCKS 档的真实目标自环）。
    const peer = connector.peerTarget(targets.dest);

    if (
      (peer.host !== targets.dial.host || peer.port !== targets.dial.port) &&
      this.preDial({ req, dial: peer, dest: targets.dest, deny }, scope)
    ) {
      return;
    }

    // ④ 单一路径：三类连接器的 `transport()` 都是「本通道要的那条链路」，随后由本通道
    //    写 Upgrade 握手报文并等 101（**绝不能**先发 CONNECT，见 transportVia 的说明）
    this.upgradeOver(
      req,
      socket,
      head,
      targets.dest,
      this.transportVia(connector, socket, targets.dest, scope),
      route.mode,
      // 只有 SOCKS 隧道才带 "via socks " 的失败日志尾巴、且必须用 origin-form 不带上游凭证
      isSocksTunnel(connector),
      scope,
    );
  }

  /**
   * 经连接器取一条可写字节的链路 → {@link upgradeOver} 期望的 `Promise<Duplex>`
   *
   * @description
   * **唯一调用点**（`handle` 的第 ④ 步）：「用哪个连接器」由 `resolveForwardTargets` 的
   * 有效路由决定，本方法**一个协议都不判**——直连回落（`directConnector`）、有效 client 经
   * http(s) 上游（`connectorFor` → `HttpConnectConnector`）、经 SOCKS 隧道（`connectorFor`
   * → SOCKS 连接器）三类都从这里取同一条链路。
   *
   * **守卫前缀恒为 `"upgrade"`**：三条路径的守卫 route 文本是**锁死的契约**
   * （`tests/integration/forwarder-connector-wiring.test.ts` 逐字断言
   * `[upgrade] error <clientAddr> -> <dest> [via …]`），故**不得**按连接器身份改前缀。
   * 「是否经 SOCKS 隧道」只影响**报文形态与失败文案**（{@link upgradeOver} 的
   * `viaSocksTunnel`），不影响守卫前缀。
   *
   * **刻意用 `transport()` 而不是 `open()`**（这是本通道与 tunnel/socks 的唯一语义差别）：
   * Upgrade 通道的「先发字节」是**本通道自己写的 Upgrade 握手报文**（对端要的是完整请求，
   * 不是裸字节流），故 http(s) 上游这一档**不能先发 CONNECT**——那会把上游代理的协议状态机
   * 带偏（它先回 200 再等 CONNECT，而本通道随即就等 101 → 死锁）。三类连接器的
   * `transport()` 恰好都是「要的那条链路」：直连与 SOCKS 的 `transport()` 就是
   * `open().sock`（**含** SOCKS 握手，直连没有握手可做），http/https 的只拨号到上游。
   *
   * 顺带因此**取不到也不需要** `OpenedUpstream` 的 `rest`/`refusal`：前者三个 `transport()`
   * 都不产余量（余量只在 CONNECT 应答头之后才有），后者只属 `open()` 的非 200 形态。
   *
   * @param connector - 目标连接器（要 `transport()`：传输层，不含 CONNECT 隧道）
   * @param client - 客户端双工流
   * @param dest - 拨号目标（= 有效模式为 server 时的真实目标；client 模式下是客户端请求的目标，
   *   只进守卫 route 文本的 `<dest>` 段，传输对端由连接器按 `upstreamHost`/`upstreamPort` 定）
   * @param scope - 本次请求的作用域（事件出口 + 身份维度）
   */
  private transportVia(
    connector: UpstreamConnector,
    client: Duplex,
    dest: TargetParts,
    scope: RequestScope,
  ): Promise<Duplex> {
    return connector.transport({
      client,
      dest,
      // 事件槽原样透传（身份已在 scope 闭包里注好）
      onEvent: scope.emit,
      logPrefix: "upgrade",
    });
  }

  /**
   * 拨号成功后接管 Upgrade：写握手报文（剔 proxy 头 + 重写 Host）→ 回灌已读半包 → 等 101 桥接；
   * 失败落盘并按成因写 504（超时）/502（其余）收尾（与 denyIfForbidden 时代的 403 同款写报文语义）
   * @param target - 客户端请求的目标（握手报文 Host 按它回写；直拨与 socks 上游即建链目标，
   *                 client 模式经 http/https 上游时它是上游的服务器上真正要访问的站点，与拨号地址不同）
   * @param upstreamDial - 上游拨号 Promise
   * @param mode - **有效模式**（调用方取自 resolveRoute；client 命中路由名单回落即 server），
   *   toUpstreamProxy 的唯一判据之一，不再裸读 proxyMode
   * @param viaSocksTunnel - 本条链路是否经 SOCKS 隧道（**由连接器身份 `kind` 推出**，见
   *   {@link isSocksTunnel}；影响 toUpstreamProxy 与失败日志文案）
   * @param scope - 本次请求的作用域（事件出口 + 身份维度 + 终态守卫）
   */
  private upgradeOver(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: TargetParts,
    upstreamDial: Promise<Duplex>,
    mode: "server" | "client",
    viaSocksTunnel: boolean,
    scope: RequestScope,
  ): void {
    const terminal = scope.terminal;

    upstreamDial
      .then((upstream) => {
        // 有效 client 经 http/https 上游：request-target 保留 absolute-form + 注入上游凭证；
        // server 直连（含路由名单命中回落）与经 SOCKS 隧道已直达真实目标，用 origin-form 且不带上游凭证
        const toUpstreamProxy = mode === "client" && !viaSocksTunnel;

        upstream.write(
          buildUpgradeReq(req, target.host, target.port, target.path, toUpstreamProxy, this.config),
        );

        // **计量**：Upgrade 握手请求与 101 应答都是协议字节（由本通道自己 write 出去，不经
        // `data` 事件，天然不计量）；`head`（客户端握手头之后的首包）是**真实载荷**、必须计入。
        // 计量器在握手报文写完之后才开：那时两条流已是「建链完成后流动的真实字节」。
        const meter = this.openTunnelMeter(socket, upstream, scope);
        if (head.length) {
          meter.charge("up", head.length);
          upstream.write(head);
        }

        void this.relay(socket, upstream, `${target.host}:${target.port}`, meter, scope);
      })
      .catch((err: Error) => {
        // 拨号失败成因必须落盘（守卫 keepClientOnFailure 留了客户端），随后按成因写状态行收尾
        scope.emit({
          type: "upstream-error",
          message: `[upgrade] upstream error ${viaSocksTunnel ? "via socks " : ""}${target.host}:${target.port}: ${err.message}`,
          err,
        });
        this.refuseByCause(socket, err);
        terminal.fail(err, "dial");
      });
  }

  /**
   * 等 101 桥接：严格解析状态行判 101；非 101 原样回透响应后按上游 EOF 语义收尾
   * - 状态行用 RE_HTTP_STATUS_LINE 提取三位码严格比对，避免 `302` + `Content-Length: 1010`
   *   之类子串被 `includes("101")` 误判为升级成功
   * - 等待收口在 `awaitStatusLine`：定时器归其所有（缺省 upstreamTimeout），上游失败时由它销毁，
   *   超时/超限成因经 upstream-error 上抛，客户端按成因写 504/502 收尾（不再静默双毁）
   * - 非 101 不再截断：首包（`head` + `rest`）写完后继续把上游剩余 body relay 给客户端，
   *   否则 `Content-Length` 大于首包时客户端挂等；上游错误/关闭的收尾归 `guardDialing` 既有 handler
   *
   * **计量**：`101 Switching Protocols` 应答头是协议字节、由本通道 write 出去，**不计量**；
   * 应答头之后的 `res.rest`（建隧后的首批载荷）计 `down`，经 `bridgeWithBuffered` 补记。
   * 非 101 分支**不计量**（没有建隧成功，这次转发没有可归属的隧道）。
   * @param addr - 目标地址（失败日志路由）
   * @param meter - 计量端口（由 `upgradeOver` 在握手报文写完后开出）
   * @param scope - 本次请求的作用域（事件出口 + 身份维度 + 终态守卫）
   */
  private async relay(
    client: Duplex,
    upstream: Duplex,
    addr: string,
    meter: BufferedCharge,
    scope: RequestScope,
  ): Promise<void> {
    const terminal = scope.terminal;
    const res = await awaitStatusLine(upstream, {
      timeout: this.config.get("upstreamTimeout") as number,
      onTimeout: () => {
        scope.emit({
          type: "upstream-error",
          message: `[upgrade] upstream response timeout ${addr}`,
        });
      },
      onOverflow: () => {
        scope.emit({
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
      terminal.complete(101);

      // `res.head` 是 101 应答（协议字节，不计量）；`res.rest` 是应答之后的真实载荷，计 `down`。
      // 两者都写出去再桥接：桥接经基类 `bridgeWithBuffered`，余量的计量与写入收在一处
      // （终态仍先于桥接发布，与改造前逐字一致）。
      this.bridgeWithBuffered(client, upstream, meter, undefined, res.rest);
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
