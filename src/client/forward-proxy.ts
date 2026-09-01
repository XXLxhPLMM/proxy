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
import type { Duplex } from "node:stream";
import { HttpProxy } from "../server/http.js";
import type { ProxyOptions } from "../core/types.js";
import { getLogger } from "../utils/logger.js";
import { AuthChain } from "./auth-chain.js";
import { UpstreamConnector } from "./upstream-connector.js";
import type { AuthProvider } from "../core/auth.js";
import {
  BODY_BAD_GATEWAY,
  BODY_BAD_REQUEST,
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
  STATUS_PROXY_AUTH_REQUIRED,
} from "../utils/constants.js";
import { get } from "../config/store.js";
import {
  resolveTargetUrl,
  sanitizeHeaders,
  parseAuthority,
  setupTunnelTimeout,
  buildHttpRequestHeaders,
} from "../utils/proxy-helpers.js";

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
  private readonly connector: UpstreamConnector;
  private readonly clog = getLogger("ClientForwardProxy");

  constructor(opts: ClientForwardProxyOptions) {
    // HttpProxy 构造会持有 auth，但我们用 auth-chain 接管，仍传入以复用 BaseProxy 能力（日志等）
    super({ port: opts.port, host: opts.host, auth: opts.localAuth, upstreamTimeout: opts.upstreamTimeout, tls: opts.tls });
    this.upstream = opts.upstream;
    this.localAuth = opts.localAuth;
    if (opts.upstream.username) {
      this.upstreamAuthHeader = `Basic ${Buffer.from(`${opts.upstream.username}:${opts.upstream.password ?? ""}`).toString("base64")}`;
    }
    this.connector = new UpstreamConnector({
      host: opts.upstream.host,
      port: opts.upstream.port,
      protocol: opts.upstream.protocol,
      secure: opts.upstream.secure,
      username: opts.upstream.username,
      password: opts.upstream.password,
      ca: opts.upstream.ca,
      insecure: opts.upstream.insecure,
      timeout: opts.upstream.timeout ?? opts.upstreamTimeout,
    });
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

    const targetUrl = resolveTargetUrl(req);
    if (!targetUrl) {
      this.clog.warn(`[client-http] bad url ${clientAddr} -> ${targetHint}`);
      res.writeHead(STATUS_BAD_REQUEST, { "Content-Type": "text/plain" });
      res.end(BODY_BAD_REQUEST);
      return;
    }

    const headers: Record<string, string | string[] | undefined> = sanitizeHeaders(req.headers as Record<string, string | string[] | undefined>);
    if (chain.strip) delete headers["proxy-authorization"];
    if (chain.injectUpstream && this.upstreamAuthHeader) {
      headers["proxy-authorization"] = this.upstreamAuthHeader;
    }

    try {
      const targetPort = Number(targetUrl.port || 80);
      const serverSocket = await this.connector.connect(targetUrl.hostname, targetPort);
      const payload = buildHttpRequestHeaders(req.method!, targetUrl, headers);

      await new Promise<void>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const onData = (d: Buffer) => chunks.push(d);
        serverSocket.on("data", onData);
        serverSocket.on("error", reject);
        serverSocket.on("close", () => {
          serverSocket.off("data", onData);
          const data = Buffer.concat(chunks);
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
        if (req.method !== "GET" && req.method !== "HEAD") {
          req.on("data", (chunk: Buffer) => serverSocket.write(chunk));
          req.on("end", () => serverSocket.write(payload));
          if ((req as unknown as { readableEnded?: boolean }).readableEnded) serverSocket.write(payload);
          else if (req.readableLength === 0) setTimeout(() => { if (serverSocket.writable) serverSocket.write(payload); }, 10);
          else serverSocket.write(payload);
        } else {
          serverSocket.write(payload);
        }
        req.on("error", reject);
      });
    } catch (e) {
      this.clog.warn(`[client-http] upstream error ${clientAddr} -> ${targetUrl.host}:`, (e as Error).message);
      if (!res.headersSent) res.writeHead(STATUS_BAD_GATEWAY);
      res.end(BODY_BAD_GATEWAY);
    }
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

    const parsed = parseAuthority(authority);
    if (!parsed) {
      clientSocket.end(HTTP_400_BAD_REQUEST);
      return;
    }

    const { hostname, port } = parsed;

    try {
      // 构建带鉴权头的 connector
      let authHeader: string | undefined;
      if (chain.strip && this.upstreamAuthHeader) authHeader = this.upstreamAuthHeader;
      else if (!chain.strip && req.headers["proxy-authorization"]) authHeader = req.headers["proxy-authorization"] as string;
      else if (!chain.strip && !req.headers["proxy-authorization"] && this.upstreamAuthHeader && chain.injectUpstream) authHeader = this.upstreamAuthHeader;

      const connector = authHeader
        ? new UpstreamConnector({
            host: this.upstream.host,
            port: this.upstream.port,
            protocol: this.upstream.protocol,
            secure: this.upstream.secure,
            username: this.upstream.username,
            password: this.upstream.password,
            ca: this.upstream.ca,
            insecure: this.upstream.insecure,
            timeout: this.upstream.timeout ?? this.options.upstreamTimeout,
          })
        : this.connector;

      const serverSocket = await connector.connect(hostname, port);

      serverSocket.setTimeout(0);
      this.clog.info(`[client-tunnel] established ${clientAddr} -> ${hostname}:${port} via upstream`);
      clientSocket.write(HTTP_200_CONNECTION_ESTABLISHED);
      if (head.length) serverSocket.write(head);
      (clientSocket as unknown as net.Socket).pipe(serverSocket);
      serverSocket.pipe(clientSocket as unknown as net.Socket);

      const destroyBoth = () => { clientSocket.destroy(); serverSocket.destroy(); };
      clientSocket.on("error", () => destroyBoth());
      serverSocket.on("error", (err) => { this.clog.warn("[client-tunnel] upstream error:", (err as Error).message); destroyBoth(); });
      clientSocket.on("close", () => serverSocket.destroy());
      serverSocket.on("close", () => clientSocket.destroy());

      const timeout = this.options.upstreamTimeout as number;
      const timer = setupTunnelTimeout(clientSocket as unknown as net.Socket, serverSocket, timeout, "client-tunnel");
      const onErr = () => { if (timer.isTimedOut()) return; destroyBoth(); };
      clientSocket.on("error", onErr);
      serverSocket.on("error", onErr);
    } catch (e) {
      this.clog.warn(`[client-tunnel] upstream dial failed ${clientAddr} -> ${hostname}:${port}:`, (e as Error).message);
      try { if (!(clientSocket as unknown as net.Socket).destroyed) { (clientSocket as unknown as Duplex & { write(s: string): void }).write(HTTP_504_GATEWAY_TIMEOUT); clientSocket.destroy(); } } catch (_e) { void _e; }
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
