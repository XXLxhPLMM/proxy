/**
 * HTTP(S) 服务端封装 - 传输层独占文件（A+B 瘦身版：无基类平铺 + 最小保活）
 * 职责：建 http/https 裸服 + 转发 request/connect/upgrade/error/clientError/close/listening 给上层钩子
 * 用法：赋值 onRequest/onConnect 后 start()；HttpProxy 持有 ProxyHttpServer 接口
 * 注意：本层零日志，只抛事件；无钩子时最小保活（500/掐连接/400），不记日志；
 *       已砍：连接跟踪（close 不再强杀 keep-alive，长连接下可能挂起）、超时三旋钮
 */

import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { loadTlsContext, type TlsKeyCert } from "@/utils/cert.js";
import { HTTP_400_BAD_REQUEST } from "@/utils/constants.js";

/** 普通 HTTP 请求回调 */
export type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
/** CONNECT 隧道请求回调 */
export type ConnectHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
/** WebSocket/Upgrade 升级请求回调 */
export type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
/** 通用错误回调 */
export type ErrorHandler = (err: Error) => void;
/** 客户端错误回调（畸形包等），由上层决定日志与响应 */
export type ClientErrorHandler = (err: Error, socket: Duplex) => void;

export interface HttpServerOptions {
  host?: string;
  port?: number;
}

/** 实例化选项（HTTPS：证书缺省从 store 读取） */
export interface HttpsServerOptions extends HttpServerOptions {
  tls?: TlsKeyCert;
}

/** 裸服结构收敛：http/https 的 listen/事件形态一致 */
type BareServer = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  listen(port: number, host: string): unknown;
  close(cb: () => void): unknown;
};

/** 父类：装那坨一字不差的样板（字段+钩子+get+start/close），子类只管把裸服建好丢进来 */
class HttpTransport {
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

  /** 事件装配：私房方法，直接用 this，不再经野函数传参 */
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

/** HTTP 服务端：建裸服 + 事件直绑，无他 */
export class HttpServer extends HttpTransport {
  constructor(options?: HttpServerOptions) {
    super(http.createServer() as unknown as BareServer, options);
  }
}

/** HTTPS 服务端：同构，差别仅多一步证书加载（本层不记日志，失败抛带路径的错） */
export class HttpsServer extends HttpTransport {
  constructor(options?: HttpsServerOptions) {
    const tlsKey = options?.tls?.key ?? get("tlsKey");
    const tlsCert = options?.tls?.cert ?? get("tlsCert");
    const tlsCa = options?.tls?.ca ?? get("tlsCa");
    const tlsPassphrase = options?.tls?.passphrase ?? get("tlsPassphrase");

    let certs;
    try {
      certs = loadTlsContext({ key: tlsKey, cert: tlsCert, ca: tlsCa, passphrase: tlsPassphrase });
    } catch (e) {
      throw new Error(
        `HTTPS 证书加载失败 key=${tlsKey} cert=${tlsCert}${tlsCa ? ` ca=${tlsCa}` : ""}: ${(e as Error).message}`,
      );
    }
    const raw = https.createServer({
      key: certs.key,
      cert: certs.cert,
      ca: certs.ca ? [certs.ca] : undefined,
      passphrase: certs.passphrase,
    }) as unknown as BareServer;
    super(raw, options);
  }
}
