/**
 * HTTP 代理核心 - 原生 http 实现
 * 职责：基于 Node 原生 http/net 实现两类代理能力
 *  1) HTTP 明文转发：解析客户端明文请求，按 URL 透传至目标并回写响应
 *  2) CONNECT 隧道：为 HTTPS/WebSocket 建立 TCP 盲转发隧道
 * 继承：BaseProxy，复用 port/host 归一化与 startedAt 统计，遵循统一启停契约
 * 依赖：仅 node:http / node:net，零第三方
 */

import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { BaseProxy } from "../core/base.js";
import type { ProxyOptions } from "../core/types.js";
import { getLogger } from "../utils/logger.js";
import {
  BODY_BAD_GATEWAY,
  BODY_BAD_REQUEST,
  BODY_GATEWAY_TIMEOUT,
  BODY_PROXY_AUTH_REQUIRED,
  BODY_PROXY_ERROR,
  HEADER_PROXY_AUTHENTICATE,
  HTTP_407_PROXY_AUTH_REQUIRED,
  HTTP_400_BAD_REQUEST,
  STATUS_BAD_REQUEST,
  STATUS_INTERNAL_ERROR,
  STATUS_PROXY_AUTH_REQUIRED,
} from "../utils/constants.js";
import {
  resolveTargetUrl,
  sanitizeHeaders,
  parseAuthority,
  wrapTimeout,
  tunnelConnect,
} from "../utils/proxy-helpers.js";

/**
 * HTTP 代理实现类
 * 继承 BaseProxy，协议固定为 "http"
 * 内部持有单个 http.Server，同时监听 request 与 connect 事件
 */
export class HttpProxy extends BaseProxy {
  protected readonly log = getLogger("HttpProxy");

  constructor(options: ProxyOptions = {}) {
    super("http", options);
  }

  async onStarted(): Promise<void> {
    this.log.info(`[lifecycle] http started ${this.options.host}:${this.options.port} state=${this.state}`);
  }

  async onBeforeStop(): Promise<void> {
    this.log.info(`[lifecycle] http stopping ${this.options.host}:${this.options.port}`);
  }

  protected async doStart(): Promise<void> {
    const server = http.createServer((req, res) => {
      this.forwardHttp(req, res);
    });

    server.on("connect", (req, socket, head) => {
      this.forwardTunnel(req, socket, head);
    });

    await this.startListening(server, this.options.port, this.options.host);
    this.attachErrorHandlers(server, "clientError");
    this.server = server;
  }

  protected async doStop(): Promise<void> {
    await this.stopServer();
  }

  isRunning(): boolean {
    return !!this.server?.listening;
  }

  /**
   * 明文 HTTP 转发
   */
  protected async forwardHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const clientAddr = (req.socket as net.Socket).remoteAddress ?? "unknown";
    const targetHint = req.url ?? req.headers.host ?? "-";
    this.log.debug(`[http] headers ${clientAddr} -> ${targetHint} ${JSON.stringify(req.headers)}`);

    const passed = await this.authorize({
      protocol: this.protocol,
      req,
      socket: req.socket as unknown as Duplex,
      authority: req.headers.host ?? "",
    });
    if (!passed) {
      res.writeHead(STATUS_PROXY_AUTH_REQUIRED, { "Proxy-Authenticate": HEADER_PROXY_AUTHENTICATE });
      res.end(BODY_PROXY_AUTH_REQUIRED);
      return;
    }

    try {
      const targetUrl = resolveTargetUrl(req);
      if (!targetUrl) {
        this.log.warn(`[http] bad url ${clientAddr} -> ${targetHint}`);
        res.writeHead(STATUS_BAD_REQUEST, { "Content-Type": "text/plain" });
        res.end(BODY_BAD_REQUEST);
        return;
      }

      this.log.info(`[http] ${clientAddr} -> ${targetUrl.hostname}:${targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80)} ${req.method} ${targetUrl.pathname}${targetUrl.search}`);

      const headers = sanitizeHeaders(req.headers as Record<string, string | string[] | undefined>);

      const proxyReq = http.request(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
          method: req.method,
          path: targetUrl.pathname + targetUrl.search,
          headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );

      const timeout = this.options.upstreamTimeout as number;
      const timer = wrapTimeout(proxyReq, timeout, () => {
        this.log.warn(`[http] upstream timeout ${clientAddr} -> ${targetUrl.host} after ${timeout}ms`);
        proxyReq.destroy(new Error(`upstream timeout after ${timeout}ms`));
        if (!res.headersSent) res.writeHead(504);
        res.end(BODY_GATEWAY_TIMEOUT);
      });

      proxyReq.on("error", (err) => {
        if (res.headersSent || res.writableEnded) return;
        if (timer.isTimedOut()) return;
        this.log.warn(`[http] upstream error ${clientAddr} -> ${targetUrl.host}:`, (err as Error).message);
        if (!res.headersSent) res.writeHead(502);
        res.end(BODY_BAD_GATEWAY);
      });

      req.pipe(proxyReq);
    } catch {
      if (!res.headersSent) res.writeHead(STATUS_INTERNAL_ERROR);
      res.end(BODY_PROXY_ERROR);
    }
  }

  /**
   * CONNECT 隧道转发（HTTPS/WebSocket）
   */
  protected async forwardTunnel(
    req: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const clientAddr = (clientSocket as unknown as net.Socket).remoteAddress ?? "unknown";
    const authority = req.url ?? "";
    this.log.debug(`[tunnel] headers ${clientAddr} -> ${authority} ${JSON.stringify(req.headers)}`);
    this.log.info(`[tunnel] ${clientAddr} -> ${authority} CONNECT`);

    const passed = await this.authorize({
      protocol: this.protocol,
      req,
      socket: clientSocket,
      authority,
    });
    if (!passed) {
      clientSocket.write(HTTP_407_PROXY_AUTH_REQUIRED);
      clientSocket.destroy();
      return;
    }

    const parsed = parseAuthority(authority);
    if (!parsed) {
      this.log.warn(`[tunnel] bad authority ${clientAddr} -> ${authority}`);
      clientSocket.end(HTTP_400_BAD_REQUEST);
      return;
    }

    const timeout = this.options.upstreamTimeout as number;
    tunnelConnect({
      clientSocket,
      hostname: parsed.hostname,
      port: parsed.port,
      head,
      timeout,
      log: this.log,
      logPrefix: "tunnel",
    });
  }

  protected resolveTargetUrl(req: http.IncomingMessage): URL | null {
    return resolveTargetUrl(req);
  }
}

export function createHttpProxy(options?: ProxyOptions): HttpProxy {
  return new HttpProxy(options);
}
