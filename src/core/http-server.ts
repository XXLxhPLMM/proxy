/**
 * HTTP 服务端封装
 * 职责：创建 http.Server，分发普通请求 / CONNECT 隧道，统一错误处理
 * 用法：实例化后赋值 onRequest/onConnect 钩子，调用 start() 启动
 */

import http from "node:http";
import { get } from "@/config/store.js";
import { getLogger } from "@/utils/logger.js";
import { HTTP_400_BAD_REQUEST } from "@/utils/constants.js";
import { logBadRequest } from "@/utils/log-events.js";
import type { Socket } from "node:net";

const log = getLogger("HttpServer");

/** 普通 HTTP 请求回调 */
export type RequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

/**
 * CONNECT 隧道请求回调
 * @param req - 原始 HTTP 请求
 * @param socket - 与客户端之间的双工流（隧道建立后由调用方接管）
 * @param head - CONNECT 头之后客户端发来的第一个数据包（通常为空）
 */
export type ConnectHandler = (
  req: http.IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
) => void;

/**
 * WebSocket/Upgrade 升级请求回调
 * @param req - 原始 HTTP 请求
 * @param socket - 与客户端之间的双工流
 * @param head - Upgrade 头之后客户端发来的第一个数据包
 */
export type UpgradeHandler = (
  req: http.IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
) => void;

/** 通用错误回调 */
export type ErrorHandler = (err: Error) => void;

/**
 * HTTP 服务端包装类
 * 以「钩子属性」暴露 http.Server 的事件：构造时一次性绑定 request/connect/error/clientError/close/listening，
 * 调用方只需赋值 onRequest/onConnect/onError，无需接触底层 Server，便于 HttpProxy 复用与替换
 */
export class HttpServer {
  private server: http.Server;
  private _host: string;
  private _port: number;
  /** 监听态标记，由 listening/close 事件维护，供 started 与幂等 start/close 判断 */
  private _started = false;
  /** 跟踪活跃连接，停机时强制销毁 */
  private connections = new Set<Socket>();

  /** 普通 HTTP 请求钩子（GET/POST/PUT 等） */
  onRequest?: RequestHandler;
  /** CONNECT 隧道请求钩子（HTTP 代理场景） */
  onConnect?: ConnectHandler;
  /** Upgrade 升级请求钩子（WebSocket 等场景） */
  onUpgrade?: UpgradeHandler;
  /** 服务级错误钩子（端口占用、监听异常等） */
  onError?: ErrorHandler;
  /** 服务关闭钩子 */
  onClose?: () => void;
  /** 服务启动成功钩子 */
  onListening?: () => void;

  /**
   * @param options.host - 监听 IP，缺省从 store 读取
   * @param options.port - 监听端口，缺省从 store 读取
   * @param options.headersTimeout - 完整请求头超时 ms，缺省 Node 默认（防慢头占连接）
   * @param options.requestTimeout - 整请求超时 ms，缺省 Node 默认
   * @param options.keepAliveTimeout - keep-alive 空闲超时 ms，缺省 Node 默认
   */
  constructor(options?: { host?: string; port?: number; headersTimeout?: number; requestTimeout?: number; keepAliveTimeout?: number }) {
    this._host = options?.host ?? get("host");
    this._port = options?.port ?? get("port");

    // 创建 HTTP 服务，普通请求走 onRequest 钩子；钩子未挂则回 500，避免请求悬空
    this.server = http.createServer((req, res) => {
      if (!this.onRequest) {
        if (!res.headersSent) res.writeHead(500);
        res.end();
        return;
      }
      this.onRequest(req, res);
    });
    if (options?.headersTimeout !== undefined) this.server.headersTimeout = options.headersTimeout;
    if (options?.requestTimeout !== undefined) this.server.requestTimeout = options.requestTimeout;
    if (options?.keepAliveTimeout !== undefined) this.server.keepAliveTimeout = options.keepAliveTimeout;

    // CONNECT 方法（代理场景：客户端发 CONNECT 建立隧道）；钩子未挂直接掐
    this.server.on("connect", (req, socket, head) => {
      if (!this.onConnect) {
        socket.destroy();
        return;
      }
      this.onConnect(req, socket, head);
    });

    // Upgrade 事件（WebSocket 等协议升级场景）；钩子未挂直接掐
    this.server.on("upgrade", (req, socket, head) => {
      if (!this.onUpgrade) {
        socket.destroy();
        return;
      }
      this.onUpgrade(req, socket, head);
    });

    // 服务级错误：端口占用、权限不足等
    this.server.on("error", (err) => {
      log.error("server error", err);
      this.onError?.(err);
    });

    // 跟踪活跃连接，停机时强制销毁
    this.server.on("connection", (socket: Socket) => {
      this.connections.add(socket);
      socket.on("close", () => this.connections.delete(socket));
    });

    // 客户端请求解析失败：畸形 HTTP、非法头部等，直接回 400
    this.server.on("clientError", (err, socket) => {
      logBadRequest(log, `client error: ${err.message}`);
      if (socket.writable) {
        try {
          socket.end(HTTP_400_BAD_REQUEST);
        } catch {}
      }
    });

    // 服务关闭
    this.server.on("close", () => {
      this._started = false;
      log.debug("server closed");
      this.onClose?.();
    });

    // 服务启动成功
    this.server.on("listening", () => {
      this._started = true;
      log.debug(`listening on ${this._host}:${this._port}`);
      this.onListening?.();
    });
  }

  get port(): number {
    return this._port;
  }

  get host(): string {
    return this._host;
  }

  /** 服务是否已启动 */
  get started(): boolean {
    return this._started;
  }

  /** 启动监听，已启动则直接 resolve；成功/失败均摘掉另一路的一次性监听，不泄漏 */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._started) {
        resolve();
        return;
      }
      const onListening = (): void => {
        this.server.removeListener("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        this.server.removeListener("listening", onListening);
        reject(err);
      };
      this.server.once("listening", onListening);
      this.server.once("error", onError);
      this.server.listen(this._port, this._host);
    });
  }

  /** 关闭服务：先销毁所有活跃连接，再关闭 server */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this._started) {
        resolve();
        return;
      }
      for (const socket of this.connections) {
        socket.destroy();
      }
      this.connections.clear();
      this.server.close(() => resolve());
    });
  }
}
