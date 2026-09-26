/**
 * HTTP 代理 - 直持 http.Server，鉴权后委派入站适配器
 * 职责：
 * - 建服：http.createServer + 监听 request/connect/upgrade 三通道
 * - 鉴权：authorizeOrReject 不通过即回 407/断流，不进转发
 * - 委派：http -> `handleHttp`，tunnel -> `handleConnect`，upgrade -> `handleUpgrade`
 *   （三者都在 `core/forward/inbound/`，只解析协议与答协议，搬字节交给传输策略）
 * - 事件：forward/forwardError/serverError/clientError/pipe/listening/close 统一外抛
 * 设计：HttpsProxy 复用本类 bindServer/handleForward，仅重写 doStart 建 TLS 服
 * 应答归属（ProtocolResponder）：**入站协议插件是「怎么应答」的所有者**。本类负责
 * 闸门阶段（客户端名单 / 鉴权）的应答——那是转发之前、只有协议字节可写的时刻，
 * 经 {@link HttpProxy.gateResponder} 交出一个符合 `ProtocolResponder` 的实现：
 * 同一通道上「写 ServerResponse」与「往裸 socket 写预拼报文」两形态由它一处收口。
 * 转发阶段的应答由入站适配器侧的应答器负责（`establish` 对 http 通道是空实现：上游响应即应答）。
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import { BaseProxy } from "@/core/server/base.js";
import { handleHttp } from "@/core/forward/inbound/http.js";
import { handleConnect } from "@/core/forward/inbound/tunnel.js";
import { handleUpgrade } from "@/core/forward/inbound/websocket.js";
import type {
  AuthResult,
  PipeEvent,
  PipeEventSink,
  ProxyOptions,
  ProxyProtocol,
} from "@/core/types/proxy.js";
import type { ProtocolResponder } from "@/core/types/plan.js";
import type { ProtocolDeps } from "@/plugins/contracts.js";
import { getAuthority } from "@/utils/addr/request.js";
import { getSocketAddress } from "@/utils/net/socket.js";
import { listenAsync } from "@/utils/net/listen.js";
import {
  HEADER_NAME_PROXY_AUTHENTICATE,
  HEADER_PROXY_AUTHENTICATE,
  HTTP_400_BAD_REQUEST,
  HTTP_403_FORBIDDEN,
  HTTP_407_PROXY_AUTH_REQUIRED,
  HTTP_502_BAD_GATEWAY,
  REASON_FORBIDDEN,
  REASON_PROXY_AUTH_REQUIRED,
  STATUS_FORBIDDEN,
  STATUS_PROXY_AUTH_REQUIRED,
} from "@/utils/protocol/http.js";

/**
 * 闸门拒绝的报文形态表：状态码 → 各通道怎么写
 * @description http 通道经 `ServerResponse`（writeHead + 正文），tunnel/upgrade 通道往裸
 * socket 写预拼报文；两形态逐字保持既有输出（403 与 407 必须区分：名单拒绝回 407 会诱导
 * 客户端反复重试带凭证）。刻意用 `Map` 而非对象字面量：这是一张**封闭键集**的查表，
 * `get` 天然不会命中 `Object.prototype` 上的继承属性，未登记码一律 miss（走 502 兜底）。
 * 核心零日志、无内联魔数：状态码与报文全部取自 `utils/protocol/http`。
 */
const GATE_REJECT_REPLY = new Map<
  number,
  { headers?: Record<string, string>; body: string; raw: string }
>([
  [
    STATUS_PROXY_AUTH_REQUIRED,
    {
      headers: { [HEADER_NAME_PROXY_AUTHENTICATE]: HEADER_PROXY_AUTHENTICATE },
      body: REASON_PROXY_AUTH_REQUIRED,
      raw: HTTP_407_PROXY_AUTH_REQUIRED,
    },
  ],
  [
    STATUS_FORBIDDEN,
    {
      body: REASON_FORBIDDEN,
      raw: HTTP_403_FORBIDDEN,
    },
  ],
]);

