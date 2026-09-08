/**
 * HTTP 代理 - 直持 http.Server，鉴权后委派 forward/*
 * 职责：
 * - 建服：http.createServer + 监听 request/connect/upgrade 三通道
 * - 鉴权：authorizeOrReject 不通过即回 407/断流，不进转发
 * - 委派：http -> forwardHttp，tunnel -> forwardTunnel，upgrade -> forwardUpgrade
 * - 事件：forward/forwardError/serverError/clientError/pipe/listening/close 统一外抛
 * 设计：HttpsProxy 复用本类 bindServer/handleForward，仅重写 doStart 建 TLS 服
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import { BaseProxy } from "@/core/server/base.js";
import { forwardHttp } from "@/core/forward/http.js";
import { forwardTunnel } from "@/core/forward/tunnel.js";
import { forwardUpgrade } from "@/core/forward/websocket.js";
import type { PipeEvent } from "@/core/types/pipe.js";
import type { ProxyOptions, ProxyProtocol } from "@/core/types/proxy.js";
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
 * HTTP 代理实现：BaseProxy 的 http 分支
 * HttpsProxy 继承本类，仅替换建服时的 server 为 https.Server
 */
export class HttpProxy extends BaseProxy {
  /** 底层 HTTP 服务实例，未启动为 null，stop 后置空 */
  protected server: http.Server | null = null;

  /**
   * 构造 HTTP 代理
   * @param options - 监听地址/端口与鉴权等选项，缺省由 BaseProxy 归一化
   * @param protocol - 协议标识，默认 http，HttpsProxy 透传 https
   */
  constructor(options: ProxyOptions = {}, protocol: ProxyProtocol = "http") {
    super(protocol, options);
  }

  /**
   * pipe 事件槽：forward 层 PipeEvent 转抛为本实例 pipe 事件
   * 由 forwardHttp/forwardTunnel/forwardUpgrade 回调注入
   */
  private pipeSink = (e: PipeEvent): void => {
    this.emit("pipe", e);
  };

  /**
   * 建服：创建 http.Server 并 listen
   * 成功后写入 this.server；启动期 error 直接 reject 由基类转 error 态
   * @throws listen 失败（如 EADDRINUSE）时抛错
   */
  protected async doStart(): Promise<void> {
    const server = http.createServer();
    this.bindServer(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  /**
   * 关服：close 当前 server 并置空
   * 无 server 时直接返回（幂等）
   */
  protected async doStop(): Promise<void> {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.server!.close(() => {
        resolve();
      });
    });
    this.server = null;
  }

  /**
   * 是否处于监听态
   * @returns server 非空且 listening 为 true
   */
  isRunning(): boolean {
    return !!this.server?.listening;
  }

  /**
   * 绑定 server 事件：request/connect/upgrade 主链路 + error/clientError/close/listening
   * HttpsProxy 复用本方法，仅传入 https.Server（as http.Server）
   * @param server - 已创建但未 listen 的 HTTP 服务实例
   */
  protected bindServer(server: http.Server): void {
    server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
      void this.handleForward("http", req, req.socket as unknown as Duplex, res, () =>
        forwardHttp(req, res, this.pipeSink),
      );
    });
    server.on("connect", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleForward("tunnel", req, socket, socket, () =>
        forwardTunnel(req, socket, head, this.pipeSink),
      );
    });
    server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleForward("upgrade", req, socket, socket, () =>
        forwardUpgrade(req, socket, head, this.pipeSink),
      );
    });
    server.on("error", (err: Error) => {
      this.setState("error");
      this.emit("serverError", {
        error: err,
        host: this.options.host,
        port: this.options.port,
      });
    });
    server.on("clientError", (err: Error, socket: Duplex) => {
      this.emit("clientError", { error: err });
      try {
        (socket as Duplex).end(HTTP_400_BAD_REQUEST);
      } catch {
        // 忽略 socket 结束异常
      }
    });
    server.on("close", () => {
      this.emit("close");
    });
    server.on("listening", () => {
      this.emit("listening", {
        host: this.options.host,
        port: this.options.port,
      });
    });
  }

  /**
   * 统一转发入口：先鉴权，失败直接回绝；通过则发 forward 事件并执行委派
   * 委派抛同步错/鉴权抛错统一转 forwardError 事件，不向上传播
   * @param kind - 通道类型：http（普通请求）/tunnel（CONNECT）/upgrade（websocket）
   * @param req - 原始 IncomingMessage，用于鉴权与 forward 事件
   * @param socket - 客户端底层双工流
   * @param rejectTarget - 鉴权失败时的回写目标（http 用 res，tunnel/upgrade 用 socket）
   * @param forward - 实际转发闭包（forwardHttp/forwardTunnel/forwardUpgrade）
   */
  private async handleForward(
    kind: "http" | "tunnel" | "upgrade",
    req: http.IncomingMessage,
    socket: Duplex,
    rejectTarget: http.ServerResponse | Duplex,
    forward: () => void,
  ): Promise<void> {
    try {
      const passed = await this.authorizeOrReject(req, socket, rejectTarget);
      if (!passed) {
        return;
      }
      this.emit("forward", { kind, req });
      forward();
    } catch (err) {
      this.emit("forwardError", { kind, error: err });
    }
  }

  /**
   * 鉴权失败回写：http 通道回 407 + Proxy-Authenticate 头，tunnel/upgrade 直接断流
   * 通过 "writeHead" in target 区分 res 与 Duplex
   * @param target - http 通道为 ServerResponse，tunnel/upgrade 通道为 Duplex
   */
  protected writeAuthRejected(target: http.ServerResponse | Duplex): void {
    if ("writeHead" in target) {
      target.writeHead(STATUS_PROXY_AUTH_REQUIRED, {
        [HEADER_NAME_PROXY_AUTHENTICATE]: HEADER_PROXY_AUTHENTICATE,
      });
      target.end(REASON_PROXY_AUTH_REQUIRED);
    } else {
      target.end(HTTP_407_PROXY_AUTH_REQUIRED);
    }
  }

  /**
   * 鉴权并在失败时回绝：组装 AuthContext 调基类 authorize()
   * @param req - 原始请求，用于提取 Proxy-Authorization 头
   * @param socket - 客户端双工流，透传给 AuthContext
   * @param rejectTarget - 失败时的回写目标，语义同 writeAuthRejected
   * @returns 通过返回 true，失败已回写并返回 false
   */
  protected async authorizeOrReject(
    req: http.IncomingMessage,
    socket: Duplex,
    rejectTarget: http.ServerResponse | Duplex,
  ): Promise<boolean> {
    const passed = await this.authorize({
      protocol: this.protocol,
      req,
      socket,
      authority: getAuthority(req),
    });
    if (!passed) {
      this.writeAuthRejected(rejectTarget);
    }
    return passed;
  }
}

/**
 * 快捷构造 HTTP 代理（免 new）
 * @param options - 同 HttpProxy 构造选项，缺省为空（走 3000/0.0.0.0 默认）
 * @returns 未启动的 HttpProxy 实例
 */
export function createHttpProxy(options?: ProxyOptions): HttpProxy {
  return new HttpProxy(options);
}
