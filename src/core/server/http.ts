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
import {
  associateRequestTerminal,
  createRequestTerminal,
  requestTerminalFor,
} from "@/core/request-terminal.js";
import type { RequestTerminal } from "@/core/request-terminal.js";
import { checkClientIp } from "@/config/acl.js";
import type { PipeEvent, PipeEventSink } from "@/core/types/pipe.js";
import type { AuthResult, ProxyOptions, ProxyProtocol } from "@/core/types/proxy.js";
import { getAuthority, getSocketAddress } from "@/utils/ip.js";
import { listenAsync } from "@/utils/net.js";
import {
  HEADER_NAME_PROXY_AUTHENTICATE,
  HEADER_PROXY_AUTHENTICATE,
  HTTP_400_BAD_REQUEST,
  HTTP_403_FORBIDDEN,
  HTTP_407_PROXY_AUTH_REQUIRED,
  REASON_FORBIDDEN,
  REASON_PROXY_AUTH_REQUIRED,
  STATUS_FORBIDDEN,
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
    await listenAsync(server, this.options.port, this.options.host);
    this.server = server;
  }

  /**
   * 关服：close 当前 server 并置空
   * 主动断开存量 keep-alive/隧道连接，否则 server.close 的回调要等这些连接自然结束才触发
   * （close + 排空收口在基类 `closeServer` 模板）
   * 无 server 时直接返回（幂等）
   */
  protected async doStop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = null;
    await this.closeServer(server);
  }

  /**
   * 绑定 server 事件：request/connect/upgrade 主链路 + error/clientError/close/listening
   * HttpsProxy 复用本方法，仅传入 https.Server（as http.Server）
   * @param server - 已创建但未 listen 的 HTTP 服务实例
   */
  protected bindServer(server: http.Server): void {
    server.on("connection", (socket: Duplex) => {
      this.registry.track(socket);
    });
    server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
      void this.handleForward("http", req, req.socket as unknown as Duplex, res, (sink, terminal) =>
        forwardHttp(req, res, sink, this.options.config, terminal),
      );
    });
    server.on("connect", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleForward("tunnel", req, socket, socket, (sink, terminal) =>
        forwardTunnel(req, socket, head, sink, this.options.config, terminal),
      );
    });
    server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleForward("upgrade", req, socket, socket, (sink, terminal) =>
        forwardUpgrade(req, socket, head, sink, this.options.config, terminal),
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
      const existing = requestTerminalFor(socket);
      const terminal =
        existing !== undefined && !existing.settled
          ? existing
          : createRequestTerminal(this.options.config, this.protocol, {
              client: getSocketAddress(socket),
            });
      terminal.reject("malformed-request", "parse", 400);
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
   * 统一转发入口：先过客户端名单，再鉴权，失败直接回绝；通过则发 forward 事件并执行委派
   * 委派抛同步错/鉴权抛错统一转 forwardError 事件，不向上传播
   * @param kind - 通道类型：http（普通请求）/tunnel（CONNECT）/upgrade（websocket）
   * @param req - 原始 IncomingMessage，用于鉴权与 forward 事件
   * @param socket - 客户端底层双工流
   * @param rejectTarget - 回绝时的回写目标（http 用 res，tunnel/upgrade 用 socket）
   * @param forward - 实际转发闭包（forwardHttp/forwardTunnel/forwardUpgrade），接收逐请求事件槽
   */
  private async handleForward(
    kind: "http" | "tunnel" | "upgrade",
    req: http.IncomingMessage,
    socket: Duplex,
    rejectTarget: http.ServerResponse | Duplex,
    forward: (sink: PipeEventSink, terminal: RequestTerminal) => void,
  ): Promise<void> {
    const client = getSocketAddress(socket);
    const target = getAuthority(req);
    const terminal = createRequestTerminal(this.options.config, this.protocol, {
      client,
      ...(target ? { target } : {}),
    });
    associateRequestTerminal(req, terminal);
    associateRequestTerminal(socket, terminal);

    try {
      // 客户端名单最先判定：被禁来源不该消耗鉴权与转发资源（只认 TCP 对端地址，不看可伪造的 XFF）
      const ip = checkClientIp(client, this.options.config);
      if (!ip.allowed) {
        this.emit("pipe", {
          type: "ip-denied",
          client,
          reason: ip.reason,
          protocol: this.protocol,
        });
        this.writeIpRejected(rejectTarget);
        terminal.reject(ip.reason ?? "client-denied", "access", 403);
        return;
      }

      const auth = await this.authorizeOrReject(req, socket, rejectTarget);
      if (!auth.passed) {
        terminal.reject("proxy-auth-required", "auth", 407);
        return;
      }
      if (auth.username !== undefined) {
        terminal.setContext({ user: auth.username });
      }

      // 逐请求事件槽：把身份并入该请求的所有 pipe 事件（含转发层内部抛出的 route/upstream-error），
      // 每次请求新建闭包，绝不把用户名存进共享单例（并发会话会互相串号）
      const sink: PipeEventSink = auth.username
        ? (e) => this.emit("pipe", { ...e, user: auth.username })
        : this.pipeSink;

      this.emit("forward", { kind, req, username: auth.username });
      forward(sink, terminal);
    } catch (err) {
      terminal.fail(err, "forward");
      this.emit("forwardError", { kind, error: err });
    }
  }

  /**
   * 拒绝回写模板：http 通道经 `ServerResponse` 写状态行 + 正文，tunnel/upgrade 通道往 `Duplex` 写预拼原始报文
   * （两处 `"writeHead" in target` 分支收口于此）
   * @param target - http 通道为 ServerResponse，tunnel/upgrade 通道为 Duplex
   * @param opts - `status`/`headers`/`body` 走 http 通道，`raw` 走裸 socket 通道
   */
  private writeRejected(
    target: http.ServerResponse | Duplex,
    opts: { status: number; headers?: Record<string, string>; body: string; raw: string },
  ): void {
    if ("writeHead" in target) {
      target.writeHead(opts.status, opts.headers);
      target.end(opts.body);
    } else {
      target.end(opts.raw);
    }
  }

  /**
   * 鉴权失败回写：http 通道回 407 + Proxy-Authenticate 头，tunnel/upgrade 直接断流
   * 通过 "writeHead" in target 区分 res 与 Duplex
   * @param target - http 通道为 ServerResponse，tunnel/upgrade 通道为 Duplex
   */
  protected writeAuthRejected(target: http.ServerResponse | Duplex): void {
    this.writeRejected(target, {
      status: STATUS_PROXY_AUTH_REQUIRED,
      headers: { [HEADER_NAME_PROXY_AUTHENTICATE]: HEADER_PROXY_AUTHENTICATE },
      body: REASON_PROXY_AUTH_REQUIRED,
      raw: HTTP_407_PROXY_AUTH_REQUIRED,
    });
  }

  /**
   * 访问控制拒绝回写：http 通道回 403，tunnel/upgrade 写原始 403 报文后断流
   * 与 407 明确区分：名单拒绝与凭证无关，回 407 会诱导客户端反复重试带凭证
   * @param target - http 通道为 ServerResponse，tunnel/upgrade 通道为 Duplex
   */
  protected writeIpRejected(target: http.ServerResponse | Duplex): void {
    this.writeRejected(target, {
      status: STATUS_FORBIDDEN,
      body: REASON_FORBIDDEN,
      raw: HTTP_403_FORBIDDEN,
    });
  }

  /**
   * 鉴权并在失败时回绝：组装 AuthContext 调基类 authorize()
   * @param req - 原始请求，用于提取 Proxy-Authorization 头
   * @param socket - 客户端双工流，透传给 AuthContext
   * @param rejectTarget - 失败时的回写目标，语义同 writeAuthRejected
   * @returns 鉴权结果（含命中账号的用户名），失败已回写
   */
  protected async authorizeOrReject(
    req: http.IncomingMessage,
    socket: Duplex,
    rejectTarget: http.ServerResponse | Duplex,
  ): Promise<AuthResult> {
    const result = await this.authorize({
      protocol: this.protocol,
      req,
      socket,
      authority: getAuthority(req),
    });
    if (!result.passed) {
      this.writeAuthRejected(rejectTarget);
    }
    return result;
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
