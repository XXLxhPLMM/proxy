/**
 * HTTP 服务端封装
 * 职责：创建 http.Server，分发普通请求 / CONNECT 隧道，统一错误处理
 * 用法：实例化后赋值 onRequest/onConnect 钩子，调用 start() 启动
 */

import http from "node:http";
import { get } from "@/config/store.js";
import { getLogger } from "@/utils/logger.js";
import { HTTP_400_BAD_REQUEST } from "@/utils/constants.js";
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
  /** 服务级错误钩子（端口占用、监听异常等） */
  onError?: ErrorHandler;
  /** 服务关闭钩子 */
  onClose?: () => void;
  /** 服务启动成功钩子 */
  onListening?: () => void;

  /**
   * @param options.host - 监听 IP，缺省从 store 读取
   * @param options.port - 监听端口，缺省从 store 读取
   */
  constructor(options?: { host?: string; port?: number }) {
    this._host = options?.host ?? get("host");
    this._port = options?.port ?? get("port");

    // 创建 HTTP 服务，普通请求走 onRequest 钩子
    this.server = http.createServer((req, res) => {
      this.onRequest?.(req, res);
    });

    // CONNECT 方法（代理场景：客户端发 CONNECT 建立隧道）
    this.server.on("connect", (req, socket, head) => {
      this.onConnect?.(req, socket, head);
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
      log.warn("client error", err);
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

  /** 启动监听，已启动则直接 resolve */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._started) {
        resolve();
        return;
      }
      this.server.once("listening", resolve);
      this.server.once("error", reject);
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
