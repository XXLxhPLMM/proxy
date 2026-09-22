import http from "node:http";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import {
  isStrippableOutboundHeader,
  isSocksProto,
  isTlsUpstreamProto,
  parseTargetParts,
  resolveForwardTargets,
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
  STATUS_GATEWAY_TIMEOUT,
  STATUS_SWITCHING_PROTOCOLS,
} from "@/utils/constants.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import { ForwarderBase } from "./base.js";

/**
 * 构建 Upgrade 请求（剔除 proxy-* 头，重写 Host）
 * @param req - 原始 Upgrade 请求
 * @param host - 握手 Host 回写主机（客户端请求的目标）
 * @param port - 握手 Host 回写端口
 * @param path - origin-form 请求目标（server 直连与经 SOCKS 隧道时使用）
 * @param toUpstreamProxy - 是否发给 client 模式的 http/https 上游代理：
 *   true 时 request-target 保留客户端的 absolute-form——上游代理收到 origin-form 的
 *   `GET /ws` 会当成「发给代理自身的请求」而不会转发升级；并注入 Proxy-Authorization
 *   （上游凭证，仅显式配 upstreamUsername 时携带）。经 SOCKS 隧道已直达真实目标，
 *   必须用 origin-form 且绝不能带上游凭证
 */
function buildUpgradeReq(
  req: http.IncomingMessage,
  host: string,
  port: number,
  path: string,
  toUpstreamProxy: boolean,
): string {
  const target = toUpstreamProxy ? (req.url ?? path) : path;
  const requestLine = `${req.method} ${target} HTTP/${req.httpVersion}${CRLF}`;

  const headerLines: string[] = [];

  const raw = req.rawHeaders ?? [];

  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];

    // 出站净化与 sanitizeHeaders 同谓词：任意 proxy- 前缀 + 命中代理凭证的 authorization
    if (isStrippableOutboundHeader(name, value)) {
      continue;
    }

    if (name.toLowerCase() === HEADER_NAME_HOST_LOWER) {
      headerLines.push(`${HEADER_NAME_HOST_TITLE}: ${host}:${port}`);
    } else {
      headerLines.push(`${name}: ${value}`);
    }
  }

  // 仅向 http/https 上游代理注入（与 forwardViaRequest 同规则）：socks 隧道/直连直达真实目标，不得携带
  if (toUpstreamProxy) {
    const auth = upstreamAuthValue();

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
   * Upgrade 入口：client+socks 上游分流走隧道，其余直拨目标等 101
   * @param req 握手请求 @param socket 下游 @param head 已读半包
   */
  handle(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const mode = get("proxyMode");
    const proto = get("upstreamProtocol");

    // socks 上游需真实目标建隧道，而非 upstreamHost（自环/名单判定在 viaSocks 内做）
    if (mode === "client" && isSocksProto(proto)) {
      this.viaSocks(req, socket, head, proto);
      return;
    }

    // 拨号目标与客户端请求的目标成对解析（名单判 dest、拨号用 dial），见 resolveForwardTargets
    const targets = resolveForwardTargets(mode, req.url, req.headers.host as string);

    if (!targets) {
      this.refuse(socket, STATUS_BAD_REQUEST);
      return;
    }

    // 自环看拨号地址、名单看客户端请求的目标，与 http/tunnel/socks 共用同一前置守卫
    if (
      this.preDial({
        req,
        dial: targets.dial,
        dest: targets.dest,
        deny: (status) => this.refuse(socket, status),
      })
    ) {
      return;
    }

    // secure 映射：https 与 sockss* 走 TLS，其余明文（isTlsUpstreamProto 唯一判据）
    const secure = mode === "client" && isTlsUpstreamProto(proto);

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
      false,
    );
  }

  /**
   * 拨号成功后接管 Upgrade：写握手报文（剔 proxy 头 + 重写 Host）→ 回灌已读半包 → 等 101 桥接；
   * 失败落盘并按成因写 504（超时）/502（其余）收尾（与 denyIfForbidden 时代的 403 同款写报文语义）
   * @param target - 客户端请求的目标（握手报文 Host 按它回写；直拨与 socks 上游即建链目标，
   *                 client 模式经 http/https 上游时它是上游的服务器上真正要访问的站点，与拨号地址不同）
   * @param upstreamDial - 上游拨号 Promise
   * @param viaSocks - 是否经 SOCKS 隧道（仅影响失败日志文案）
   */
  private upgradeOver(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: TargetParts,
    upstreamDial: Promise<Duplex>,
    viaSocks: boolean,
  ): void {
    upstreamDial
      .then((upstream) => {
        // client 模式经 http/https 上游：request-target 保留 absolute-form + 注入上游凭证；
        // server 直连与经 SOCKS 隧道已直达真实目标，用 origin-form 且不带上游凭证
        const toUpstreamProxy = get("proxyMode") === "client" && !viaSocks;

        upstream.write(buildUpgradeReq(req, target.host, target.port, target.path, toUpstreamProxy));

        if (head.length) {
          upstream.write(head);
        }

        void this.relay(socket, upstream, `${target.host}:${target.port}`);
      })
      .catch((err: Error) => {
        // 拨号失败成因必须落盘（守卫 keepClientOnFailure 留了客户端），随后按成因写状态行收尾
        this.emit({
          type: "upstream-error",
          message: `[upgrade] upstream error ${viaSocks ? "via socks " : ""}${target.host}:${target.port}: ${err.message}`,
          err,
        });
        this.refuseByCause(socket, err);
      });
  }

  /**
   * 经 SOCKS 隧道发 Upgrade：隧道直达真实目标后走同 dial 流程
   */
  private viaSocks(req: http.IncomingMessage, socket: Duplex, head: Buffer, proto: string): void {
    const real = parseTargetParts(req.url ?? "", req.headers.host as string);

    if (!real) {
      this.refuse(socket, STATUS_BAD_REQUEST);
      return;
    }

    // 真实目标的自环/名单判定与其余三个转发器共用前置守卫（socks 隧道拨的是上游，另在下方判上游自环）
    if (
      this.preDial({
        req,
        dial: real,
        dest: real,
        deny: (status) => this.refuse(socket, status),
      })
    ) {
      return;
    }

    // 上游自环：socks 隧道拨的是上游，上游指回自身监听地址会成环（真实目标的自环已在上方判过；名单不判上游）
    if (
      this.denyUpstreamLoopAuto(() => this.refuse(socket, STATUS_BAD_GATEWAY), { req })
    ) {
      return;
    }

    this.upgradeOver(
      req,
      socket,
      head,
      real,
      this.dialer.dialSocks(socket, real.host, real.port, socksVersionOf(proto), undefined,
        // 守卫不写报文、保客户端：成败应答归 upgradeOver 的 catch（超时 504、错误 502）
        socksUpstreamGuard("upgrade", (e) => this.emit(e))),
      true,
    );
  }

  /**
   * 等 101 桥接：严格解析状态行判 101，非 101 原样回源后双关
   * - 状态行用 RE_HTTP_STATUS_LINE 提取三位码严格比对，避免 `302` + `Content-Length: 1010`
   *   之类子串被 `includes("101")` 误判为升级成功
   * - 等待收口在 `awaitStatusLine`：定时器归其所有（缺省 upstreamTimeout），上游失败时由它销毁，
   *   超时/超限成因经 upstream-error 上抛，客户端按成因写 504/502 收尾（不再静默双毁）
   * @param addr - 目标地址（失败日志路由）
   */
  private async relay(client: Duplex, upstream: Duplex, addr: string): Promise<void> {
    const res = await awaitStatusLine(upstream, {
      timeout: get("upstreamTimeout") as number,
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
      this.refuse(client, res.cause === "timeout" ? STATUS_GATEWAY_TIMEOUT : STATUS_BAD_GATEWAY);
      return;
    }

    // 严格取状态码：仅 101 视为升级成功，杜绝 `302` + `Content-Length: 1010` 之类子串误判
    if (res.statusCode === String(STATUS_SWITCHING_PROTOCOLS)) {
      client.write(res.head);

      if (res.rest.length) {
        client.write(res.rest);
      }

      this.dialer.bridge(client, upstream);
    } else {
      client.write(Buffer.concat([res.head, res.rest]));
      upstream.destroy();
      client.destroy();
    }
  }
}

export function forwardUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  sink?: PipeEventSink,
): void {
  new WsForwarder(sink).handle(req, socket, head);
}
