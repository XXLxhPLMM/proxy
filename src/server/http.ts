/**
 * HTTP 代理核心 - 基于 HttpServer + HttpPipe 实现
 * 职责：
 * - 继承 BaseProxy，复用 auth + 生命周期状态机
 * - 使用 core/HttpServer 管理 http.Server
 * - 使用 core/forwardHttp/forwardTunnel 处理请求转发
 * - 钩子内做鉴权，通过后委托 pipe 转发
 */

import type { Duplex } from "node:stream";
import { BaseProxy } from "../core/base.js";
import { HttpServer } from "../core/http-server.js";
import { forwardHttp, forwardTunnel } from "../core/http-pipe.js";
import type { ProxyOptions } from "../core/types.js";
import { getLogger } from "../utils/logger.js";
import { getClientAddress, getAuthority } from "../utils/ip.js";
import { HTTP_407_PROXY_AUTH_REQUIRED } from "../utils/constants.js";

/** Server 公共接口 - HttpServer 与 HttpsServer 均满足 */
interface ServerLike {
  onRequest?: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;
  onConnect?: (req: import("node:http").IncomingMessage, socket: Duplex, head: Buffer) => void;
  onError?: (err: Error) => void;
  start(): Promise<void>;
  close(): Promise<void>;
  readonly started: boolean;
}

/**
 * HTTP 代理实现类
 * 继承 BaseProxy，协议固定为 "http"
 * 内部持有 server 实例（HttpServer 或 HttpsServer），通过钩子分发请求到 HttpPipe
 */
export class HttpProxy extends BaseProxy {
  protected readonly log = getLogger("HttpProxy");
  protected proxyServer: ServerLike | null = null;

  constructor(options: ProxyOptions = {}) {
    super("http", options);
  }

  async onStarted(): Promise<void> {
    this.log.info(`[lifecycle] ${this.protocol} started ${this.options.host}:${this.options.port} state=${this.state}`);
  }

  async onBeforeStop(): Promise<void> {
    this.log.info(`[lifecycle] ${this.protocol} stopping ${this.options.host}:${this.options.port}`);
  }

  /**
   * 真实建服：创建 HttpServer 并挂载分发钩子
   * 注意：this.server 字段仅为满足 BaseProxy 类型约束，实际生命周期由 proxyServer 管理
   */
  protected async doStart(): Promise<void> {
    this.proxyServer = new HttpServer({
      host: this.options.host as string,
      port: this.options.port as number,
    });

    this.setupHooks();
    await this.proxyServer.start();
    this.server = this.proxyServer as unknown as import("node:http").Server;
  }

  /** 真实关服：关闭 proxyServer 并清空引用，允许重入 start */
  protected async doStop(): Promise<void> {
    if (!this.proxyServer) return;
    await this.proxyServer.close();
    this.proxyServer = null;
    this.server = null;
  }

  isRunning(): boolean {
    return this.proxyServer?.started ?? false;
  }

  /**
   * 统一挂载钩子 - 子类可复用（HttpsProxy 换 server 后仍调用本方法）
   * request / connect 事件均先走「鉴权 + 转发」包装，异步异常统一捕获记日志，避免击穿进程
   */
  protected setupHooks(): void {
    this.proxyServer!.onRequest = (req, res) => {
      this.authorizeAndForwardHttp(req, res).catch((err) => {
        this.log.error("forwardHttp error", err);
      });
    };

    this.proxyServer!.onConnect = (req, socket, head) => {
      this.authorizeAndForwardTunnel(req, socket, head).catch((err) => {
        this.log.error("forwardTunnel error", err);
      });
    };

    this.proxyServer!.onError = (err) => {
      this.setState("error");
      this.log.error(`server error (${this.options.host}:${this.options.port}):`, err);
    };
  }

  /**
   * 写入 407 鉴权失败响应
   * 统一处理 res（ServerResponse）和 socket（Duplex）两种场景
   */
  protected writeAuthRejected(
    target: import("node:http").ServerResponse | Duplex,
    destroy = false,
  ): void {
    if ("writeHead" in target) {
      target.writeHead(407, { "Proxy-Authenticate": "Basic realm=\"Proxy\"" });
      target.end("Proxy Authentication Required");
    } else {
      target.write(HTTP_407_PROXY_AUTH_REQUIRED);
      if (destroy) target.destroy();
    }
  }

  /**
   * 鉴权 + 普通 HTTP 转发（GET/POST 等 absolute-form 或 origin-form 请求）
   * 流程：提取客户端 IP 与目标 -> 记录访问日志 -> 基类 authorize ->
   *       通过则委托 forwardHttp 走上游管道，失败则回 407
   */
  protected async authorizeAndForwardHttp(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const clientAddr = getClientAddress(req);
    const targetHint = req.url ?? req.headers.host ?? "-"; // 日志用目标提示：优先请求行 URL，退化 Host 头
    this.log.debug(`[http] headers ${clientAddr} -> ${targetHint} ${JSON.stringify(req.headers)}`);
    this.log.info(`[forward] ${clientAddr} -> ${targetHint} ${req.method ?? "GET"}`);

    const passed = await this.authorize({
      protocol: this.protocol,
      req,
      socket: req.socket as unknown as Duplex,
      authority: getAuthority(req),
    });
    if (!passed) {
      this.writeAuthRejected(res);
      return;
    }

    forwardHttp(req, res);
  }

  /**
   * 鉴权 + CONNECT 隧道转发
   * 与 HTTP 分支的区别：鉴权失败时直接向 socket 写 407 报文并销毁（无 ServerResponse 可用）；
   * 通过后由 forwardTunnel 向上游拨号、回 200 后双向 pipe
   */
  protected async authorizeAndForwardTunnel(
    req: import("node:http").IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const clientAddr = getClientAddress(req);
    const authority = getAuthority(req);
    this.log.debug(() => `[tunnel] headers ${clientAddr} -> ${authority} ${JSON.stringify(req.headers)}`);
    this.log.info(`[tunnel] ${clientAddr} -> ${authority} CONNECT`);

    const passed = await this.authorize({
      protocol: this.protocol,
      req,
      socket,
      authority,
    });
    if (!passed) {
      this.writeAuthRejected(socket, true);
      return;
    }

    forwardTunnel(req, socket, head);
  }
}

export function createHttpProxy(options?: ProxyOptions): HttpProxy {
  return new HttpProxy(options);
}
