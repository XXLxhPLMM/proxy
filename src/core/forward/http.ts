import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import net from "node:net";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import {
  isSelfLoop,
  sanitizeHeaders,
  parseTargetParts,
  encodeBasicCredentials,
} from "@/core/proxy-helpers.js";
import {
  buildProxyAuthValue,
  HEADER_NAME_CONNECTION,
  HEADER_NAME_HOST_LOWER,
  HEADER_VALUE_CLOSE,
  HTTP_502_BAD_GATEWAY,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
} from "@/utils/constants.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import { Dialer } from "./dial.js";

/**
 * 上游鉴权头：仅当显式配置 upstreamUsername 时携带
 * 仅 client 模式透传上游时使用，server 直连不带
 */
function upstreamAuth(): string | undefined {
  const u = get("upstreamUsername");

  if (!u) {
    return undefined;
  }

  return buildProxyAuthValue(encodeBasicCredentials(u, get("upstreamPassword")));
}

/**
 * 读取上游 CA（自签场景），不存在则回退系统信任库
 */
function readCa(): Buffer | undefined {
  const p = get("upstreamCa");

  if (p && fs.existsSync(p)) {
    return fs.readFileSync(p);
  }

  return undefined;
}

/**
 * HTTP 转发器
 * - server 模式：解析 req.url/host 直连目标
 * - client 模式：按 upstreamProtocol 选
 *   http/https/socks 串联上游，自动注入 Proxy-Authorization
 */
export class HttpForwarder {
  private dialer = new Dialer();

  constructor(private sink?: PipeEventSink) {}

  // sink 异常静默吞掉：日志回调不得炸掉转发链
  private emit(e: unknown): void {
    try {
      this.sink?.(e as never);
    } catch {}
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

      if (!clientRes.headersSent) {
        clientRes.writeHead(STATUS_BAD_REQUEST);
      }

      clientRes.end(HTTP_502_BAD_GATEWAY);
      return;
    }

    // 自环防护：避免代理连向自身导致死循环
    if (isSelfLoop(target.host, target.port)) {
      this.emit({
        type: "loop-detected",
        req: clientReq,
        target: `${target.host}:${target.port}`,
      });

      if (!clientRes.headersSent) {
        clientRes.writeHead(STATUS_BAD_GATEWAY);
      }

      clientRes.end(HTTP_502_BAD_GATEWAY);
      return;
    }

    const proto = mode === "client" ? get("upstreamProtocol") : "http";

    // https 上游走 https.request（TLS 承载）；socks4/socks5/sockss4/sockss5 一律走 SOCKS 隧道
    // （dialSocks 按 upstreamProtocol 自行推导 version 与 TLS 承载，见 Dialer.dialSocks）
    if (proto === "https") {
      this.forwardHttps(clientReq, clientRes, target);
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

    this.forwardHttp(clientReq, clientRes, target);
  }

  /**
   * 明文通道：server 直连与 http 上游共用 http.request
   */
  private forwardHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: { host: string; port: number; path: string },
  ): void {
    const headers: Record<string, string | string[] | undefined> = sanitizeHeaders(
      req.headers as never,
    );

    // 仅显式配 upstreamUsername 才注入：防 client 头透传泄漏
    if (get("proxyMode") === "client") {
      const auth = upstreamAuth();

      if (auth) {
        (headers as Record<string, unknown>)["proxy-authorization"] = auth;
      }
    }

    // server 直连必须先归一：客户端以 absolute-form 请求本代理时 req.url 是整串 URL，
    // 原样交给 http.request 会把 `GET http://host/path` 写进请求行，源站收到畸形 request-target
    const path = get("proxyMode") === "client" ? req.url! : target.path;

    const opts: http.RequestOptions = {
      host: target.host,
      port: target.port,
      method: req.method,
      path,
      headers: headers as never,
      timeout: get("upstreamTimeout"),
    };

    const proxy = http.request(opts, (upRes) => {
      // 无状态行归属 502：上游未给有效响应即网关无应答
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });

    proxy.on("error", () => {
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
      }
    });

    req.pipe(proxy);
  }

  /**
   * TLS 通道：https 上游经 https.request，按建链目标校验 SNI
   */
  private forwardHttps(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: { host: string; port: number; path: string },
  ): void {
    const headers: Record<string, string | string[] | undefined> = sanitizeHeaders(
      req.headers as never,
    );

    // 仅显式配 upstreamUsername 才注入：防 client 头透传泄漏
    if (get("proxyMode") === "client") {
      const auth = upstreamAuth();

      if (auth) {
        (headers as Record<string, unknown>)["proxy-authorization"] = auth;
      }
    }

    // 与 forwardHttp 同规则：server 直连用解析后的 origin-form，client 串联保留客户端原始形态
    const path = get("proxyMode") === "client" ? req.url! : target.path;

    const opts: https.RequestOptions = {
      host: target.host,
      port: target.port,
      method: req.method,
      path,
      headers: headers as never,
      timeout: get("upstreamTimeout"),
      // 证书校验必须锚定建链目标，而非转发的 Host 头（Host 是源站名）
      // IP 按 RFC6066 置空 servername（跳过 SNI，按连接 host 校验 SAN-IP）
      servername: net.isIP(target.host) ? "" : target.host,
      rejectUnauthorized: !get("upstreamInsecure"),
      ca: readCa(),
    };

    const proxy = https.request(opts, (upRes) => {
      // 无状态行归属 502：上游未给有效响应即网关无应答
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });

    proxy.on("error", () => {
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
      if (!res.headersSent) {
        res.writeHead(STATUS_BAD_REQUEST);
      }

      res.end(HTTP_502_BAD_GATEWAY);
      return;
    }

    // 真实目标已重解析，需二次自环校验
    if (isSelfLoop(real.host, real.port)) {
      if (!res.headersSent) {
        res.writeHead(STATUS_BAD_GATEWAY);
      }

      res.end(HTTP_502_BAD_GATEWAY);
      return;
    }

    this.dialViaSocksAndForward(req, res, real).catch(() => {
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

    // 拨号失败统一交由调用方 catch 回 res：守卫内不回裸 HTTP（空 reply），避免与 res 双响应污染协议
    const tunnel = await this.dialer.dialSocks(
      req.socket as unknown as Duplex,
      target.host,
      target.port,
      version,
      undefined,
      { timeoutReply: "", errorReply: "" },
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

    proxy.on("error", () => {
      this.fail(res);
    });

    // timeout 只 destroy：具体 502 由 error 兜底统一回
    proxy.on("timeout", () => {
      proxy.destroy();
    });

    // 客户端中断：同时销毁上游请求与隧道，避免悬挂至超时
    res.on("close", () => {
      if (!res.writableEnded) {
        proxy.destroy();

        if (!tunnel.destroyed) {
          tunnel.destroy();
        }
      }
    });

    req.pipe(proxy);
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
