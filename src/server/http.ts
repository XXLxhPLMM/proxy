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
import { BaseProxy } from "@/core/server/base.js";
import { HttpServer } from "@/core/server/http.js";
import { forwardHttp } from "@/core/forward/http.js";
import { forwardTunnel } from "@/core/forward/tunnel.js";
import { forwardUpgrade } from "@/core/forward/websocket.js";
import type { PipeEvent } from "@/core/types/pipe.js";
import type {
  ProxyHttpServer,
  ProxyOptions,
  ProxyProtocol,
} from "@/core/types/proxy.js";
import { HTTP_400_BAD_REQUEST } from "@/utils/constants.js";
import { getAuthority } from "@/utils/ip.js";
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

  /** 管道事件转抛：forward 纯函数无 emit，借本实例事件通道向外抛 */
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
   * 统一转发入口：鉴权守卫 -> forward 事件 -> 委托具体 forward 函数
   * - 鉴权失败由 authorizeOrReject 回写 407（http 走 res，tunnel/upgrade 走 socket）后直接返回
   * - forward 事件在鉴权通过后才发——407 拒绝的请求由 auth deny 覆盖，
   *   不该再冒充 forward 记录（否则审计出现 deny+forward 矛盾双记）
   * - 异常兜底转抛 forwardError 事件，避免击穿进程
   */
  private async handleForward(
    kind: "http" | "tunnel" | "upgrade",
    req: import("node:http").IncomingMessage,
    socket: Duplex,
    rejectTarget: import("node:http").ServerResponse | Duplex,
    forward: () => void,
  ): Promise<void> {
    try {
      if (!(await this.authorizeOrReject(req, socket, rejectTarget))) return;
      this.emit("forward", { kind, req });
      forward();
    } catch (err) {
      this.emit("forwardError", { kind, error: err });
    }
  }

  /**
   * 统一挂载钩子 - 子类可复用（HttpsProxy 换 server 后仍调用本方法）
   * request / connect / upgrade 事件均先走「鉴权 + 转发」，异常经 handleForward 兜底转抛
   */
  protected setupHooks(): void {
    this.proxyServer!.onRequest = (req, res) => {
      void this.handleForward("http", req, req.socket as unknown as Duplex, res, () =>
        forwardHttp(req, res, this.pipeSink),
      );
    };

    this.proxyServer!.onConnect = (req, socket, head) => {
      void this.handleForward("tunnel", req, socket, socket, () =>
        forwardTunnel(req, socket, head, this.pipeSink),
      );
    };

    this.proxyServer!.onUpgrade = (req, socket, head) => {
      void this.handleForward("upgrade", req, socket, socket, () =>
        forwardUpgrade(req, socket, head, this.pipeSink),
      );
    };

    this.proxyServer!.onError = (err) => {
      this.setState("error");
      this.emit("serverError", {
        error: err,
        host: this.options.host,
        port: this.options.port,
      });
    };

    // transport 抛上来的客户端错误：转抛 + 回 400 保活（日志由 ProxyServer 记）
    this.proxyServer!.onClientError = (err, socket) => {
      this.emit("clientError", { error: err });
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
   * 鉴权守卫：authorize 通过与否决定是否回 407
   * - 鉴权失败统一向 rejectTarget 回写 407（http 走 ServerResponse，tunnel/upgrade 走 socket）
   * - 通过返回 true，调用方继续转发；拒绝场景由 auth deny 事件覆盖审计
   * @returns 是否放行
   */
  protected async authorizeOrReject(
    req: import("node:http").IncomingMessage,
    socket: Duplex,
    rejectTarget: import("node:http").ServerResponse | Duplex,
  ): Promise<boolean> {
    const passed = await this.authorize({
      protocol: this.protocol,
      req,
      socket,
      authority: getAuthority(req),
    });
    if (!passed) this.writeAuthRejected(rejectTarget);
    return passed;
  }
}

export function createHttpProxy(options?: ProxyOptions): HttpProxy {
  return new HttpProxy(options);
}
