import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import type { ConfigAccessor } from "@/config/index.js";
import { upstreamTlsOptions } from "@/utils/tls/index.js";
import {
  absoluteFormAuthority,
  formatAuthority,
  isSocksProto,
  resolveForwardTargets,
  sanitizeHeaders,
  socksVersionOf,
  upstreamAuthValue,
  type TargetParts,
} from "@/core/helpers/index.js";
import { socksUpstreamGuard } from "@/core/guard.js";
import {
  HEADER_NAME_CONNECTION,
  HEADER_NAME_HOST_LOWER,
  HEADER_VALUE_CLOSE,
  REASON_BAD_GATEWAY,
  REASON_BAD_REQUEST,
  REASON_FORBIDDEN,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
} from "@/utils/constants/index.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import {
  RequestTerminal,
  associateRequestTerminal,
  requestTerminalFor,
} from "@/core/request-terminal.js";
import { ForwarderBase } from "./base.js";

/**
 * failEarly 状态码 → 响应正文：正文由状态码派生，杜绝「400 状态行 + 502 正文」错配。
 * 注意值是纯正文（REASON_*），不是预拼报文（HTTP_*）——res.writeHead 已发状态行，
 * 再 end 整份报文会把状态行重复写进 body。
 */
const EARLY_FAIL_BODY: Record<number, string> = {
  [STATUS_BAD_REQUEST]: REASON_BAD_REQUEST,
  [STATUS_FORBIDDEN]: REASON_FORBIDDEN,
  [STATUS_BAD_GATEWAY]: REASON_BAD_GATEWAY,
};

/**
 * HTTP 转发器
 * - server 模式（含 client 配置命中 upstream 路由名单的回落）：解析 req.url/host 直连目标
 * - client 模式（有效）：按 upstreamProtocol 选
 *   http/https/socks 串联上游，自动注入 Proxy-Authorization
 * - 分支判据一律是 `resolveRoute` 的有效模式，不裸读 `proxyMode`
 * - 拨号器与事件槽（dialer/emit）继承自 {@link ForwarderBase}
 */
export class HttpForwarder extends ForwarderBase {
  /**
   * 入口：按路由判定（有效模式）与 upstreamProtocol 分发
   * 任意协议的 client 都可转发到任意上游：
   * http/https 走 http(s).request，socks 走 SOCKS 隧道；
   * client 配置但 upstream 路由名单命中 → 有效模式回落 server（dial 即真实目标，直连）
   */
  handle(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    terminal?: RequestTerminal,
  ): void {
    const requestTerminal = terminal ?? requestTerminalFor(clientReq) ?? new RequestTerminal();
    associateRequestTerminal(clientReq, requestTerminal);
    // client 串联时：拨号目标即上游（path 留原始 req.url，串联给上游代理必须 absolute-form）；
    // server 直连 / client 命中路由名单直连时：dial 即真实目标（path 已归一为 origin-form）；
    // 成对解析 + 路由判定收敛在 resolveForwardTargets
    const targets = resolveForwardTargets(
      clientReq.url,
      clientReq.headers.host as string,
      this.config,
    );

    if (!targets) {
      // 请求终态只由 RequestTerminal 发布（唯一的 request.rejected(stage=parse)/400）；
      // 下面的 pipe 事件只服务日志面（[target-unresolved] warn），不再被桥接成第二条公共拒绝。
      requestTerminal.reject("target-unresolved", "parse", STATUS_BAD_REQUEST);
      this.emit({ type: "target-unresolved", url: clientReq.url, req: clientReq });
      this.failEarly(clientRes, STATUS_BAD_REQUEST);
      return;
    }

    // 自环看有效拨号地址（名单命中直连时即真实目标），名单看客户端请求的目标——
    // 语义与事件/拒绝收尾收敛在基类 preDial（内部走 guardPreDial，见其 JSDoc）
    if (
      this.preDial({
        req: clientReq,
        dial: targets.dial,
        dest: targets.dest,
        deny: (status) => this.failEarlyWithTerminal(clientRes, requestTerminal, status),
      })
    ) {
      return;
    }

    // preDial 已过：client 配置的请求每请求恰发一条路由事件（server 配置在 emitRoute 内短路）
    this.emitRoute(targets.dest, targets.route);

    // 有效模式（client 配置 + 名单命中回落 server），后续分支一律用它、不再裸读 proxyMode
    const mode = targets.route.mode;
    const proto = mode === "client" ? this.config.get("upstreamProtocol") : "http";

    // https 上游走 https.request（TLS 承载）；SOCKS 系（socks4/5/sockss4/sockss5）一律走 SOCKS 隧道
    // （dialSocks 按 upstreamProtocol 自行推导 version 与 TLS 承载，见 Dialer.dialSocks）
    if (proto === "https") {
      this.forwardViaRequest(clientReq, clientRes, targets.dial, true, mode, requestTerminal);
      return;
    }

    if (isSocksProto(proto)) {
      this.forwardViaSocks(clientReq, clientRes, targets.dest, requestTerminal);
      return;
    }

    this.forwardViaRequest(clientReq, clientRes, targets.dial, false, mode, requestTerminal);
  }

