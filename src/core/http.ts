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
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "./types.js";
import { get } from "../config/store.js";
import { getLogger } from "../utils/logger.js";
import {
  BODY_BAD_GATEWAY,
  BODY_BAD_REQUEST,
  BODY_GATEWAY_TIMEOUT,
  BODY_PROXY_AUTH_REQUIRED,
  BODY_PROXY_ERROR,
  HEADER_PROXY_AUTHENTICATE,
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_400_BAD_REQUEST,
  HTTP_407_PROXY_AUTH_REQUIRED,
  HTTP_504_GATEWAY_TIMEOUT,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_GATEWAY_TIMEOUT,
  STATUS_INTERNAL_ERROR,
  STATUS_PROXY_AUTH_REQUIRED,
} from "../utils/constants.js";

/**
 * HTTP 代理实现类
 * 继承 BaseProxy，协议固定为 "http"
 * 内部持有单个 http.Server，同时监听 request 与 connect 事件
 */
export class HttpProxy extends BaseProxy {
  /** 底层 HTTP 服务实例，未启动时为 null */
  private server: http.Server | null = null;
  private readonly log = getLogger("HttpProxy");

  /**
   * 构造 HTTP 代理
   * @param options - 端口与地址，未传则继承 BaseProxy 默认值 3000/0.0.0.0
   */
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
      // 每个明文请求独立转发，内部已做 try/catch，不会击穿主服务
      this.forwardHttp(req, res);
    });

    // CONNECT 隧道用于 HTTPS，单独事件，避免与 request 混淆
    server.on("connect", (req, socket, head) => {
      this.forwardTunnel(req, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    // 运行期错误隔离：单连接/端口异常仅日志，不抛至进程导致退出
    server.on("error", (err) => {
      this.setState("error");
      this.log.error(`server error (${this.options.host}:${this.options.port}):`, err);
    });
    server.on("clientError", (err, socket) => {
      this.log.warn("clientError:", (err as Error).message);
      try {
        (socket as Duplex).end(HTTP_400_BAD_REQUEST);
      } catch {}
    });

    this.server = server;
  }

  protected async doStop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /**
   * 是否运行中
   * @returns 底层 server 是否处于 listening 态
   */
  isRunning(): boolean {
    return !!this.server?.listening;
  }

  /**
   * 明文 HTTP 转发
   * 触发时机：客户端发送 GET http://target/path 或 GET /path + Host 头
   * 步骤：
   *  1. resolveTargetUrl 解析目标 URL，失败回 400
   *  2. 清洗 hop-by-hop 头（proxy-connection/proxy-authorization），避免透传代理特有头
   *  3. 设置 connection:close，明确短连接，防止代理与目标复用异常
   *  4. http.request 按 hostname/port/path/method 向目标发请求，pipe 双向体
   *  5. 目标错误回 502，代理内部异常回 500，均已判 headersSent 避免二次写头
   * @param req - 客户端入站请求
   * @param res - 返给客户端的响应对象
   */
  private async forwardHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const clientAddr = (req.socket as net.Socket).remoteAddress ?? "unknown";
    const targetHint = req.url ?? req.headers.host ?? "-";
    this.log.debug(`[http] headers ${clientAddr} -> ${targetHint} ${JSON.stringify(req.headers)}`);

    // 抽象层鉴权：由 Auth 集中输出 [auth] allow/deny 日志（含用户名审计），此处仅处理 407 响应
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
      const targetUrl = this.resolveTargetUrl(req);
      if (!targetUrl) {
        this.log.warn(`[http] bad url ${clientAddr} -> ${targetHint}`);
        res.writeHead(STATUS_BAD_REQUEST, { "Content-Type": "text/plain" });
        res.end(BODY_BAD_REQUEST);
        return;
      }

      this.log.info(`[http] ${clientAddr} -> ${targetUrl.hostname}:${targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80)} ${req.method} ${targetUrl.pathname}${targetUrl.search}`);

      // 浅拷贝后清洗，避免修改原 req.headers 影响后续逻辑
      const headers = { ...req.headers };
      delete headers["proxy-connection"];
      delete headers["proxy-authorization"];
      headers["connection"] = "close";

      const proxyReq = http.request(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
          method: req.method,
          path: targetUrl.pathname + targetUrl.search,
          headers,
        },
        (proxyRes) => {
          // 原样回写目标状态码与头，再 pipe 体，实现零拷贝透传
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );

      // 上游超时：超时回 504，避免客户端无限挂起（配置 UPSTREAM_TIMEOUT，默认 10000）
      const timeout = get("upstreamTimeout") as number;
      if (timeout > 0) {
        proxyReq.setTimeout(timeout, () => {
          this.log.warn(`[http] upstream timeout ${clientAddr} -> ${targetUrl.host} after ${timeout}ms`);
          proxyReq.destroy(new Error(`upstream timeout after ${timeout}ms`));
          if (!res.headersSent) res.writeHead(STATUS_GATEWAY_TIMEOUT);
          res.end(BODY_GATEWAY_TIMEOUT);
        });
      }

      // 目标不可达或超时，统一转 502（若已 504 则跳过）
      proxyReq.on("error", (err) => {
        if (res.headersSent || res.writableEnded) return;
        // 超时已由 setTimeout 回 504，此处避免二次 502
        if ((err as Error).message.includes("upstream timeout")) return;
        this.log.warn(`[http] upstream error ${clientAddr} -> ${targetUrl.host}:`, (err as Error).message);
        if (!res.headersSent) res.writeHead(STATUS_BAD_GATEWAY);
        res.end(BODY_BAD_GATEWAY);
      });

      // 客户端请求体（如 POST）透传至目标
      req.pipe(proxyReq);
    } catch {
      if (!res.headersSent) res.writeHead(STATUS_INTERNAL_ERROR);
      res.end(BODY_PROXY_ERROR);
    }
  }

  /**
   * CONNECT 隧道转发（HTTPS/WebSocket）
   * 触发时机：客户端发送 CONNECT example.com:443 HTTP/1.1
   * 步骤：
   *  1. 解析 req.url 为 hostname:port，非法回 400 并断开
   *  2. net.connect 直连目标 TCP，成功后回 200 Connection Established 告知客户端隧道已建
   *  3. 若 head 有粘包数据（已读但未消费的字节），先写入目标，避免丢字节
   *  4. 双向 pipe：clientSocket <-> serverSocket，此后代理不再解析内容，纯透传
   *  5. 任一端 error/close 则双端 destroy，防止半开连接泄漏
   * @param req - CONNECT 请求，url 为 authority 形式 host:port
   * @param clientSocket - 与客户端的 TCP 套接字（http 模块定义为 Duplex，实为 net.Socket）
   * @param head - 已读的粘包缓冲，需透传
   */
  private async forwardTunnel(
    req: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const clientAddr = (clientSocket as unknown as net.Socket).remoteAddress ?? "unknown";
    const authority = req.url ?? "";
    this.log.debug(`[tunnel] headers ${clientAddr} -> ${authority} ${JSON.stringify(req.headers)}`);
    this.log.info(`[tunnel] ${clientAddr} -> ${authority} CONNECT`);

    // 抽象层鉴权：由 Auth 集中输出日志，此处仅处理 407 断开
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

    const [hostname, portRaw] = authority.split(":");
    const port = Number(portRaw ?? 443);

    // authority 必须为 host:port，防止恶意构造
    if (!hostname || Number.isNaN(port)) {
      this.log.warn(`[tunnel] bad authority ${clientAddr} -> ${authority}`);
      clientSocket.end(HTTP_400_BAD_REQUEST);
      return;
    }

    this.log.info(`[tunnel] dial ${clientAddr} -> ${hostname}:${port}`);
    const serverSocket = net.connect(port, hostname, () => {
      // 连接成功后清除超时并建立隧道
      serverSocket.setTimeout(0);
      this.log.info(`[tunnel] established ${clientAddr} -> ${hostname}:${port}`);
      clientSocket.write(HTTP_200_CONNECTION_ESTABLISHED);
      if (head.length) serverSocket.write(head);
      clientSocket.pipe(serverSocket);
      serverSocket.pipe(clientSocket);
    });

    // 上游 TCP 超时：超时前未 established 则回 504 并销毁（配置 UPSTREAM_TIMEOUT）
    const timeout = get("upstreamTimeout") as number;
    let timedOut = false;
    if (timeout > 0) {
      serverSocket.setTimeout(timeout, () => {
        if (serverSocket.destroyed) return;
        timedOut = true;
        this.log.warn(`[tunnel] upstream timeout ${clientAddr} -> ${hostname}:${port} after ${timeout}ms`);
        try {
          if (!clientSocket.destroyed) {
            clientSocket.write(HTTP_504_GATEWAY_TIMEOUT);
            clientSocket.destroy();
          }
        } catch {}
        serverSocket.destroy();
      });
    }

    const destroyBoth = (): void => {
      clientSocket.destroy();
      serverSocket.destroy();
    };

    const onErr = (side: string) => (err: Error) => {
      if (timedOut) return;
      this.log.warn(`[tunnel] ${side} error ${clientAddr} -> ${hostname}:${port}:`, err.message);
      destroyBoth();
    };
    clientSocket.on("error", onErr("client"));
    serverSocket.on("error", onErr("upstream"));
    clientSocket.on("close", () => serverSocket.destroy());
    serverSocket.on("close", () => clientSocket.destroy());
  }

  /**
   * 解析目标 URL
   * 兼容两种客户端写法：
   *  - 代理显式写法：GET http://example.com/path  -> 直接 new URL
   *  - 直连写法：GET /path + Host: example.com     -> 拼 http://Host/path
   * 额外：尊重 x-forwarded-proto 头，用于上游已做 TLS 终止的场景
   * @param req - 入站请求
   * @returns 合法 URL 或 null（缺少 Host 或格式错误）
   */
  private resolveTargetUrl(req: http.IncomingMessage): URL | null {
    const raw = req.url ?? "";
    try {
      if (/^https?:\/\//i.test(raw)) return new URL(raw);
      const host = req.headers.host;
      if (!host) return null;
      const proto = (req.headers["x-forwarded-proto"] as string) || "http:";
      const prefix = proto.endsWith(":") ? proto : `${proto}:`;
      return new URL(`${prefix}//${host}${raw.startsWith("/") ? raw : `/${raw}`}`);
    } catch {
      return null;
    }
  }
}

/**
 * 快捷工厂函数
 * 用途：保持与历史 createHttpProxy 命名兼容，外部可不直接 new
 * @param options - 同 HttpProxy 构造参数
 * @returns HttpProxy 实例（未启动，需 await start()）
 */
export function createHttpProxy(options?: ProxyOptions): HttpProxy {
  return new HttpProxy(options);
}