/**
 * HTTP 代理实现：BaseProxy 的 http 分支
 * HttpsProxy 继承本类，仅替换建服时的 server 为 https.Server
 */
export class HttpProxy extends BaseProxy {
  /**
   * 底层 HTTP 服务实例，未启动为 null
   * 只在 closeServer resolve（关服兑现）后置空，关服失败保留引用供重试
   */
  protected server: http.Server | null = null;

  /**
   * 构造 HTTP 代理
   * @param options - 监听地址/端口与 TLS 等选项，缺省由 BaseProxy 归一化
   * @param deps - 本实例能力插件（config/logger/auth/acl/routing/forwarders）
   * @param protocol - 协议标识，默认 http，HttpsProxy 透传 https
   */
  constructor(options: ProxyOptions = {}, deps: ProtocolDeps, protocol: ProxyProtocol = "http") {
    super(protocol, options, deps);
  }

  /**
   * pipe 事件槽：入站适配器与传输策略的 PipeEvent 转抛为本实例 pipe 事件
   * 由 handleHttp/handleConnect/handleUpgrade 回调注入
   */
  private pipeSink = (e: PipeEvent): void => {
    this.emit("pipe", e);
  };

  /**
   * 建服：创建 http.Server 并 listen
   * 成功后写入 this.server；启动期 error 直接 reject 由基类转 error 态
   * 引用只在 listen 兑现后写入（失败不留半初始化引用）；关服侧对称：只在 close 兑现后清空
   * @throws listen 失败（如 EADDRINUSE）时抛错
   */
  protected async doStart(): Promise<void> {
    const server = http.createServer();
    this.bindServer(server);
    await listenAsync(server, this.options.port, this.options.host);
    this.server = server;
  }

