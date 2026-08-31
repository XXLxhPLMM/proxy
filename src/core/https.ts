/**
 * HTTPS 代理核心 - TLS 之上的 HTTP 代理（原生 https 实现）
 * 文件职责：
 * - 继承 BaseProxy，协议固定 https，生命周期 onBeforeStart 加载证书（store tlsKey/tlsCert，相对路径以 cwd 解析）
 * - doStart 以 https.createServer({key,cert}) 监听 request/connect，复用与 HttpProxy 一致的 forwardHttp/forwardTunnel（鉴权、超时、日志、常量均复用）
 * - 客户端需先 TLS 握手再发 HTTP/CONNECT，服务端证书默认 keys/server.crt/key（CLI TLS_CERT/TLS_KEY/env 可覆）
 * - 常量收敛至 src/utils/constants.ts，日志前缀 HttpsProxy，错误时 setState("error")
 * 关联：store tls*、utils/constants、BaseProxy 状态机
 */

import https from "node:https";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
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
 * HTTPS 代理实现类
 * 继承 BaseProxy，协议固定为 "https"，生命周期与 HttpProxy 对齐，仅底层由 http.Server 换为 https.Server
 * 内部持有单个 https.Server，同时监听 request（TLS 内的 HTTP 明文）与 connect（TLS 内的 CONNECT 隧道）
 */
export class HttpsProxy extends BaseProxy {
  /** 底层 HTTPS 服务实例，未启动时为 null */
  private server: https.Server | null = null;
  /** 作用域日志，_prefix HttpsProxy */
  private readonly log = getLogger("HttpsProxy");

  /**
   * 构造 HTTPS 代理
   * @param options - 端口与地址，未传则继承 BaseProxy 默认值 3000/0.0.0.0；auth 由 createAuthFromConfig 注入
   */
  constructor(options: ProxyOptions = {}) {
    super("https", options);
  }

  /** 预加载证书缓存，避免每次 doStart 重复读盘 */
  private certs?: { key: Buffer; cert: Buffer };

  /**
   * 启动前钩子 - 加载证书
   * 时机：BaseProxy.start() 状态机 starting 阶段，由模板方法自动调用；失败将使状态机进入 error
   */
  async onBeforeStart(): Promise<void> {
    this.log.info(`[lifecycle] https loading certs key=${get("tlsKey")} cert=${get("tlsCert")}`);
    this.certs = this.loadCerts(); // 同步读盘，若缺失抛错由上层捕获转 error 态
  }

  /** 启动后钩子 - 探针日志 */
  async onStarted(): Promise<void> {
    this.log.info(`[lifecycle] https started ${this.options.host}:${this.options.port} state=${this.state}`);
  }

