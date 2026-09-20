import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { checkTargetHost } from "@/config/acl.js";
import { readUpstreamCa } from "@/utils/cert.js";
import {
  absoluteFormAuthority,
  createEventEmitter,
  isSelfLoop,
  sanitizeHeaders,
  parseTargetParts,
  upstreamAuthValue,
  type TargetParts,
} from "@/core/proxy-helpers.js";
import {
  HEADER_NAME_CONNECTION,
  HEADER_NAME_HOST_LOWER,
  HEADER_VALUE_CLOSE,
  HTTP_502_BAD_GATEWAY,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
} from "@/utils/constants.js";
import type { PipeEvent, PipeEventSink } from "@/core/types/proxy.js";
import { Dialer } from "./dial.js";

/**
 * HTTP 转发器
 * - server 模式：解析 req.url/host 直连目标
 * - client 模式：按 upstreamProtocol 选
 *   http/https/socks 串联上游，自动注入 Proxy-Authorization
 */
export class HttpForwarder {
  private dialer = new Dialer();

  private readonly emit: (e: PipeEvent) => void;

  constructor(private sink?: PipeEventSink) {
    this.emit = createEventEmitter<PipeEvent>(sink);
  }

  /**
   * 入口：根据 proxyMode 与 upstreamProtocol 分发
   * 任意协议的 client 都可转发到任意上游：
   * http/https 走 http(s).request，socks 走 SOCKS 隧道
   */
  handle(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
    const mode = get("proxyMode");

    // client 串联时：目标即上游（path 留原始 req.url，串联给上游代理必须 absolute-form）；
    // server 直连时：从绝对 URL / Host 解析真实目标（path 已归一为 origin-form）
    const target =
      mode === "client"
        ? {
            host: get("upstreamHost"),
            port: get("upstreamPort"),
            path: clientReq.url ?? "/",
          }
        : parseTargetParts(clientReq.url ?? "", clientReq.headers.host as string);

    if (!target) {
      this.emit({ type: "target-unresolved", url: clientReq.url });
      this.failEarly(clientRes, STATUS_BAD_REQUEST);
      return;
    }

    // 目标名单判定的永远是「客户端请求的目标」：client 模式下 target 是上游，其协议/地址/端口
    // 由 UPSTREAM_* 指定，**不受名单约束**；客户端真正要访问的站点在 request-target 的
    // authority（absolute-form）或 Host 里。server 模式下两者本就是同一个值。
    const dest =
      mode === "client"
        ? parseTargetParts(clientReq.url ?? "", clientReq.headers.host as string)
        : target;

    if (!dest) {
      this.emit({ type: "target-unresolved", url: clientReq.url });
      this.failEarly(clientRes, STATUS_BAD_REQUEST);
      return;
    }

    // 自环防护：避免代理连向自身导致死循环（看的是拨号地址：client 模式即上游）
    if (isSelfLoop(target.host, target.port)) {
      this.emit({
        type: "loop-detected",
        req: clientReq,
        target: `${target.host}:${target.port}`,
      });
      this.failEarly(clientRes, STATUS_BAD_GATEWAY);
      return;
    }

    // 目标名单：紧邻自环守卫，在拨号之前判定（被禁目标不消耗上游资源）
    const acl = checkTargetHost(dest.host);
    if (!acl.allowed) {
      this.emit({
        type: "target-denied",
        target: `${dest.host}:${dest.port}`,
        host: dest.host,
        reason: acl.reason,
        req: clientReq,
      });
      this.failEarly(clientRes, STATUS_FORBIDDEN);
      return;
    }

    const proto = mode === "client" ? get("upstreamProtocol") : "http";

    // https 上游走 https.request（TLS 承载）；socks4/socks5/sockss4/sockss5 一律走 SOCKS 隧道
    // （dialSocks 按 upstreamProtocol 自行推导 version 与 TLS 承载，见 Dialer.dialSocks）
    if (proto === "https") {
      this.forwardViaRequest(clientReq, clientRes, target, true);
      return;
    }

    if (
      proto === "socks4" ||
      proto === "socks5" ||
      proto === "sockss4" ||
      proto === "sockss5"
    ) {
      this.forwardViaSocks(clientReq, clientRes);
      return;
    }

    this.forwardViaRequest(clientReq, clientRes, target, false);
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
   */
  private forwardViaRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: TargetParts,
    secure: boolean,
  ): void {
    const headers: Record<string, string | string[] | undefined> = sanitizeHeaders(
      req.headers as never,
    );

    // 仅显式配 upstreamUsername 才注入：防 client 头透传泄漏
    if (get("proxyMode") === "client") {
      const auth = upstreamAuthValue();

      if (auth) {
        (headers as Record<string, unknown>)["proxy-authorization"] = auth;
      }
    }

    // RFC 7230 §5.4：absolute-form 必须忽略客户端 Host，按 request-target 的权威值回写，
    // 否则源站会收到与建链目标不一致的 Host（虚拟主机/ACL/缓存键混淆）
    if (get("proxyMode") !== "client") {
      const authority = absoluteFormAuthority(req.url ?? "");

      if (authority) {
        (headers as Record<string, unknown>)[HEADER_NAME_HOST_LOWER] = authority;
      }
    }

    // 与上游分流同规则：server 直连用解析后的 origin-form，client 串联保留客户端原始形态
    const path = get("proxyMode") === "client" ? req.url! : target.path;

    const opts: https.RequestOptions = {
      host: target.host,
      port: target.port,
      method: req.method,
      path,
      headers: headers as never,
      timeout: get("upstreamTimeout"),
      // TLS 专属选项只在 https 分支注入：
      // 证书校验必须锚定建链目标，而非转发的 Host 头（Host 是源站名）
      // IP 按 RFC6066 置空 servername（跳过 SNI，按连接 host 校验 SAN-IP）
      ...(secure
        ? {
            servername: net.isIP(target.host) ? "" : target.host,
            rejectUnauthorized: !get("upstreamInsecure"),
            ca: readUpstreamCa(),
          }
        : {}),
    };

    const onResponse = (upRes: http.IncomingMessage): void => {
      // 无状态行归属 502：上游未给有效响应即网关无应答
      res.writeHead(upRes.statusCode ?? STATUS_BAD_GATEWAY, upRes.headers);
      upRes.pipe(res);
    };

    const proxy = secure ? https.request(opts, onResponse) : http.request(opts, onResponse);

    this.wireClientToUpstream(req, res, proxy, {
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
    opts: { errorLabel: string; tunnel?: Duplex },
  ): void {
    proxy.on("error", (err: Error) => {
      this.emit({
        type: "upstream-error",
        message: `${opts.errorLabel}: ${err.message}`,
        err,
      });
      this.fail(res);
    });

    // timeout 只 destroy：具体 502 由 error 兜底统一回
    proxy.on("timeout", () => {
      proxy.destroy();
    });

    // 客户端中断：销毁上游请求，避免悬挂至超时
    res.on("close", () => {
      if (!res.writableEnded) {
        proxy.destroy();

        if (opts.tunnel && !opts.tunnel.destroyed) {
          opts.tunnel.destroy();
        }
      }
    });

    req.pipe(proxy);
  }

  /**
   * SOCKS 上游：先经 Dialer 建 SOCKS 隧道，再在隧道上用 http.request 发请求
   * 满足“任意 client → 任意上游”：
   * http 服务的 client 也可走 socks 上游
   */
  private forwardViaSocks(req: http.IncomingMessage, res: http.ServerResponse): void {
    // socks 上游需知道真实目标（而非 upstreamHost），从 req 重新解析
    const real = parseTargetParts(req.url ?? "", req.headers.host as string);

    if (!real) {
      this.failEarly(res, STATUS_BAD_REQUEST);
      return;
    }

    // 真实目标已重解析，需二次自环校验
    if (isSelfLoop(real.host, real.port)) {
      this.failEarly(res, STATUS_BAD_GATEWAY);
      return;
    }

    this.dialViaSocksAndForward(req, res, real).catch((err: Error) => {
      // 拨号失败成因必须落盘：此前该路径只回 502，TLS 校验失败/拒绝连接在日志里无痕
      this.emit({
        type: "upstream-error",
        message: `[http] upstream error via socks ${real.host}:${real.port}: ${err.message}`,
        err,
      });
      this.fail(res);
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
  ): Promise<void> {
    // 经 upstreamHost:upstreamPort 建到真实目标的隧道
    const proto = get("upstreamProtocol");
    const version: 4 | 5 = proto === "socks4" || proto === "sockss4" ? 4 : 5;

    // 拨号失败统一交由调用方 catch 回 res：守卫内不写裸 HTTP（空 reply），
    // 且 keepClientOnFailure 保证客户端不被连带销毁，502 才发得出去
    const tunnel = await this.dialer.dialSocks(
      req.socket as unknown as Duplex,
      target.host,
      target.port,
      version,
      undefined,
      { timeoutReply: "", errorReply: "", keepClientOnFailure: true },
    );

    const headers = sanitizeHeaders(req.headers as never);

    // socks 隧道直达源站（非上游代理）：重写 Host 对齐目标；强制 close 让源站关连接
    headers[HEADER_NAME_HOST_LOWER] = `${target.host}:${target.port}`;
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
        timeout: get("upstreamTimeout"),
        createConnection: () => tunnel,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? STATUS_BAD_GATEWAY, upRes.headers);
        upRes.pipe(res);
      },
    );

    this.wireClientToUpstream(req, res, proxy, {
      errorLabel: `[http] upstream error via socks ${target.host}:${target.port}`,
      tunnel,
    });
  }

  /**
   * 转发前的早失败回写：目标解析失败（400）与自环（502）共用
   * @param status - 状态码（STATUS_BAD_REQUEST / STATUS_BAD_GATEWAY）
   */
  private failEarly(res: http.ServerResponse, status: number): void {
    if (!res.headersSent) {
      res.writeHead(status);
    }

    res.end(HTTP_502_BAD_GATEWAY);
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
    res.end(HTTP_502_BAD_GATEWAY);
  }
}

export function forwardHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sink?: PipeEventSink,
): void {
  new HttpForwarder(sink).handle(req, res);
}
