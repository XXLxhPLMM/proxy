import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import net from "node:net";
import { get } from "@/config/store.js";
import {
  isSelfLoop,
  sanitizeHeaders,
  parseTargetParts,
  encodeBasicCredentials,
} from "@/core/proxy-helpers.js";
import {
  buildProxyAuthValue,
  CRLF,
  DOUBLE_CRLF,
  DOUBLE_CRLF_BUF,
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

    // client 串联时：目标即上游；
    // server 直连时：从绝对 URL / Host 解析真实目标
    const target =
      mode === "client"
        ? {
            host: get("upstreamHost"),
            port: get("upstreamPort"),
            path: clientReq.url ?? "/",
          }
        : parseTargetParts(clientReq.url ?? "", clientReq.headers.host as string);

    // 目标解析失败：回 502
    if (!target) {
      this.emit({ type: "target-unresolved" });

      if (!clientRes.headersSent) {
        clientRes.writeHead(STATUS_BAD_REQUEST);
      }

      clientRes.end(HTTP_502_BAD_GATEWAY);
      return;
    }

    // 自环防护：避免代理连向自身导致死循环
    if (isSelfLoop(target.host, target.port)) {
      this.emit({ type: "loop" });

      if (!clientRes.headersSent) {
        clientRes.writeHead(STATUS_BAD_GATEWAY);
      }

      clientRes.end(HTTP_502_BAD_GATEWAY);
      return;
    }

    // 按上游协议分发：http 直发、https 走 TLS、socks 走隧道
    const proto = mode === "client" ? get("upstreamProtocol") : "http";

    if (proto === "https" || proto === "sockss4" || proto === "sockss5") {
      this.forwardHttps(clientReq, clientRes, target);
      return;
    }

    if (proto === "socks4" || proto === "socks5") {
      this.forwardViaSocks(clientReq, clientRes);
      return;
    }

    this.forwardHttp(clientReq, clientRes, target);
  }

  /**
   * 明文 HTTP 上游（或 server 直连）
   */
  private forwardHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: { host: string; port: number; path: string },
  ): void {
    const headers: Record<string, string | string[] | undefined> = sanitizeHeaders(
      req.headers as never,
    );

    // 串联时注入上游鉴权
    if (get("proxyMode") === "client") {
      const auth = upstreamAuth();

      if (auth) {
        (headers as Record<string, unknown>)["proxy-authorization"] = auth;
      }
    }

    const isUpstream = get("proxyMode") === "client";
    const path = isUpstream ? req.url! : target.path;

    const opts: http.RequestOptions = {
      host: target.host,
      port: target.port,
      method: req.method,
      path,
      headers: headers as never,
      timeout: get("upstreamTimeout"),
    };

    const proxy = http.request(opts, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });

    proxy.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(STATUS_BAD_GATEWAY);
      }

      res.end(HTTP_502_BAD_GATEWAY);
    });

    proxy.on("timeout", () => {
      proxy.destroy();
    });

    req.pipe(proxy);
  }

  /**
   * TLS HTTP 上游（https / sockss* 复用 TLS 通道）
   */
  private forwardHttps(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: { host: string; port: number; path: string },
  ): void {
    const headers: Record<string, string | string[] | undefined> = sanitizeHeaders(
      req.headers as never,
    );

    if (get("proxyMode") === "client") {
      const auth = upstreamAuth();

      if (auth) {
        (headers as Record<string, unknown>)["proxy-authorization"] = auth;
      }
    }

    const isUpstream = get("proxyMode") === "client";
    const path = isUpstream ? req.url! : target.path;

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
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });

    proxy.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(STATUS_BAD_GATEWAY);
      }

      res.end(HTTP_502_BAD_GATEWAY);
    });

    proxy.on("timeout", () => {
      proxy.destroy();
    });

    req.pipe(proxy);
  }

  /**
   * SOCKS 上游：先经 Dialer 建 SOCKS 隧道，再在隧道上发原始 HTTP 报文
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

    // 自环二次校验
    if (isSelfLoop(real.host, real.port)) {
      if (!res.headersSent) {
        res.writeHead(STATUS_BAD_GATEWAY);
      }

      res.end(HTTP_502_BAD_GATEWAY);
      return;
    }

    this.dialViaSocksAndForward(req, res, real).catch(() => {
      if (!res.headersSent) {
        res.writeHead(STATUS_BAD_GATEWAY);
      }

      res.end(HTTP_502_BAD_GATEWAY);
    });
  }

  private async dialViaSocksAndForward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: { host: string; port: number; path: string },
  ): Promise<void> {
    // 建立到真实目标的 SOCKS 隧道（经 upstreamHost:upstreamPort）
    // 版本按 upstreamProtocol 推导：socks4/sockss4 → 4，其余 → 5
    const proto = get("upstreamProtocol");
    const version: 4 | 5 = proto === "socks4" || proto === "sockss4" ? 4 : 5;

    const tunnel = await this.dialer.dialSocks(
      req.socket as unknown as import("node:stream").Duplex,
      target.host,
      target.port,
      version,
    );

    // 组装原始 HTTP 请求行与头
    const headers = sanitizeHeaders(req.headers as never);

    // socks 隧道直达目标，不带 Proxy-Authorization（已在 SOCKS 层外）
    headers["host"] = `${target.host}:${target.port}`;
    headers["connection"] = "close";

    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v[0] : v}`)
      .join(CRLF);

    const requestHead =
      `${req.method} ${target.path} HTTP/${req.httpVersion}` +
      `${CRLF}${headerLines}${DOUBLE_CRLF}`;

    tunnel.write(requestHead);

    // 请求体透传：end:false，请求结束不能 FIN 隧道（否则响应回不来）
    // 隧道生命周期由目标的 connection:close / 双关接管
    req.pipe(tunnel, { end: false });

    // 响应：收齐头部后回写，再管道透传
    let buf = Buffer.alloc(0);

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);

      const idx = buf.indexOf(DOUBLE_CRLF_BUF);

      if (idx === -1) {
        return;
      }

      tunnel.off("data", onData);

      const headerBlock = buf.subarray(0, idx).toString();
      const remain = buf.subarray(idx + DOUBLE_CRLF_BUF.length);

      // 极简解析状态码
      const statusMatch = headerBlock.match(/HTTP\/\d\.\d\s+(\d+)/);
      const statusCode = statusMatch ? Number(statusMatch[1]) : 502;

      // 头部透传（此处简化：不逐行解析，直接透传原始头部后的 body）
      // 为保持正确，首包已含完整头部，剩余管道交由底层透传
      res.writeHead(statusCode);

      if (remain.length) {
        res.write(remain);
      }

      tunnel.pipe(res);
    };

    tunnel.on("data", onData);

    tunnel.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(STATUS_BAD_GATEWAY);
      }

      res.end(HTTP_502_BAD_GATEWAY);
    });
  }
}

export function forwardHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sink?: PipeEventSink,
): void {
  new HttpForwarder(sink).handle(req, res);
}