  /**
   * 真实建服 - 模板方法 doStart
   * 流程：
   *  1. 取缓存证书或首次加载
   *  2. 创建 https.Server，挂载 request(明文) 与 connect(隧道) 处理器
   *  3. 异步 listen，成功后由 BaseProxy 标记 running；失败由 Promise reject 抛出
   *  4. 注册 error/clientError 隔离，避免单连接异常击穿进程
   */
  protected async doStart(): Promise<void> {
    if (!this.certs) this.certs = this.loadCerts(); // 幂等兜底：若 onBeforeStart 未执行则此处加载
    const { key, cert } = this.certs;
    const server = https.createServer({ key, cert }, (req, res) => {
      // TLS 已解密，此处 req/res 为明文 HTTP，与 HttpProxy.forwardHttp 完全复用
      this.forwardHttp(req, res);
    });

    // CONNECT 隧道用于 HTTPS/WebSocket，单独事件避免与 request 混淆；socket 实为 TLSSocket 但按 Duplex 处理以复用隧道逻辑
    server.on("connect", (req, socket, head) => {
      this.forwardTunnel(req, socket as unknown as Duplex, head);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject); // 监听期错误（如 EADDRINUSE）直接 reject
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", reject); // 成功后移除一次性错误监听
        resolve();
      });
    });

    // 运行期错误隔离：单连接/端口异常仅日志并转 error 态，不抛至进程导致退出
    server.on("error", (err) => {
      this.setState("error");
      this.log.error(`server error (${this.options.host}:${this.options.port}):`, err);
    });
    server.on("clientError", (err, socket) => {
      this.log.warn("clientError:", (err as Error).message);
      try {
        (socket as Duplex).end(HTTP_400_BAD_REQUEST); // 客户端 TLS 握手/HTTP 解析失败回 400
      } catch {}
    });

    this.server = server;
  }

  /**
   * 真实关服 - 模板方法 doStop
   * 流程：若 server 存在则 close，回调后清空引用；幂等，未启动直接返回
   */
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
   * 加载证书 - 统一从 store 读取（优先级：CLI > env 文件 > 终端 > 默认）
   * @returns key/cert 的 Buffer
   */
  private loadCerts(): { key: Buffer; cert: Buffer } {
    const resolvePath = (p: string): string => (path.isAbsolute(p) ? p : path.join(process.cwd(), p));
    const keyPath = resolvePath(get("tlsKey") as unknown as string);
    const certPath = resolvePath(get("tlsCert") as unknown as string);
    try {
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    } catch (e) {
      this.log.error(`HTTPS 证书加载失败 key=${keyPath} cert=${certPath}`, e);
      throw e;
    }
  }

  /**
   * 明文 HTTP 转发（TLS 解密后）
   * 触发时机：客户端完成 TLS 握手后发送 GET http://target/path 或 GET /path + Host 头（与 HttpProxy 完全一致）
   * 步骤：
   *  1. authorize 鉴权，失败回 407
   *  2. resolveTargetUrl 解析目标 URL，失败回 400
   *  3. 清洗 hop-by-hop 头，设 connection:close
   *  4. http.request 向目标发请求，pipe 双向体，原样回写状态码与头
   *  5. 超时回 504，目标错误回 502，内部异常回 500，均判 headersSent 避免二次写头
   * @param req - TLS 解密后的入站请求
   * @param res - 返给客户端的响应对象
   */
  private async forwardHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const clientAddr = (req.socket as net.Socket).remoteAddress ?? "unknown"; // 取客户端 IP 用于审计
    const targetHint = req.url ?? req.headers.host ?? "-"; // 用于日志与鉴权拒绝提示

    // 抽象层鉴权：由 Auth 集中输出日志，此处仅处理 407
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
      this.log.info(`[https] ${clientAddr} -> ${targetUrl.hostname}:${targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80)} ${req.method} ${targetUrl.pathname}${targetUrl.search}`);

      // 浅拷贝后清洗，避免修改原 req.headers 影响后续逻辑
      const headers = { ...req.headers };
      delete headers["proxy-connection"]; // 代理特有头不透传
      delete headers["proxy-authorization"];
      headers["connection"] = "close"; // 明确短连接，防止复用异常

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
          this.log.warn(`[https] upstream timeout ${clientAddr} -> ${targetUrl.host} after ${timeout}ms`);
          proxyReq.destroy(new Error(`upstream timeout after ${timeout}ms`));
          if (!res.headersSent) res.writeHead(STATUS_GATEWAY_TIMEOUT);
          res.end(BODY_GATEWAY_TIMEOUT);
        });
      }
      // 目标不可达或超时，统一转 502（若已 504 则跳过）
      proxyReq.on("error", (err) => {
        if (res.headersSent || res.writableEnded) return;
        if ((err as Error).message.includes("upstream timeout")) return; // 超时已回 504，避免二次 502
        this.log.warn(`[https] upstream error ${clientAddr} -> ${targetUrl.host}:`, (err as Error).message);
        if (!res.headersSent) res.writeHead(STATUS_BAD_GATEWAY);
        res.end(BODY_BAD_GATEWAY);
      });
      req.pipe(proxyReq); // 客户端请求体（如 POST）透传至目标
    } catch {
      if (!res.headersSent) res.writeHead(STATUS_INTERNAL_ERROR);
      res.end(BODY_PROXY_ERROR);
    }
  }

  /**
   * CONNECT 隧道转发（TLS 内的 CONNECT）
   * 触发时机：客户端在 TLS 内发送 CONNECT example.com:443 HTTP/1.1
   * 步骤：
   *  1. 鉴权，失败回 407 并销毁
   *  2. 解析 authority 为 hostname:port，非法回 400
   *  3. net.connect 直连目标，成功后回 200 Connection Established
   *  4. 粘包 head 透传，双向 pipe，此后纯透传不再解析
   *  5. 任一端 error/close 双端 destroy，上游超时回 504
   * @param req - CONNECT 请求，url 为 authority host:port
   * @param clientSocket - 与客户端的 TLS 套接字（按 Duplex 处理）
   * @param head - 已读粘包缓冲
   */
  private async forwardTunnel(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
    const clientAddr = (clientSocket as unknown as net.Socket).remoteAddress ?? "unknown"; // 取 IP 用于审计
    const authority = req.url ?? "";
    this.log.info(`[tunnel-https] ${clientAddr} -> ${authority} CONNECT`);

    // 抽象层鉴权：由 Auth 集中输出日志，此处仅处理 407
    const passed = await this.authorize({ protocol: this.protocol, req, socket: clientSocket, authority });
    if (!passed) {
      clientSocket.write(HTTP_407_PROXY_AUTH_REQUIRED);
      clientSocket.destroy();
      return;
    }
    const [hostname, portRaw] = authority.split(":"); // 解析目标
    const port = Number(portRaw ?? 443); // 缺省 443

    // authority 必须为 host:port，防止恶意构造
    if (!hostname || Number.isNaN(port)) {
      this.log.warn(`[tunnel] bad authority ${clientAddr} -> ${authority}`);
      clientSocket.end(HTTP_400_BAD_REQUEST);
      return;
    }
    this.log.info(`[tunnel] dial ${clientAddr} -> ${hostname}:${port}`);
    const serverSocket = net.connect(port, hostname, () => {
      serverSocket.setTimeout(0); // 建连成功清除超时
      this.log.info(`[tunnel] established ${clientAddr} -> ${hostname}:${port}`);
      clientSocket.write(HTTP_200_CONNECTION_ESTABLISHED); // 告知客户端隧道就绪
      if (head.length) serverSocket.write(head); // 粘包透传
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
      if (timedOut) return; // 超时已处理，避免二次日志
      this.log.warn(`[tunnel] ${side} error ${clientAddr} -> ${hostname}:${port}:`, err.message);
      destroyBoth();
    };
    clientSocket.on("error", onErr("client"));
    serverSocket.on("error", onErr("upstream"));
    clientSocket.on("close", () => serverSocket.destroy());
    serverSocket.on("close", () => clientSocket.destroy());
  }

  /**
   * 解析目标 URL（与 HttpProxy 一致）
   * 兼容两种客户端写法：
   *  - 代理显式：GET http://example.com/path -> 直接 new URL
   *  - 直连写法：GET /path + Host: example.com -> 拼 http://Host/path
   * 尊重 x-forwarded-proto，用于上游已做 TLS 终止的场景
   * @param req - 入站请求
   * @returns 合法 URL 或 null（缺少 Host 或格式错误）
   */
  private resolveTargetUrl(req: http.IncomingMessage): URL | null {
    const raw = req.url ?? ""; // 原始请求行 URL
    try {
      if (/^https?:\/\//i.test(raw)) return new URL(raw); // 显式代理写法直接解析
      const host = req.headers.host; // 直连写法需 Host 头
      if (!host) return null;
      const proto = (req.headers["x-forwarded-proto"] as string) || "http:"; // 尊重上游终止头
      const prefix = proto.endsWith(":") ? proto : `${proto}:`;
      return new URL(`${prefix}//${host}${raw.startsWith("/") ? raw : `/${raw}`}`);
    } catch {
      return null; // 格式错误视为非法
    }
  }
}

export function createHttpsProxy(options?: ProxyOptions): HttpsProxy {
  return new HttpsProxy(options);
}
