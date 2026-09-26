/**
 * HTTP 代理 - 直持 http.Server，鉴权后委派 forward/*
 * 职责：
 * - 建服：http.createServer + 监听 request/connect/upgrade 三通道
 * - **组装：三个转发器在构造函数里一次建好**（`HttpForwarder` / `TunnelForwarder` / `WsForwarder`），
 *   请求期只调它们的方法——请求路径零实例化
 * - 鉴权：authorizeOrReject 不通过即回 407/断流，不进转发
 * - 委派：http -> HttpForwarder.handle，tunnel -> TunnelForwarder.handle，upgrade -> WsForwarder.handle
 * - 作用域：`handleForward` 为每个请求建一个 `RequestScope`（终态守卫 + 身份维度 + pipe 事件出口）
 * - 事件：请求期/服务期事实直接发到注入的 EventHub
 *   （request.started / forward.error / server.error / server.client-error / server.listening /
 *     server.closed / pipe），core 零日志，落盘收在 src/server/index.ts
 * 设计：HttpsProxy 复用本类 bindServer/handleForward，仅重写 doStart 建 TLS 服
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import { BaseProxy, listenAsync } from "@/core/server/base.js";
import { HttpForwarder } from "@/core/forward/http.js";
import { TunnelForwarder } from "@/core/forward/tunnel.js";
import { WsForwarder } from "@/core/forward/websocket.js";
import {
  associateRequestTerminal,
  createRequestTerminal,
  requestTerminalFor,
} from "@/core/request-terminal.js";
import { createRequestScope, type RequestScope } from "@/core/request-scope.js";
import { connectionIdFor, newRequestId } from "@/core/scope-ids.js";
import { checkClientIp } from "@/core/access-control.js";
import type { AuthResult, ProxyOptions, ProxyProtocol } from "@/core/types/proxy.js";
import { getAuthority, getClientAddress, getSocketAddress } from "@/utils/ip.js";
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
} from "@/utils/constants/index.js";

/** 头 dump 的敏感头（小写）：命中一律掩码，凭证/会话绝不出现在日志或事件总线 */
const SENSITIVE_HEADERS = new Set(["proxy-authorization", "authorization", "cookie"]);

/**
 * 掩码敏感请求头 - `forward.request-headers` 事件的**数据来源**
 *
 * @description `proxy-authorization` / `authorization` / `cookie`（大小写不敏感）一律替换为
 * `"***"`，其余头原样保留。**必须在 publish 之前调用**：原始 `Proxy-Authorization` /
 * `Authorization` / `Cookie` 不允许跨进 `EventHub`（事件总线对库调用方可见，不是私有通道）。
 *
 * 归属说明（本文件而非别处，这是刻意的）：
 * - **不**放 `@/core/log-events.ts`：那是「core 事实 → `[event-code]` **文本**」的词汇层，
 *   它的函数直接 `log[level](msg, fields)`。本函数是**纯数据变换**、不产文本也不产等级，
 *     必须在 logger 出现之前跑；硬塞进去要么让它反向依赖 logger，要么给它编一个假的
 *   `LogEvent` 码从而改掉 `[http] headers` 的 msg 文本。
 * - **不**放 `@/utils/logger/sanitize.ts`：那是日志**渲染**层（值 → 单行文本 / `k=v` 拼接），
 *   且 `utils/AGENTS.md` 明写「logger/ 只负责把给定文本写出去，不拥有事件词汇」。
 * - **不**放 `@/core/helpers/headers.ts`：那个文件的全部导出都是**出站**（发给目标站）判定，
 *   其不变量是「任意 `proxy-` 前缀 + 形态上是本代理凭证的 `authorization` 才剥离」——
 *   例如目标的 `Authorization: Bearer <target-token>` 出站**保留**、日志里却必须**掩码**。
 *   两种判据方向相反，混在一个模块里迟早被后人「顺手统一」掉，泄漏面反而变大。
 * - 唯一调用方是 `handleForward`（它已覆盖 http/tunnel/upgrade 三种 kind，SOCKS 无头 dump），
 *   故就近放在本模块，不进 `helpers/` 的公共导出面。
 *
 * @param headers - `req.headers` 原文（Node 的 `IncomingHttpHeaders`）
 * @returns 掩码后的新对象（不改动入参）；键名大小写原样保留，仅按小写判敏感
 */
function maskSensitiveHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      masked[key] = "***";
      continue;
    }
    if (value === undefined) {
      continue;
    }
    // Node 只对 `set-cookie` 保留数组（其余重复头已用 ", " 合并）；按 Node 自身的
    // 重复头合并约定拍平成字符串，使事件载荷的值恒为 string
    masked[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return masked;
}

/**
 * HTTP 代理实现：BaseProxy 的 http 分支
 * HttpsProxy 继承本类，仅替换建服时的 server 为 https.Server
 */
export class HttpProxy extends BaseProxy {
  /** 底层 HTTP 服务实例，未启动为 null，stop 后置空 */
  protected server: http.Server | null = null;