  /**
   * 出站请求转发（http 直连与 https 上游共用）：差异仅在请求器与 TLS 三选项
   * - server 直连必须先归一：客户端以 absolute-form 请求本代理时 req.url 是整串 URL，
   *   原样交给 request 会把 `GET http://host/path` 写进请求行，源站收到畸形 request-target；
   *   client 串联保留客户端原始形态（上游代理需要 absolute-form）
   * - RFC 7230 §5.4：absolute-form 必须忽略客户端 Host，按 request-target 的权威值回写
   *   （虚拟主机/ACL/缓存键混淆）
   * - 仅显式配 upstreamUsername 才注入上游凭证：防 client 头透传泄漏
   * @param secure - true 经 https.request（TLS 承载，证书校验锚定建链目标），false 经 http.request
   * @param mode - **有效模式**（调用方取自 `resolveRoute`，client 命中回落即 server），三处分支的唯一判据
   */
  private forwardViaRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: TargetParts,
    secure: boolean,
    mode: "server" | "client",
    terminal: RequestTerminal,
  ): void {
    const headers: Record<string, string | string[] | undefined> = sanitizeHeaders(
      req.headers as never,
      this.config,
    );

    // 仅显式配 upstreamUsername 才注入：防 client 头透传泄漏
    if (mode === "client") {
      const auth = upstreamAuthValue(this.config);

      if (auth) {
        (headers as Record<string, unknown>)["proxy-authorization"] = auth;
      }
    }

    // RFC 7230 §5.4：absolute-form 必须忽略客户端 Host，按 request-target 的权威值回写，
    // 否则源站会收到与建链目标不一致的 Host（虚拟主机/ACL/缓存键混淆）
    if (mode !== "client") {
      const authority = absoluteFormAuthority(req.url ?? "");

      if (authority) {
        (headers as Record<string, unknown>)[HEADER_NAME_HOST_LOWER] = authority;
      }
    }

    // 与上游分流同规则：server 直连用解析后的 origin-form，client 串联保留客户端原始形态
    const path = mode === "client" ? req.url! : target.path;

    const opts: https.RequestOptions = {
      host: target.host,
      port: target.port,
      method: req.method,
      path,
      headers: headers as never,
      timeout: this.config.get("upstreamTimeout"),
      // TLS 专属选项只在 https 分支注入（servername/rejectUnauthorized/ca 三选项
      // 收敛在 upstreamTlsOptions：证书校验锚定建链目标，IP 按 RFC6066 置空 SNI）
      ...(secure ? upstreamTlsOptions(target.host, this.config) : {}),
    };

    const onResponse = (upRes: http.IncomingMessage): void => {
      this.observeResponseTerminal(res, upRes, terminal);
      // 无状态行归属 502：上游未给有效响应即网关无应答
      if (upRes.statusCode === undefined) {
        terminal.fail(new Error("upstream response has no status"), "forward");
      }
      res.writeHead(upRes.statusCode ?? STATUS_BAD_GATEWAY, upRes.headers);
      upRes.pipe(res);
    };

    const proxy = secure ? https.request(opts, onResponse) : http.request(opts, onResponse);

    this.wireClientToUpstream(req, res, proxy, terminal, {
      errorLabel: `[http] upstream error ${target.host}:${target.port}`,
    });
  }

  /**
   * 上游请求收尾统一下挂：error / timeout / 客户端中断 / 请求体泵送
   * - error：上报 upstream-error（含成因）后回 502 —— 此前静默 502，TLS 校验失败与连接拒绝无法区分
   * - timeout：只 destroy，具体 502 由 error 兜底统一回
   * - 客户端中断：销毁上游请求避免悬挂至超时；经隧道转发时一并销毁隧道
   * @param opts.errorLabel - 上游失败日志前缀（直连与经 socks 两条路径文案不同）
   * @param opts.tunnel - 经 SOCKS 隧道时的隧道 socket，客户端中断需一并销毁
   */
  private wireClientToUpstream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    proxy: http.ClientRequest,
    terminal: RequestTerminal,
    opts: { errorLabel: string; tunnel?: Duplex },
  ): void {
    proxy.on("error", (err: Error) => {
      this.emit({
        type: "upstream-error",
        message: `${opts.errorLabel}: ${err.message}`,
        err,
      });
      this.fail(res);
      terminal.fail(err, "forward");
    });

    // timeout 只 destroy：具体 502 由 error 兜底统一回
    proxy.on("timeout", () => {
      terminal.fail(new Error("upstream request timeout"), "forward");
      proxy.destroy();
    });

    // 客户端中断：销毁上游请求，避免悬挂至超时
    res.on("close", () => {
      if (!res.writableEnded) {
        proxy.destroy();

        if (opts.tunnel && !opts.tunnel.destroyed) {
          opts.tunnel.destroy();
        }
        terminal.fail(new Error("client response closed before completion"), "forward");
      }
    });

    req.pipe(proxy);
  }

  /**
   * SOCKS 上游：先经 Dialer 建 SOCKS 隧道，再在隧道上用 http.request 发请求
   * 满足“任意 client → 任意上游”：
   * http 服务的 client 也可走 socks 上游
   * @param dest - 客户端请求的真实目标（handle 已解析；socks 上游需知道它而非 upstreamHost）
   */
  private forwardViaSocks(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    dest: TargetParts,
    terminal: RequestTerminal,
  ): void {
    // handle 已按拨号地址（上游）查过自环，这里补判真实目标的自环——client 模式下两者不同值
    if (
      this.preDial({
        req,
        dial: dest,
        dest,
        deny: (status) => this.failEarlyWithTerminal(res, terminal, status),
      })
    ) {
      return;
    }

    this.dialViaSocksAndForward(req, res, dest, terminal).catch((err: Error) => {
      // 拨号失败成因必须落盘：此前该路径只回 502，TLS 校验失败/拒绝连接在日志里无痕
      this.emit({
        type: "upstream-error",
        message: `[http] upstream error via socks ${dest.host}:${dest.port}: ${err.message}`,
        err,
      });
      this.fail(res);
      terminal.fail(err, "dial");
    });
  }

  /**
   * 经 SOCKS 隧道发 HTTP：隧道直达真实目标后，用 http.request 复用隧道 socket 作为传输层
   * 让 Node 负责请求体分帧（chunked / Content-Length）、Expect/1xx、响应解析与头透传；
   * 保留 sanitizeHeaders（含强制 Connection: close）与 Host 重写为真实目标
   * @param target 真实目标（非 upstreamHost），path 来自 parseTargetParts 已归一；异常由调用方统一转 502
   */
  private async dialViaSocksAndForward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: { host: string; port: number; path: string },
    terminal: RequestTerminal,
  ): Promise<void> {
    // 经 upstreamHost:upstreamPort 建到真实目标的隧道（版本由共享映射推导）
    const version = socksVersionOf(this.config.get("upstreamProtocol"));

    // 拨号失败统一交由调用方 catch 回 res：守卫经 socksUpstreamGuard 收口（空回复 + 保客户端，
    // 守卫内不写裸 HTTP），成因经 onEvent 上抛到日志，502 才发得出去
    const tunnel = await this.dialer.dialSocks(
      req.socket as unknown as Duplex,
      target.host,
      target.port,
      version,
      undefined,
      socksUpstreamGuard("http", (e) => this.emit(e)),
    );

    const headers = sanitizeHeaders(req.headers as never, this.config);

    // socks 隧道直达源站（非上游代理）：重写 Host 对齐目标（IPv6 经 formatAuthority 补回方括号，
    // 避免 `::1:80` 畸形 authority）；强制 close 让源站关连接
    headers[HEADER_NAME_HOST_LOWER] = formatAuthority(target.host, target.port);
    headers[HEADER_NAME_CONNECTION] = HEADER_VALUE_CLOSE;

    // 复用已建隧道：不传 agent，由 createConnection 返回隧道 socket 作为连接，
    // 请求行用解析后的 origin-form（target.path 已归一），Host 由 headers 指定
    const proxy = http.request(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: target.path,
        headers: headers as never,
        timeout: this.config.get("upstreamTimeout"),
        createConnection: () => tunnel,
      },
      (upRes) => {
        this.observeResponseTerminal(res, upRes, terminal);
        if (upRes.statusCode === undefined) {
          terminal.fail(new Error("upstream response has no status"), "forward");
        }
        res.writeHead(upRes.statusCode ?? STATUS_BAD_GATEWAY, upRes.headers);
        upRes.pipe(res);
      },
    );

    this.wireClientToUpstream(req, res, proxy, terminal, {
      errorLabel: `[http] upstream error via socks ${target.host}:${target.port}`,
      tunnel,
    });
  }

  /**
   * 观察响应的真实结束点：headers 到达不等于请求完成，只有 response finish 才发 completed。
   * 上游源流错误/客户端提前 close 只补 failed，guard 会与 finish/error 竞态收口。
   */
  private observeResponseTerminal(
    res: http.ServerResponse,
    upstream: http.IncomingMessage,
    terminal: RequestTerminal,
  ): void {
    res.once("finish", () => {
      terminal.complete(res.statusCode);
    });
    res.once("close", () => {
      if (!res.writableEnded) {
        terminal.fail(new Error("client response closed before completion"), "forward");
      }
    });
    upstream.once("error", (error: Error) => {
      terminal.fail(error, "forward");
    });
  }

  /**
   * 早失败回写后发布对应终态：名单是 access rejection，自环是网关失败。
   * 状态码与 body 仍完全由既有 failEarly 决定。
   */
  private failEarlyWithTerminal(
    res: http.ServerResponse,
    terminal: RequestTerminal,
    status: number,
  ): void {
    this.failEarly(res, status);
    if (status === STATUS_FORBIDDEN) {
      terminal.reject("target-denied", "access", status);
      return;
    }
    if (status === STATUS_BAD_REQUEST) {
      terminal.reject("bad-request", "parse", status);
      return;
    }
    terminal.fail(new Error("proxy loop detected"), "dial");
  }

  /**
   * 转发前的早失败回写：目标解析失败（400）、名单拒绝（403）与自环（502）共用
   * @param status - 状态码（STATUS_BAD_REQUEST / STATUS_FORBIDDEN / STATUS_BAD_GATEWAY）
   */
  private failEarly(res: http.ServerResponse, status: number): void {
    if (!res.headersSent) {
      res.writeHead(status);
    }

    res.end(EARLY_FAIL_BODY[status] ?? REASON_BAD_REQUEST);
  }

  /**
   * 网关错误回写：响应未开始时回 502；已开始流式或已销毁则只销毁连接
   * - 避免把 502 文本追加进已流式的 body（协议污染）
   */
  private fail(res: http.ServerResponse): void {
    if (res.headersSent || res.destroyed || res.writableEnded) {
      res.destroy();
      return;
    }

    res.writeHead(STATUS_BAD_GATEWAY);
    res.end(REASON_BAD_GATEWAY);
  }
}

export function forwardHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ConfigAccessor,
  sink?: PipeEventSink,
  terminal?: RequestTerminal,
): void {
  new HttpForwarder(sink, config).handle(req, res, terminal);
}
