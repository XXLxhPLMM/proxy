/**
 * HTTPS 服务端封装
 * 职责：创建 https.Server，分发普通请求 / CONNECT 隧道，统一错误处理
 * 用法：实例化后赋值 onRequest/onConnect 钩子，调用 start() 启动
 * 与 HttpServer 的区别：基于 TLS，需要提供证书/私钥
 */

import https from "node:https";
import fs from "node:fs";
import { get } from "@/config/store.js";
import { getLogger } from "@/utils/logger.js";
import { HTTP_400_BAD_REQUEST } from "@/utils/constants.js";
import { logBadRequest } from "@/utils/log-events.js";
import type { Socket } from "node:net";

const log = getLogger("HttpsServer");

/** 普通 HTTP 请求回调 */
export type RequestHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) => void;

/**
 * CONNECT 隧道请求回调
 * @param req - 原始 HTTP 请求
 * @param socket - 与客户端之间的双工流（隧道建立后由调用方接管）
 * @param head - CONNECT 头之后客户端发来的第一个数据包（通常为空）
 */
export type ConnectHandler = (
  req: import("node:http").IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
) => void;

/** 通用错误回调 */
export type ErrorHandler = (err: Error) => void;

/**
 * WebSocket/Upgrade 升级请求回调
 * @param req - 原始 HTTP 请求
 * @param socket - 与客户端之间的双工流
 * @param head - Upgrade 头之后客户端发来的第一个数据包
 */
export type UpgradeHandler = (
  req: import("node:http").IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
) => void;

/** TLS 配置 */
export interface TlsOptions {
  /** 私钥路径，缺省从 store 读取 */
  key?: string;
  /** 证书路径，缺省从 store 读取 */
  cert?: string;
  /** CA 证书路径（mTLS 场景），缺省从 store 读取 */
  ca?: string;
  /** 私钥口令 */
  passphrase?: string;
}

/** 实例化选项 */
export interface HttpsServerOptions {
  host?: string;
  port?: number;
  tls?: TlsOptions;
  headersTimeout?: number;
  requestTimeout?: number;
  keepAliveTimeout?: number;
}

/**
 * HTTPS 服务端包装类
 * 与 HttpServer 同构（相同的钩子属性与事件绑定），差别仅在底层用 https.createServer，
 * 构造时同步读取 key/cert/ca 并传给 TLS 上下文；证书缺失会在此抛错，阻断启动
 */
export class HttpsServer {
  private server: https.Server;
  private _host: string;
  private _port: number;
  /** 监听态标记，由 listening/close 事件维护，供 started 与幂等 start/close 判断 */
  private _started = false;
  /** 跟踪活跃连接，停机时强制销毁（与 HttpServer 对齐，否则隧道存活时 close 悬空） */
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
   * @param options.tls - TLS 证书配置，缺省从 store 读取
   * @param options.headersTimeout/requestTimeout/keepAliveTimeout - 超时旋钮，缺省 Node 默认
   */
  constructor(options?: HttpsServerOptions) {
    this._host = options?.host ?? get("host");
    this._port = options?.port ?? get("port");

    // 读取 TLS 配置，优先用传入值，否则从 store 读取
    const tlsKey = options?.tls?.key ?? get("tlsKey");
    const tlsCert = options?.tls?.cert ?? get("tlsCert");
    const tlsCa = options?.tls?.ca ?? get("tlsCa");
    const tlsPassphrase = options?.tls?.passphrase ?? get("tlsPassphrase");

    // 同步读取证书文件（启动时一次性加载）
    const key = fs.readFileSync(tlsKey);
    const cert = fs.readFileSync(tlsCert);
    const ca = tlsCa ? fs.readFileSync(tlsCa) : undefined;

    // 创建 HTTPS 服务；钩子未挂则回 500/掐连接，避免请求悬空
    this.server = https.createServer({ key, cert, ca, passphrase: tlsPassphrase || undefined }, (req, res) => {
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
      log.debug(`listening on ${this._host}:${this._port} (TLS)`);
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

  /** 关闭服务：先销毁所有活跃连接，再关闭 server，未启动则直接 resolve */
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