  /**
   * 关服：close 当前 server，成功兑现后才置空引用
   * 主动断开存量 keep-alive/隧道连接，否则 server.close 的回调要等这些连接自然结束才触发
   * （close + 排空收口在基类 `closeServer` 模板；close 回调带 error 则 reject，引用保留供重试）
   * 无 server 时直接返回（幂等）
   */
  protected async doStop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    // 先 await closeServer 再置空：关服没兑现（reject）时保留引用，
    // 否则失败重试会看到 null 引用，把仍在 listening 的 server 洗成 stopped
    await this.closeServer(server);
    // identity 比对：期间若已被别的实例接管（理论上被 start 闸门禁止），不误清新引用
    if (this.server === server) {
      this.server = null;
    }
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
      void this.handleForward("http", req, req.socket as unknown as Duplex, res, (sink) =>
        handleHttp(this.forwarderDeps, req, res, sink),
      );
    });
    server.on("connect", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleForward("tunnel", req, socket, socket, (sink) =>
        handleConnect(this.forwarderDeps, req, socket, head, sink),
      );
    });
    server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleForward("upgrade", req, socket, socket, (sink) =>
        handleUpgrade(this.forwarderDeps, req, socket, head, sink),
      );
    });
    server.on("error", (err: Error) => {
      // 传输层错误只上报事实；生命周期由 listen/start 或 stop 模板方法裁决，
      // stopping 期间不能被这里改写成 error，更不能阻止 runStop 最终落到 stopped。
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
   * 统一转发入口：先过客户端名单，再鉴权，失败直接回绝；通过则发 forward 事件并执行委派
   * 委派抛同步错/鉴权抛错统一转 forwardError 事件，不向上传播
   * @param kind - 通道类型：http（普通请求）/tunnel（CONNECT）/upgrade（websocket）
   * @param req - 原始 IncomingMessage，用于鉴权与 forward 事件
   * @param socket - 客户端底层双工流
   * @param rejectTarget - 回绝时的回写目标（http 用 res，tunnel/upgrade 用 socket）
   * @param forward - 实际委派闭包（`handleHttp` / `handleConnect` / `handleUpgrade`），
   *   接收本实例入站适配器依赖（含传输策略注册表）与逐请求事件槽
   */
  private async handleForward(
    kind: "http" | "tunnel" | "upgrade",
    req: http.IncomingMessage,
    socket: Duplex,
    rejectTarget: http.ServerResponse | Duplex,
    forward: (sink: PipeEventSink) => void,
  ): Promise<void> {
    try {
      // 闸门应答器：闸门阶段唯一的协议应答出口（名单拒绝 / 鉴权未过）
      const gate = this.gateResponder(rejectTarget);

      // 客户端名单最先判定：被禁来源不该消耗鉴权与转发资源（只认 TCP 对端地址，不看可伪造的 XFF）
      const client = getSocketAddress(socket);
      // 名单判定经 deps.acl（AccessControlProvider）：判定的是**本实例**的名单，
      // 此前直读 config/resources/acl 的模块级入口，同进程多实例会拿到别的实例的名单
      const ip = this.deps.acl.checkClientIp(client);
      if (!ip.allowed) {
        this.emit("pipe", {
          type: "ip-denied",
          client,
          reason: ip.reason,
          protocol: this.protocol,
        });
        gate.fail(STATUS_FORBIDDEN);
        return;
      }

      const auth = await this.authorizeOrReject(req, socket, gate);
      if (!auth.passed) {
        return;
      }

      // 逐请求事件槽：把身份并入该请求的所有 pipe 事件（含转发层内部抛出的 route/upstream-error），
      // 每次请求新建闭包，绝不把用户名存进共享单例（并发会话会互相串号）
      const sink: PipeEventSink = auth.username
        ? (e) => this.emit("pipe", { ...e, user: auth.username })
        : this.pipeSink;

      this.emit("forward", { kind, req, username: auth.username });
      forward(sink);
    } catch (err) {
      this.emit("forwardError", { kind, error: err });
    }
  }

  /**
   * 闸门阶段的协议应答器：本类（入站协议插件）持有「怎么应答」
   * @description 名单拒绝与鉴权未过都发生在**转发之前**，此刻协议层只能自己写字节：
   * 同一通道上「http 写 `ServerResponse`」与「tunnel/upgrade 写预拼裸报文」两形态
   * 由 {@link GATE_REJECT_REPLY} 一处收口（`"writeHead" in target` 判别）。
   * - `establish` 是**空实现**：闸门通过后应答权交给转发链路（http 通道的成功应答即上游响应本身）
   * - `username` 恒空串：闸门失败时尚无会话身份（`NoneAuthProvider` 下身份也为空）
   * @param target - http 通道为 ServerResponse，tunnel/upgrade 通道为 Duplex
   */
  private gateResponder(target: http.ServerResponse | Duplex): ProtocolResponder {
    return {
      establish: () => {
        // 闸门阶段没有「建链成功」可应答：调用方只走 fail
      },
      fail: (status: number) => {
        const reply = GATE_REJECT_REPLY.get(status);

        if (!reply) {
          // 未登记状态码 = 调用点漏了报文形态（装配 bug）。绝不猜成 407/403（会误导客户端
          // 重试带凭证），也不抛错（抛错只会让客户端拿到一个不透明断链）：回 502 预拼报文，
          // 客户端至少读得到一条自洽的状态行
          target.end(HTTP_502_BAD_GATEWAY);
          return;
        }

        if ("writeHead" in target) {
          target.writeHead(status, reply.headers);
          target.end(reply.body);
          return;
        }

        target.end(reply.raw);
      },
      username: "",
    };
  }

  /**
   * 鉴权并在失败时回绝：组装 AuthContext 调基类 authorize()
   * @param req - 原始请求，用于提取 Proxy-Authorization 头
   * @param socket - 客户端双工流，透传给 AuthContext
   * @param gate - 闸门应答器（失败时由它按本通道形态写 407）
   * @returns 鉴权结果（含命中账号的用户名），失败已回绝
   */
  protected async authorizeOrReject(
    req: http.IncomingMessage,
    socket: Duplex,
    gate: ProtocolResponder,
  ): Promise<AuthResult> {
    const result = await this.authorize({
      protocol: this.protocol,
      req,
      socket,
      authority: getAuthority(req),
    });
    if (!result.passed) {
      gate.fail(STATUS_PROXY_AUTH_REQUIRED);
    }
    return result;
  }
}

