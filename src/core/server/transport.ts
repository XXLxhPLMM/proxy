/**
 * HTTP(S) 传输父类 - 仅服务于 http.ts/https.ts 两个传输文件
 * 边界：本类只承载 HTTP 事件模型（request/connect/upgrade/clientError）；
 *       socks/tls/net 等其他协议服务端不得继承本类，各自在自己的文件里
 *       实现事件绑定（事件形态与 HTTP 完全不同，强行抽象是灾难）
 * 职责：字段+钩子+get+start/close 一字不差的装配，子类只管把裸服建好丢进来
 * 注意：本层零日志，只抛事件；无钩子时最小保活（500/掐连接/400），不记日志；
 *       无连接跟踪（close 不强杀 keep-alive）、无超时旋钮
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { HTTP_400_BAD_REQUEST } from "@/utils/constants.js";
import type { ClientErrorHandler, ConnectHandler, ErrorHandler, HttpServerOptions, RequestHandler, UpgradeHandler } from "../types/server.js";

/** 裸服结构收敛：http/https 的 listen/事件形态一致 */
export type BareServer = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  listen(port: number, host: string): unknown;
  close(cb: () => void): unknown;
};

/** 父类：装那坨一字不差的样板（字段+钩子+get+start/close），子类只管把裸服建好丢进来 */
export class HttpTransport {
  protected readonly server: BareServer;
  private _host: string;
  private _port: number;
  private _started = false;

  onRequest?: RequestHandler;
  onConnect?: ConnectHandler;
  onUpgrade?: UpgradeHandler;
  onError?: ErrorHandler;
  onClientError?: ClientErrorHandler;
  onClose?: () => void;
  onListening?: () => void;

  constructor(server: BareServer, options?: HttpServerOptions) {
    this.server = server;
    this._host = options?.host ?? get("host");
    this._port = options?.port ?? get("port");
    this.bindEvents();
  }

  /** 事件装配：私有方法，直接用 this 挂钩子 */
  private bindEvents(): void {
    this.server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (!this.onRequest) {
        if (!res.headersSent) res.writeHead(500);
        res.end();
        return;
      }
      this.onRequest(req, res);
    });
    this.server.on("connect", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!this.onConnect) {
        socket.destroy();
        return;
      }
      this.onConnect(req, socket, head);
    });
    this.server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!this.onUpgrade) {
        socket.destroy();
        return;
      }
      this.onUpgrade(req, socket, head);
    });
    this.server.on("error", (err: Error) => this.onError?.(err));
    this.server.on("clientError", (err: Error, socket: Duplex) => {
      if (this.onClientError) {
        this.onClientError(err, socket);
        return;
      }
      try {
        (socket as unknown as { writable: boolean; end: (d: string) => void }).end(HTTP_400_BAD_REQUEST);
      } catch {}
    });
    this.server.on("close", () => {
      this._started = false;
      this.onClose?.();
    });
    this.server.on("listening", () => {
      this._started = true;
      this.onListening?.();
    });
  }

  get port(): number {
    return this._port;
  }
  get host(): string {
    return this._host;
  }
  get started(): boolean {
    return this._started;
  }

  /** 启动监听，已启动则直接 resolve；成功/失败互摘一次性监听，不泄漏 */
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
      const onError = (err?: unknown): void => {
        this.server.removeListener("listening", onListening);
        reject((err as Error) ?? new Error("server error on start"));
      };
      this.server.once("listening", onListening);
      this.server.once("error", onError);
      this.server.listen(this._port, this._host);
    });
  }

  /** 关闭服务，未启动直接 resolve */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this._started) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }
}
