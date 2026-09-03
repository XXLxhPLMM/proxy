/**
 * HTTP 代理核心 - 基于 HttpServer + HttpPipe 实现
 * 职责：
 * - 继承 BaseProxy，复用 auth + 生命周期状态机
 * - 使用 core/HttpServer 管理 http.Server
 * - 使用 core/forwardHttp/forwardTunnel 处理请求转发
 * - 钩子内做鉴权，通过后委托 pipe 转发
 * 注意：本层零日志——转发/错误/鉴权审计全经事件向外抛（forward/forwardError/serverError/clientError/auth），
 *       日志由 ProxyServer 统一订阅；407/400 回写与掐连接是协议动作，保留
 */

import type { Duplex } from "node:stream";
import { BaseProxy } from "@/core/base.js";
import { HttpServer } from "@/core/http-server.js";
import { forwardHttp, forwardTunnel, forwardUpgrade } from "@/core/http-pipe.js";
import type { PipeEvent } from "@/core/types/pipe.js";
import type {
  ProxyClientErrorEvent,
  ProxyForwardErrorEvent,
  ProxyForwardEvent,
  ProxyHttpServer,
  ProxyOptions,
  ProxyProtocol,
  ProxyServerErrorEvent,
} from "@/core/types/proxy.js";
import { HTTP_400_BAD_REQUEST } from "@/utils/constants.js";
import { getClientAddress, getAuthority } from "@/utils/ip.js";
import {
  HEADER_NAME_PROXY_AUTHENTICATE,
  HEADER_PROXY_AUTHENTICATE,
  HTTP_407_PROXY_AUTH_REQUIRED,
  REASON_PROXY_AUTH_REQUIRED,
  STATUS_PROXY_AUTH_REQUIRED,
} from "@/utils/constants.js";

/**
 * HTTP 代理实现类
 * 继承 BaseProxy，协议固定为 "http"
 * 内部持有 server 实例（HttpServer 或 HttpsServer），通过钩子分发请求到 HttpPipe
 */
export class HttpProxy extends BaseProxy {
  protected proxyServer: ProxyHttpServer | null = null;

  constructor(options: ProxyOptions = {}, protocol: ProxyProtocol = "http") {
    super(protocol, options);
  }

  /** 管道事件转抛：http-pipe 纯函数无 emit，借本实例事件通道向外抛 */
  private pipeSink = (e: PipeEvent): void => {
    this.emit("pipe", e);
  };

  /**
   * 真实建服：创建 HttpServer 并挂载分发钩子
   * 注意：生命周期由 proxyServer（HttpServer 包装类）管理，不借用基类 server 字段
   * （基类 stopServer/attachErrorHandlers 只服务于 tls/socks 的裸 server，http 链用不上）
   */
  protected async doStart(): Promise<void> {
    this.proxyServer = new HttpServer();

    this.setupHooks();
    await this.proxyServer.start();
  }

  /** 真实关服：关闭 proxyServer 并清空引用，允许重入 start */
  protected async doStop(): Promise<void> {
    if (!this.proxyServer) return;
    await this.proxyServer.close();
    this.proxyServer = null;
  }

  isRunning(): boolean {
    return this.proxyServer?.started ?? false;
  }

