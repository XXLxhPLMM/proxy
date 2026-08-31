/**
 * ClientForwardProxy - 客户端正向代理服务（本地监听 + 上游转发）
 * 职责：
 * - 下游：复用 HttpProxy 的 http.Server 监听能力，对外暴露代理服务（port + proxyProtocol + auth*）
 * - 上游：按 upstreamProtocol/remote* 将请求经 HttpProxyClient / SocksProxyClient 转发到下一跳代理，支持异构协议串联
 * - 鉴权链：AuthChain 负责 遇鉴权消费剥离，否则透传（见 auth-chain.ts），上游鉴权由 Proxy-Authorization 注入实现穿透隔离
 * 关联：core/http, core/auth, client/http, client/socks, config/store, utils/logger
 */

import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { HttpProxy } from "../core/http.js";
import type { ProxyOptions } from "../core/types.js";
import { getLogger } from "../utils/logger.js";
import { AuthChain } from "./auth-chain.js";
import type { AuthProvider } from "../core/auth.js";
import {
  BODY_BAD_GATEWAY,
  BODY_BAD_REQUEST,
  BODY_GATEWAY_TIMEOUT,
  BODY_PROXY_AUTH_REQUIRED,
  CRLF,
  DOUBLE_CRLF,
  HEADER_PROXY_AUTHENTICATE,
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_400_BAD_REQUEST,
  HTTP_407_PROXY_AUTH_REQUIRED,
  HTTP_504_GATEWAY_TIMEOUT,
  RE_HTTP_STATUS,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_GATEWAY_TIMEOUT,
  STATUS_PROXY_AUTH_REQUIRED,
} from "../utils/constants.js";
import { get } from "../config/store.js";

export interface UpstreamConfig {
  host: string;
  port: number;
  protocol: "http" | "https" | "socks" | "tls";
  secure?: boolean;
  username?: string;
  password?: string;
  ca?: string;
  insecure?: boolean;
  timeout?: number;
}

export interface ClientForwardProxyOptions extends ProxyOptions {
  upstream: UpstreamConfig;
  localAuth: AuthProvider;
}

export class ClientForwardProxy extends HttpProxy {
  private readonly upstream: UpstreamConfig;
  private readonly localAuth: AuthProvider;
  private readonly authChain: AuthChain;
  private readonly upstreamAuthHeader?: string;
  private readonly clog = getLogger("ClientForwardProxy");

  constructor(opts: ClientForwardProxyOptions) {
    // HttpProxy 构造会持有 auth，但我们用 auth-chain 接管，仍传入以复用 BaseProxy 能力（日志等）
    super({ port: opts.port, host: opts.host, auth: opts.localAuth, upstreamTimeout: opts.upstreamTimeout, tls: opts.tls });
    this.upstream = opts.upstream;
    this.localAuth = opts.localAuth;
    if (opts.upstream.username) {
      this.upstreamAuthHeader = `Basic ${Buffer.from(`${opts.upstream.username}:${opts.upstream.password ?? ""}`).toString("base64")}`;
    }
    this.authChain = new AuthChain({ localAuth: this.localAuth, upstreamAuthHeader: this.upstreamAuthHeader });
  }

  /** 覆写 HTTP 明文转发：改为经上游代理转发 */
  protected override async forwardHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const clientAddr = (req.socket as net.Socket).remoteAddress ?? "unknown";
    const targetHint = req.url ?? req.headers.host ?? "-";
    this.clog.debug(`[client-http] ${clientAddr} -> ${targetHint} via upstream ${this.upstream.host}:${this.upstream.port}(${this.upstream.protocol})`);

    const authority = req.headers.host ?? "";
    const chain = await this.authChain.process({ req, socket: req.socket as unknown as Duplex, authority, protocol: this.protocol });
    if (!chain.passed) {
      res.writeHead(STATUS_PROXY_AUTH_REQUIRED, { "Proxy-Authenticate": HEADER_PROXY_AUTHENTICATE });
      res.end(BODY_PROXY_AUTH_REQUIRED);
      return;
    }

    // 剥离或透传逻辑：若本级消费成功 strip，否则保持原 header 让上游消费
    const targetUrl = this.resolveTargetUrl(req);
    if (!targetUrl) {
      this.clog.warn(`[client-http] bad url ${clientAddr} -> ${targetHint}`);
      res.writeHead(STATUS_BAD_REQUEST, { "Content-Type": "text/plain" });
      res.end(BODY_BAD_REQUEST);
      return;
    }