  /**
   * 三个转发器在**服务构造期**一次组装好，请求期只调它们的方法。
   * @description
   * 转发器自身无请求态（拨号器经 `connector/` 单例缓存、事件出口经 `RequestScope` 逐请求传入），
   * 所以跨请求复用是安全的；而**逐请求的身份维度绝不存这里**——那是 `RequestScope` 的职责。
   * 这么组装同时消掉了「每请求 `new` 一个转发器 + 一个 `Dialer`」的分配，
   * 更要紧的是消掉「把逐请求数据存进可能被共享的实例」这个串号雷的结构性前提。
   * `protected` 是刻意的：子类（含测试探针子类）能拿到实例断言复用行为。
   */
  protected readonly httpForwarder: HttpForwarder;
  protected readonly tunnelForwarder: TunnelForwarder;
  protected readonly wsForwarder: WsForwarder;

  /**
   * 构造 HTTP 代理
   * @param options - 监听地址/端口、鉴权与必填依赖上下文 `ctx`
   * @param protocol - 协议标识，默认 http，HttpsProxy 透传 https
   */
  constructor(options: ProxyOptions, protocol: ProxyProtocol = "http") {
    super(protocol, options);
    this.httpForwarder = new HttpForwarder(options.ctx, this.traffic);
    this.tunnelForwarder = new TunnelForwarder(options.ctx, this.traffic);
    this.wsForwarder = new WsForwarder(options.ctx, this.traffic);
  }

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
   * @description 三个通道回调只做一件事：把请求交给**已建好的转发器实例**（本方法体内零 `new`）
   * @param server - 已创建但未 listen 的 HTTP 服务实例
   */
  protected bindServer(server: http.Server): void {
    server.on("connection", (socket: Duplex) => {
      this.registry.track(socket);
    });
    server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
      void this.handleForward("http", req, req.socket as unknown as Duplex, res, (scope) =>
        this.httpForwarder.handle(req, res, scope),
      );
    });
    server.on("connect", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleForward("tunnel", req, socket, socket, (scope) =>
        this.tunnelForwarder.handle(req, socket, head, scope),
      );
    });
    server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleForward("upgrade", req, socket, socket, (scope) =>
        this.wsForwarder.handle(req, socket, head, scope),
      );
    });
    server.on("error", (err: Error) => {
      this.setState("error");
      this.events.publish(
        "server.error",
        {
          error: err,
          host: this.options.host,
          port: this.options.port,
        },
        { protocol: this.protocol },
      );
    });
    server.on("clientError", (err: Error, socket: Duplex) => {
      const client = getSocketAddress(socket);
      this.events.publish("server.client-error", { error: err }, { protocol: this.protocol, client });
      const existing = requestTerminalFor(socket);
      const terminal =
        existing !== undefined && !existing.settled
          ? existing
          : createRequestTerminal(this.config, this.protocol, {
              client,
            });
      terminal.reject("malformed-request", "parse", 400);
      try {
        (socket as Duplex).end(HTTP_400_BAD_REQUEST);
      } catch {
        // 忽略 socket 结束异常
      }
    });
    server.on("close", () => {
      this.events.publish("server.closed", undefined, { protocol: this.protocol });
    });
    server.on("listening", () => {
      this.events.publish(
        "server.listening",
        {
          host: this.options.host,
          port: this.options.port,
        },
        { protocol: this.protocol },
      );
    });
  }

  /**
   * 统一转发入口：先过客户端名单，再鉴权，失败直接回绝；通过则发 `request.started` 并执行委派
   * 委派抛同步错/鉴权抛错统一发 `forward.error`，不向上传播
   * @param kind - 通道类型：http（普通请求）/tunnel（CONNECT）/upgrade（websocket）
   * @param req - 原始 IncomingMessage，用于鉴权与事件关联上下文
   * @param socket - 客户端底层双工流
   * @param rejectTarget - 回绝时的回写目标（http 用 res，tunnel/upgrade 用 socket）
   * @param forward - 实际转发闭包：接收本次请求的 `RequestScope`（**不接收事件槽**——事件出口在 scope 里）
   */
  private async handleForward(
    kind: "http" | "tunnel" | "upgrade",
    req: http.IncomingMessage,
    socket: Duplex,
    rejectTarget: http.ServerResponse | Duplex,
    forward: (scope: RequestScope) => void,
  ): Promise<void> {
    const client = getSocketAddress(socket);
    const target = getAuthority(req);
    // 请求/连接标识：keep-alive 下同一 socket 共享 connectionId、每请求独立 requestId，
    // 由 mergeContext 透传进该请求所有终态事件
    const connectionId = connectionIdFor(socket);
    const requestId = newRequestId();
    const terminal = createRequestTerminal(this.config, this.protocol, {
      client,
      connectionId,
      requestId,
      ...(target ? { target } : {}),
    });
    // 该请求所有事件的公共关联上下文：让只读 context 的观察者（不解析 PipeEvent 载荷）
    // 也能按 requestId 与身份维度串联。
    //
    // `client` 这里刻意取 `getClientAddress(req)`（XFF → X-Real-IP → Forwarded → socket）而不是
    // 上面的 TCP 对端：那是**展示/审计口径**（`[auth]`/`[forward]` 日志行的 client 一直是它），
    // 而名单判定只认 TCP 对端（`checkClientIp` 的入参 `client`）。两者是不同的事实，不合并。
    const eventContext = {
      protocol: this.protocol,
      client: getClientAddress(req),
      ...(target ? { target } : {}),
      requestId,
      connectionId,
    };
    // 只关联 socket，不关联 req：Node 的 `clientError` 只给 socket、拿不到 req，这是跨事件通道
    // 取回同一个 guard 的唯一路径（见下方 clientError handler）。req 不必关联——scope 已携带
    // terminal，四个 forwarder 入口自己会再关联一次，这里写纯属白写一遍 WeakMap。
    associateRequestTerminal(socket, terminal);

    try {
      // 客户端名单最先判定：被禁来源不该消耗鉴权与转发资源（只认 TCP 对端地址，不看可伪造的 XFF）
      const ip = checkClientIp(client, this.config);
      if (!ip.allowed) {
        this.events.publish(
          "pipe",
          {
            type: "ip-denied",
            client,
            reason: ip.reason,
            protocol: this.protocol,
          },
          { protocol: this.protocol, client, requestId, connectionId },
        );
        this.writeIpRejected(rejectTarget);
        terminal.reject(ip.reason ?? "client-denied", "access", 403);
        return;
      }

      const auth = await this.authorizeOrReject(req, socket, rejectTarget, {
        requestId,
        connectionId,
      });
      if (!auth.passed) {
        terminal.reject("proxy-auth-required", "auth", 407);
        return;
      }
      if (auth.username !== undefined) {
        terminal.setContext({ user: auth.username });
      }

      // 本次请求的**请求作用域**（每次请求新建一个，绝不跨请求复用）：它携带终态守卫与身份维度，
      // 并把身份注进该请求的所有 pipe 事件（含转发层内部抛出的 route/upstream-error）。
      // 每次请求新建闭包 + 绝不把用户名存进共享的转发器实例——后者会让并发请求互相串号
      // （转发器是服务构造期建一次、跨请求复用的单例，见构造函数）。
      // 同时注入 requestId/connectionId，使 mid-flight 事件可与终态事件按请求串联。
      // Phase 1.3a 只把投递方式从 `this.emit("pipe", …)` 换成 `this.events.publish("pipe", …)`：
      // `PipeEvent` 载荷形状一字未改，日志面零感知。
      // `user` 维度注进 pipe 事件的动作**只在 `createRequestScope` 里发生一次**；下面两条
      // 非 pipe 事件（`forward.request-headers` / `request.started`）各带一份 context，
      // 它们与 scope 同源、但事件名与载荷不同，故不走 scope。
      const username = auth.username;
      const identity = username === undefined ? {} : { user: username };
      const scope = createRequestScope({
        ctx: this.options.ctx,
        terminal,
        context: eventContext,
        user: username,
        requestId,
        connectionId,
      });

      // 诊断细节事实：掩码后的请求头快照，publish 前已掩码（原始凭证不跨事件总线）。
      // 必须在 `request.started` **之前**发布：改造前同一次 emit 里 headers 行在前、
      // [forward] 行在后，顺序反了会让 JSONL 行序变化。
      this.events.publish(
        "forward.request-headers",
        { kind, headers: maskSensitiveHeaders(req.headers) },
        { ...eventContext, ...identity },
      );
      // 带上 requestId/connectionId：公共事件面的 `request.started` 据此与本请求的终态事件串联。
      // `method` 走 context（payload 只有 `kind`）：日志面要还原 `[forward]` 行的 method，
      // 而事件载荷刻意不携带原始 `IncomingMessage`（它带 socket 与全部请求头）。
      this.events.publish("request.started", { kind }, {
        ...eventContext,
        ...identity,
        ...(req.method !== undefined ? { method: req.method } : {}),
      });
      forward(scope);
    } catch (err) {
      terminal.fail(err, "forward");
      this.events.publish("forward.error", { kind, error: err }, eventContext);
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
    scope?: { requestId?: string; connectionId?: string },
  ): Promise<AuthResult> {
    const result = await this.authorize({
      protocol: this.protocol,
      req,
      socket,
      authority: getAuthority(req),
      ...scope,
    });
    if (!result.passed) {
      this.writeAuthRejected(rejectTarget);
    }
    return result;
  }
}

/**
 * 快捷构造 HTTP 代理（免 new）
 * @param options - 同 HttpProxy 构造选项，必须显式提供配置访问器
 * @returns 未启动的 HttpProxy 实例
 */
export function createHttpProxy(options: ProxyOptions): HttpProxy {
  return new HttpProxy(options);
}