  /**
   * 统一挂载钩子 - 子类可复用（HttpsProxy 换 server 后仍调用本方法）
   * request / connect 事件均先走「鉴权 + 转发」包装，异步异常转抛 forwardError 事件，避免击穿进程
   */
  protected setupHooks(): void {
    this.proxyServer!.onRequest = (req, res) => {
      this.authorizeAndForwardHttp(req, res).catch((err) => {
        this.emit("forwardError", { kind: "http", error: err } satisfies ProxyForwardErrorEvent);
      });
    };

    this.proxyServer!.onConnect = (req, socket, head) => {
      this.authorizeAndForwardTunnel(req, socket, head).catch((err) => {
        this.emit("forwardError", { kind: "tunnel", error: err } satisfies ProxyForwardErrorEvent);
      });
    };

    this.proxyServer!.onUpgrade = (req, socket, head) => {
      this.authorizeAndForwardUpgrade(req, socket, head).catch((err) => {
        this.emit("forwardError", { kind: "upgrade", error: err } satisfies ProxyForwardErrorEvent);
      });
    };

    this.proxyServer!.onError = (err) => {
      this.setState("error");
      this.emit("serverError", {
        error: err,
        host: this.options.host,
        port: this.options.port,
      } satisfies ProxyServerErrorEvent);
    };

    // transport 抛上来的客户端错误：转抛 + 回 400 保活（日志由 ProxyServer 记）
    this.proxyServer!.onClientError = (err, socket) => {
      this.emit("clientError", { error: err } satisfies ProxyClientErrorEvent);
      try {
        (socket as Duplex).end(HTTP_400_BAD_REQUEST);
      } catch {}
    };

    this.proxyServer!.onClose = () => {
      this.emit("close");
    };

    this.proxyServer!.onListening = () => {
      this.emit("listening", { host: this.options.host, port: this.options.port });
    };
  }

  /**
   * 写入 407 鉴权失败响应
   * 统一处理 res（ServerResponse）和 socket（Duplex）两种场景
   * 注意：socket 侧必须 end() 冲刷 + FIN——对方读到 407 字节才会弹账密框；
   * write 后紧跟 destroy() 会丢字节（RST），浏览器只剩 ERR_PROXY_CONNECTION_FAILED
   */
  protected writeAuthRejected(
    target: import("node:http").ServerResponse | Duplex,
  ): void {
    if ("writeHead" in target) {
      target.writeHead(STATUS_PROXY_AUTH_REQUIRED, { [HEADER_NAME_PROXY_AUTHENTICATE]: HEADER_PROXY_AUTHENTICATE });
      target.end(REASON_PROXY_AUTH_REQUIRED);
    } else {
      target.end(HTTP_407_PROXY_AUTH_REQUIRED);
    }
  }

  /**
   * 鉴权 + 普通 HTTP 转发（GET/POST 等 absolute-form 或 origin-form 请求）
   * 流程：抛 forward 事件 -> 基类 authorize（内转抛 auth 审计事件）->
   *       通过则委托 forwardHttp 走上游管道，失败则回 407
   */
  protected async authorizeAndForwardHttp(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const clientAddr = getClientAddress(req);
    const targetHint = req.url ?? req.headers.host ?? "-"; // 事件用目标提示：优先请求行 URL，退化 Host 头
    this.emit("forward", {
      kind: "http",
      client: clientAddr,
      target: targetHint,
      method: req.method ?? "GET",
      headers: req.headers,
    } satisfies ProxyForwardEvent);

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

    forwardHttp(req, res, this.pipeSink);
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
    this.emit("forward", {
      kind: "tunnel",
      client: clientAddr,
      target: authority,
      method: "CONNECT",
      headers: req.headers,
    } satisfies ProxyForwardEvent);

    const passed = await this.authorize({
      protocol: this.protocol,
      req,
      socket,
      authority,
    });
    if (!passed) {
      this.writeAuthRejected(socket);
      return;
    }

    forwardTunnel(req, socket, head, this.pipeSink);
  }

  /**
   * 鉴权 + WebSocket/Upgrade 转发
   * 与 CONNECT 隧道类似，鉴权失败时销毁 socket；通过后由 forwardUpgrade 转发升级请求
   */
  protected async authorizeAndForwardUpgrade(
    req: import("node:http").IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const clientAddr = getClientAddress(req);
    const target = req.url ?? req.headers.host ?? "-";
    this.emit("forward", {
      kind: "upgrade",
      client: clientAddr,
      target,
      method: req.method ?? "GET",
      headers: req.headers,
    } satisfies ProxyForwardEvent);

    const passed = await this.authorize({
      protocol: this.protocol,
      req,
      socket,
      authority: getAuthority(req),
    });
    if (!passed) {
      this.writeAuthRejected(socket);
      return;
    }

    forwardUpgrade(req, socket, head, this.pipeSink);
  }
}

export function createHttpProxy(options?: ProxyOptions): HttpProxy {
  return new HttpProxy(options);
}