    // 构造转上游的 headers
    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    delete headers["proxy-connection"];
    // 根据 auth-chain 决定是否剥离入站 Proxy-Authorization
    if (chain.strip) delete headers["proxy-authorization"];
    // 只有 strip 后或透传无头但上游需鉴权时，才注入上游头
    if (chain.injectUpstream && this.upstreamAuthHeader) {
      headers["proxy-authorization"] = this.upstreamAuthHeader;
    }
    headers["connection"] = "close";

    try {
      const proto = this.upstream.protocol;
      if (proto === "socks" || proto === "tls") {
        // http 明文经 socks 上游：走 SOCKS5 隧道后发 HTTP
        await this.forwardHttpViaSocks(targetUrl, req, res, headers as Record<string, string>);
        return;
      }
      // 默认 http/https 上游：向远程代理发完整 URL 的代理请求
      await this.forwardHttpViaHttpProxy(targetUrl, req, res, headers as Record<string, string>);
    } catch (e) {
      this.clog.warn(`[client-http] upstream error ${clientAddr} -> ${targetUrl.host}:`, (e as Error).message);
      if (!res.headersSent) res.writeHead(STATUS_BAD_GATEWAY);
      res.end(BODY_BAD_GATEWAY);
    }
  }

  private async forwardHttpViaHttpProxy(
    targetUrl: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    headers: Record<string, string>,
  ): Promise<void> {
    const isUpstreamHttps = this.upstream.protocol === "https" || this.upstream.secure;
    const useTls = isUpstreamHttps;
    const reqOpts: http.RequestOptions = {
      host: this.upstream.host,
      port: this.upstream.port,
      method: req.method,
      path: targetUrl.href, // 代理语义需完整 URL
      headers,
      // https 上游的 CA 校验
      ca: this.upstream.ca || undefined,
      rejectUnauthorized: !this.upstream.insecure,
    } as http.RequestOptions;

    const doRequest = (useTls ? (await import("node:https")).request : http.request) as typeof http.request;

    await new Promise<void>((resolve, reject) => {
      const proxyReq = doRequest(reqOpts, (proxyRes) => {
        if (res.headersSent) { resolve(); return; }
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on("end", () => resolve());
        proxyRes.on("error", reject);
      });

      const timeout = this.options.upstreamTimeout as number;
      if (timeout > 0) {
        proxyReq.setTimeout(timeout, () => {
          proxyReq.destroy(new Error(`upstream timeout after ${timeout}ms`));
          if (!res.headersSent) res.writeHead(STATUS_GATEWAY_TIMEOUT);
          res.end(BODY_GATEWAY_TIMEOUT);
          reject(new Error("timeout"));
        });
      }
      proxyReq.on("error", (err) => {
        if (res.headersSent || res.writableEnded) { reject(err); return; }
        if ((err as Error).message.includes("upstream timeout")) { reject(err); return; }
        if (!res.headersSent) res.writeHead(STATUS_BAD_GATEWAY);
        res.end(BODY_BAD_GATEWAY);
        reject(err);
      });
      req.pipe(proxyReq);
    });
  }

  private async forwardHttpViaSocks(
    targetUrl: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    headers: Record<string, string>,
  ): Promise<void> {
    const { SocksProxyClient } = await import("./socks.js");
    const client = new SocksProxyClient({
      host: this.upstream.host,
      port: this.upstream.port,
      secure: this.upstream.secure ?? true,
      username: this.upstream.username,
      password: this.upstream.password,
      ca: this.upstream.ca,
      insecure: this.upstream.insecure,
      timeout: this.upstream.timeout ?? this.options.upstreamTimeout,
    });

    const targetPort = Number(targetUrl.port || 80);
    const tunnel = await client.connect(targetUrl.hostname, targetPort);
    const s = tunnel as unknown as net.Socket;

    // 构造经隧道的 HTTP 请求
    const headerLines = Object.entries(headers)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join(CRLF);
    // 确保 Host 存在
    const hasHost = Object.keys(headers).some((k) => k.toLowerCase() === "host");
    const hostLine = hasHost ? "" : `Host: ${targetUrl.host}${CRLF}`;
    const payload = `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1${CRLF}${hostLine}${headerLines}${CRLF}Connection: close${DOUBLE_CRLF}`;

    await new Promise<void>((resolve, reject) => {
      let data = Buffer.alloc(0);
      const onData = (d: Buffer) => (data = Buffer.concat([data, d]));
      s.on("data", onData);
      s.on("error", reject);
      s.on("close", () => {
        s.off("data", onData);
        // 解析响应头后回写
        const headEnd = data.indexOf(DOUBLE_CRLF);
        if (headEnd === -1) {
          if (!res.headersSent) res.writeHead(STATUS_BAD_GATEWAY);
          res.end(BODY_BAD_GATEWAY);
          resolve();
          return;
        }
        const headStr = data.subarray(0, headEnd).toString();
        const lines = headStr.split(CRLF);
        const statusLine = lines[0] ?? "";
        const m = statusLine.match(RE_HTTP_STATUS);
        const code = m ? Number(m[1]) : 502;
        const respHeaders: Record<string, string> = {};
        for (let i = 1; i < lines.length; i++) {
          const idx = lines[i].indexOf(":");
          if (idx === -1) continue;
          respHeaders[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
        }
        if (!res.headersSent) res.writeHead(code, respHeaders);
        res.end(data.subarray(headEnd + DOUBLE_CRLF.length));
        resolve();
      });
      // 透传请求体（POST 等）
      if (req.method !== "GET" && req.method !== "HEAD") {
        req.on("data", (chunk: Buffer) => s.write(chunk));
        req.on("end", () => s.write(payload));
        // 若无 body，直接发 header
        if ((req as unknown as { readableEnded?: boolean }).readableEnded) s.write(payload);
        else if (req.readableLength === 0) setTimeout(() => { if (s.writable) s.write(payload); }, 10);
        else s.write(payload);
      } else {
        s.write(payload);
      }
      req.on("error", reject);
      // 简单：直接发 header，非 GET 也会带 body，socks 隧道是透传 TCP，不影响
      if (req.method === "GET" || req.method === "HEAD") {
        // 已发
      }
    });
  }

  /** 覆写 CONNECT 隧道：改为经上游建隧道 */
  protected override async forwardTunnel(
    req: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const clientAddr = (clientSocket as unknown as net.Socket).remoteAddress ?? "unknown";
    const authority = req.url ?? "";
    this.clog.info(`[client-tunnel] ${clientAddr} -> ${authority} via upstream ${this.upstream.host}:${this.upstream.port}(${this.upstream.protocol})`);

    const chain = await this.authChain.process({ req, socket: clientSocket, authority, protocol: this.protocol });
    if (!chain.passed) {
      clientSocket.write(HTTP_407_PROXY_AUTH_REQUIRED);
      clientSocket.destroy();
      return;
    }

    const [hostname, portRaw] = authority.split(":");
    const port = Number(portRaw ?? 443);
    if (!hostname || Number.isNaN(port)) {
      clientSocket.end(HTTP_400_BAD_REQUEST);
      return;
    }

    try {
      const proto = this.upstream.protocol;
      let serverSocket: net.Socket | Duplex;

      if (proto === "socks" || proto === "tls") {
        const { SocksProxyClient } = await import("./socks.js");
        const sc = new SocksProxyClient({
          host: this.upstream.host,
          port: this.upstream.port,
          secure: this.upstream.secure ?? true,
          username: this.upstream.username,
          password: this.upstream.password,
          ca: this.upstream.ca,
          insecure: this.upstream.insecure,
          timeout: this.upstream.timeout ?? this.options.upstreamTimeout,
        });
        serverSocket = (await sc.connect(hostname, port)) as unknown as net.Socket;
      } else {
        // http/https 上游：先连上游代理，再发 CONNECT
        const useTls = proto === "https" || this.upstream.secure;
        const raw: net.Socket = await new Promise((resolve, reject) => {
          const s = useTls
            ? tls.connect({ host: this.upstream.host, port: this.upstream.port, ca: this.upstream.ca as string | undefined, rejectUnauthorized: !this.upstream.insecure })
            : net.connect(this.upstream.port, this.upstream.host);
          s.once("error", reject);
          s.once(useTls ? "secureConnect" : "connect", () => resolve(s as net.Socket));
          const t = this.options.upstreamTimeout as number;
          if (t > 0) s.setTimeout(t, () => { s.destroy(); reject(new Error("timeout")); });
        });

        // 构造 CONNECT 到上游
        const authLine = this.upstreamAuthHeader && chain.injectUpstream ? `Proxy-Authorization: ${this.upstreamAuthHeader}${CRLF}` : chain.strip ? "" : (req.headers["proxy-authorization"] ? `Proxy-Authorization: ${req.headers["proxy-authorization"]}${CRLF}` : "");
        // 若本级已剥离且上游需注入，则用上游头；若本级透传则保留原头；否则不加
        let proxyAuth = "";
        if (chain.strip && this.upstreamAuthHeader) proxyAuth = `Proxy-Authorization: ${this.upstreamAuthHeader}${CRLF}`;
        else if (!chain.strip && req.headers["proxy-authorization"]) proxyAuth = `Proxy-Authorization: ${req.headers["proxy-authorization"]}${CRLF}`;
        else if (!chain.strip && !req.headers["proxy-authorization"] && this.upstreamAuthHeader && chain.injectUpstream) proxyAuth = `Proxy-Authorization: ${this.upstreamAuthHeader}${CRLF}`;
        else proxyAuth = authLine;

        const connectReq = `CONNECT ${hostname}:${port} HTTP/1.1${CRLF}Host: ${hostname}:${port}${CRLF}${proxyAuth}Proxy-Connection: keep-alive${DOUBLE_CRLF}`;

        await new Promise<void>((resolve, reject) => {
          const onData = (data: Buffer) => {
            const headStr = data.toString();
            if (!headStr.includes("200")) { raw.off("data", onData); reject(new Error(`upstream CONNECT failed: ${headStr.split(CRLF)[0]}`)); raw.destroy(); return; }
            const idx = data.indexOf(DOUBLE_CRLF);
            if (idx !== -1) { raw.off("data", onData); if (data.length > idx + DOUBLE_CRLF.length) raw.unshift(data.subarray(idx + DOUBLE_CRLF.length)); resolve(); }
          };
          raw.on("data", onData);
          raw.on("error", reject);
          raw.write(connectReq);
        });
        serverSocket = raw;
      }

      const ss = serverSocket as unknown as net.Socket;
      ss.setTimeout(0);
      this.clog.info(`[client-tunnel] established ${clientAddr} -> ${hostname}:${port} via upstream`);
      clientSocket.write(HTTP_200_CONNECTION_ESTABLISHED);
      if (head.length) (ss as unknown as Duplex & { write(b: Buffer): void }).write(head);
      (clientSocket as unknown as net.Socket).pipe(ss as unknown as net.Socket);
      (ss as unknown as net.Socket).pipe(clientSocket as unknown as net.Socket);

      const destroyBoth = () => { clientSocket.destroy(); ss.destroy(); };
      clientSocket.on("error", () => destroyBoth());
      ss.on("error", (err) => { this.clog.warn("[client-tunnel] upstream error:", (err as Error).message); destroyBoth(); });
      clientSocket.on("close", () => ss.destroy());
      ss.on("close", () => clientSocket.destroy());

      const timeout = this.options.upstreamTimeout as number;
      let timedOut = false;
      if (timeout > 0) {
        ss.setTimeout(timeout, () => {
          timedOut = true;
          try { if (!(clientSocket as unknown as net.Socket).destroyed) { (clientSocket as unknown as Duplex & { write(s:string):void }).write(HTTP_504_GATEWAY_TIMEOUT); clientSocket.destroy(); } } catch (_e) { void _e; }
          ss.destroy();
        });
      }
      const onErr = () => { if (timedOut) return; destroyBoth(); };
      clientSocket.on("error", onErr);
      ss.on("error", onErr);
    } catch (e) {
      this.clog.warn(`[client-tunnel] upstream dial failed ${clientAddr} -> ${hostname}:${port}:`, (e as Error).message);
      try { if (!(clientSocket as unknown as net.Socket).destroyed) { (clientSocket as unknown as Duplex & { write(s:string):void }).write(HTTP_504_GATEWAY_TIMEOUT); clientSocket.destroy(); } } catch (_e) { void _e; }
    }
  }
}

/** 工厂：按下游 proxyProtocol 创建对应的 ClientForwardProxy（当前 http/https 共用 http 实现，socks/tls 可扩展） */
export function createClientForwardProxy(opts: { port: number; upstream: UpstreamConfig; localAuth: AuthProvider; upstreamTimeout: number; tls: { key?: string; cert?: string; ca?: string; passphrase?: string } }): ClientForwardProxy {
  // 下游统一用 http.Server 暴露代理，兼容浏览器 http 代理设置；若需 socks 下游可在此分支创建 Socks 形态
  const proto = get("proxyProtocol") as string;
  // 预留：若下游是 socks，可返回 ClientSocksForwardProxy（待扩展）
  if (proto === "socks") {
    // 复用 http 形态托底，或后续实现 SocksForwardProxy
  }
  return new ClientForwardProxy({ port: opts.port, upstream: opts.upstream, localAuth: opts.localAuth, upstreamTimeout: opts.upstreamTimeout, tls: opts.tls });
}
