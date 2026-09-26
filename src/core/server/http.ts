/**
 * HTTP 代理 - 直持 http.Server，鉴权后委派 forward/*
 * 职责：
 * - 建服：http.createServer + 监听 request/connect/upgrade 三通道
 * - **组装：三个转发器在构造函数里一次建好**（`HttpForwarder` / `TunnelForwarder` / `WsForwarder`），
 *   请求期只调它们的方法——请求路径零实例化
 * - **派发：`INBOUND_CHANNELS` 是「哪种入站事件走哪个转发器的哪个方法」的唯一一处**
 *   （见 {@link InboundChannels}）；三个 `server.on` 回调只做「Node 参数 → 统一形状」的适配
 * - 准入：阶段 A（客户端名单）与阶段 B（鉴权 + `RequestScope`）都取自
 *   `@/core/server/admission.js` 的两阶段构件，本类只按 HTTP 的时序调用
 * - 事件：请求期/服务期事实直接发到注入的 EventHub
 *   （request.started / forward.error / server.error / server.client-error / server.listening /
 *     server.closed / pipe），core 零日志，落盘收在 src/server/index.ts
 * 设计：HttpsProxy 复用本类 bindServer/handleForward，仅重写 doStart 建 TLS 服
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import { BaseProxy, listenAsync } from "@/core/server/base.js";
import { HttpForwarder } from "@/core/forward/channel/http.js";
import { TunnelForwarder } from "@/core/forward/channel/tunnel.js";
import { WsForwarder } from "@/core/forward/channel/upgrade.js";
import { createInboundAdmission } from "@/core/server/admission.js";
import {
  associateRequestTerminal,
  createRequestTerminal,
  requestTerminalFor,
} from "@/core/request-terminal.js";
import type { RequestScope } from "@/core/request-scope.js";
import { connectionIdFor, newRequestId } from "@/core/scope-ids.js";
import type {
  ProxyForwardKind,
  ProxyOptions,
  ProxyProtocol,
} from "@/core/types/proxy.js";
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
 * 入站事件种类 → 该种类的通道实现
 *
 * @description 这是**本文件唯一的「事件种类」词汇表**：加第 4 种入站事件 = 往
 * {@link INBOUND_CHANNELS} 加一项 + 加一个 `server.on` 回调（回调体仍只是参数适配），
 * 而**不是**把「前置接线」复制一遍。
 * SOCKS **不进这张表**（它不是 `server.on` 事件，而是连接内的握手状态机），
 * 但它与本表共用 `@/core/server/admission.js` 的两阶段准入与 scope 组装。
 */
export type InboundKind = "request" | "connect" | "upgrade";

/**
 * 三个入站事件适配出的**统一形状**（判别联合：每支的字段由该事件的 Node 回调参数决定）
 *
 * @description 判别键就是 {@link InboundKind} 本身，所以「`reject` 写在哪、派给谁」
 * 可以由派发表按种类**收窄**后静态定死，不靠运行期 `if`。
 */
export type InboundEvent =
  | { kind: "request"; req: http.IncomingMessage; socket: Duplex; res: http.ServerResponse }
  | { kind: "connect"; req: http.IncomingMessage; socket: Duplex; head: Buffer }
  | { kind: "upgrade"; req: http.IncomingMessage; socket: Duplex; head: Buffer };

/** 从 {@link InboundEvent} 里取出某个种类的那一支（派发表按种类收窄用） */
export type InboundEventOf<K extends InboundKind> = Extract<InboundEvent, { kind: K }>;

/** 一种入站事件的通道实现 */
export interface InboundChannel<K extends InboundKind> {
  /**
   * 本种类在**公共事件面**申报的转发种类
   *
   * @description 两件事共用这一个字段（**刻意**：少一张表、少一个能漂移的地方）：
   * ① `request.started` / `forward.request-headers` / `forward.error` 的 `data.kind`
   * （事件契约，逐字被 `request-scope-ids` 与 `core-event-bridge` 锁住，不许改字面量）；
   * ② 「本种类归哪个转发器」的可断言标签。
   *
   * **② 现在是冗余的**（这正是它该被留下的理由，见下）：三个入口方法名已各自与本表的键
   * **逐字对齐**（`request` → `handleRequest` / `connect` → `handleConnect` /
   * `upgrade` → `handleUpgrade`），所以「三项各自指向不同的方法」这条断言**按名字就能写**，
   * 不再需要 `forwardKind` 来当身份标签。它留下的唯一理由是 ①——公共事件面那个逐字契约。
   * 声明式、只读、不参与任何控制流；改它不改变行为。
   */
  readonly forwardKind: ProxyForwardKind;
  /**
   * 本种类的**拒绝应答载体**：http 通道是 `ServerResponse`（能写状态行），
   * tunnel / upgrade 通道是裸 `Duplex`（只能写预拼原始报文再断流）
   */
  rejectTarget(event: InboundEventOf<K>): http.ServerResponse | Duplex;
  /**
   * 该种类的通道实现：本次请求交给哪个转发器的哪个方法
   *
   * @description 三个 `dispatch` 调的方法名**互不相同**，且各自与 {@link InboundKind} 的
   * 键逐字对齐（`request` → `handleRequest` / `connect` → `handleConnect` /
   * `upgrade` → `handleUpgrade`）——所以「派发到哪」从方法名就能读出来，不必去翻转发器类名。
   */
  dispatch(event: InboundEventOf<K>, scope: RequestScope): void;
}

/** 派发表：入站事件种类 → 通道实现（三个种类各有且仅有一项） */
export type InboundChannels = { [K in InboundKind]: InboundChannel<K> };

/**
 * 按种类取通道实现
 *
 * @description 唯一职责是**把「种类已被运行时确定」这件事告诉类型系统**：
 * `channels[kind]` 在 `kind` 放宽成 `InboundKind` 时会退化成「三个通道类型的并集」，
 * 那样的 `dispatch` 收不了 `InboundEvent`（三个形参类型求交等于无解）。
 * 这里按**映射类型的索引访问**（`InboundChannels[K]`）把泛型带回来，
 * 事件的判别键与通道签名因此逐字对齐——`connect` 那支写 `event.head` 能编译，
 * 误写成 `event.res` 立刻编译期红。**不引入任何运行期逻辑**。
 */
export function channelFor<K extends InboundKind>(
  channels: InboundChannels,
  kind: K,
): InboundChannel<K> {
  return channels[kind];
}

/** 三个转发器（服务构造期一次组装，请求期只调它们的方法） */
export interface ForwarderSet {
  readonly http: HttpForwarder;
  readonly tunnel: TunnelForwarder;
  readonly ws: WsForwarder;
}

/**
 * 建派发表：**「哪种事件走哪个转发器的哪个方法」全仓只有这一处**
 *
 * @description 三个 `server.on` 回调体内**零 `if (kind …)`、零三元选转发器**，它们只把 Node 的
 * 回调参数适配成 {@link InboundEvent} 再交进来。
 * @param forwarders - 服务构造期组装好的三个转发器
 */
export function buildInboundChannels(forwarders: ForwarderSet): InboundChannels {
  return {
    request: {
      forwardKind: "http",
      rejectTarget: (event) => event.res,
      dispatch: (event, scope) => forwarders.http.handleRequest(event.req, event.res, scope),
    },
    connect: {
      forwardKind: "tunnel",
      rejectTarget: (event) => event.socket,
      dispatch: (event, scope) =>
        forwarders.tunnel.handleConnect(event.req, event.socket, event.head, scope),
    },
    upgrade: {
      forwardKind: "upgrade",
      rejectTarget: (event) => event.socket,
      dispatch: (event, scope) =>
        forwarders.ws.handleUpgrade(event.req, event.socket, event.head, scope),
    },
  };
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
   * 派发表：`InboundKind` → 通道实现（构造期由 {@link buildInboundChannels} 建一次）
   * @description 请求期只做一次表查，不含任何控制流分支——「哪种事件走哪个转发器」
   * 的答案在表里，不在回调里。
   */
  private readonly channels: InboundChannels;

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
    this.channels = buildInboundChannels({
      http: this.httpForwarder,
      tunnel: this.tunnelForwarder,
      ws: this.wsForwarder,
    });
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
   * @description 三个通道回调**只做一件事**：把 Node 的回调参数适配成 {@link InboundEvent}
   * 再交出去（体内零 `if (kind …)`、零三元选转发器、零 `new`）。选哪个转发器由
   * {@link buildInboundChannels} 那张表决定。
   * @param server - 已创建但未 listen 的 HTTP 服务实例
   */
  protected bindServer(server: http.Server): void {
    server.on("connection", (socket: Duplex) => {
      this.registry.track(socket);
    });
    server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
      void this.handleForward("request", {
        kind: "request",
        req,
        socket: req.socket as unknown as Duplex,
        res,
      });
    });
    server.on("connect", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleForward("connect", { kind: "connect", req, socket, head });
    });
    server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleForward("upgrade", { kind: "upgrade", req, socket, head });
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
   * 统一转发入口：阶段 A（客户端名单）→ 阶段 B（鉴权 + `RequestScope`）→ 派发
   *
   * @description
   * 两个准入阶段都取自 `@/core/server/admission.js` 的 {@link createInboundAdmission}，
   * 本方法只负责**按 HTTP 的时序调用它们**、把协议应答写成 HTTP 形态、并发出三条非 pipe 事件。
   * 委派抛同步错/鉴权抛错统一发 `forward.error`，不向上传播。
   *
   * **关卡顺序是契约**：名单 → 鉴权 → 派发（目标 ACL 在转发器内的 `preDial`）。
   * 阶段 A 被拒时的事件与终态、阶段 B 被拒时的事件与终态，都由准入构件就地结算
   * （应答写在这两步**之间**，顺序逐字不变）。
   * @param kind - 入站事件种类（派发表用它选通道；公共事件面的 `data.kind` 取自该通道的 `forwardKind`）
   * @param event - 由 `server.on` 回调适配出的统一形状
   */
  private async handleForward(
    kind: InboundKind,
    event: InboundEvent,
  ): Promise<void> {
    const channel = channelFor(this.channels, kind);
    const { req, socket } = event;
    const target = getAuthority(req);
    // 请求/连接标识：keep-alive 下同一 socket 共享 connectionId、每请求独立 requestId，
    // 由 mergeContext 透传进该请求所有终态事件
    const connectionId = connectionIdFor(socket);
    const requestId = newRequestId();
    // 该请求所有事件的公共关联上下文：让只读 context 的观察者（不解析 PipeEvent 载荷）
    // 也能按 requestId 与身份维度串联。
    //
    // `client` 这里刻意取 `getClientAddress(req)`（XFF → X-Real-IP → Forwarded → socket）而不是
    // 准入层的 TCP 对端：那是**展示/审计口径**（`[auth]`/`[forward]` 日志行的 client 一直是它），
    // 而名单判定只认 TCP 对端。两者是不同的事实，不合并。
    //
    // 它同时就是 `RequestScope` 的关联上下文（同一个对象，不另抄一份）——
    // 「非 pipe 事件带的 context」与「scope 带的 context」本就是同一份事实。
    const eventContext = {
      protocol: this.protocol,
      client: getClientAddress(req),
      ...(target ? { target } : {}),
      requestId,
      connectionId,
    };
    const admission = createInboundAdmission({
      ctx: this.options.ctx,
      protocol: this.protocol,
      socket,
      requestId,
      scopeContext: eventContext,
      authorize: (credentials) => this.authorize(credentials),
    });
    // 只关联 socket，不关联 req：Node 的 `clientError` 只给 socket、拿不到 req，这是跨事件通道
    // 取回同一个 guard 的唯一路径（见下方 clientError handler）。req 不必关联——scope 已携带
    // terminal，四个 forwarder 入口自己会再关联一次，这里写纯属白写一遍 WeakMap。
    associateRequestTerminal(socket, admission.terminal);

    try {
      // 阶段 A：客户端名单最先判定（HTTP 没有握手，故与 SOCKS 同为入口第一关）
      if (
        !admission.admitClientIp(STATUS_FORBIDDEN, () =>
          this.writeIpRejected(channel.rejectTarget(event)),
        )
      ) {
        return;
      }

      // 阶段 B 第一半：鉴权
      const auth = await admission.authenticate(
        {
          protocol: this.protocol,
          req,
          socket,
          authority: target,
        },
        STATUS_PROXY_AUTH_REQUIRED,
        () => this.writeAuthRejected(channel.rejectTarget(event)),
      );
      if (!auth.passed) {
        return;
      }
      if (auth.username !== undefined) {
        admission.terminal.setContext({ user: auth.username });
      }

      // 阶段 B 第二半：请求作用域（每次请求新建一个，绝不跨请求复用）。它携带终态守卫与身份维度，
      // 并把身份注进该请求的所有 pipe 事件（含转发层内部抛出的 route/upstream-error）。
      // 每次请求新建闭包 + 绝不把用户名存进共享的转发器实例——后者会让并发请求互相串号
      // （转发器是服务构造期建一次、跨请求复用的单例，见构造函数）。
      // `user` 维度注进 pipe 事件的动作**只在 `createRequestScope` 里发生一次**；下面两条
      // 非 pipe 事件（`forward.request-headers` / `request.started`）各带一份 context，
      // 它们与 scope 同源、但事件名与载荷不同，故不走 scope。
      const username = auth.username;
      const identity = username === undefined ? {} : { user: username };
      const scope = admission.scopeFor(username);

      // 诊断细节事实：掩码后的请求头快照，publish 前已掩码（原始凭证不跨事件总线）。
      // 必须在 `request.started` **之前**发布：改造前同一次 emit 里 headers 行在前、
      // [forward] 行在后，顺序反了会让 JSONL 行序变化。
      this.events.publish(
        "forward.request-headers",
        { kind: channel.forwardKind, headers: maskSensitiveHeaders(req.headers) },
        { ...eventContext, ...identity },
      );
      // 带上 requestId/connectionId：公共事件面的 `request.started` 据此与本请求的终态事件串联。
      // `method` 走 context（payload 只有 `kind`）：日志面要还原 `[forward]` 行的 method，
      // 而事件载荷刻意不携带原始 `IncomingMessage`（它带 socket 与全部请求头）。
      this.events.publish("request.started", { kind: channel.forwardKind }, {
        ...eventContext,
        ...identity,
        ...(req.method !== undefined ? { method: req.method } : {}),
      });
      channel.dispatch(event, scope);
    } catch (err) {
      admission.terminal.fail(err, "forward");
      this.events.publish(
        "forward.error",
        { kind: channel.forwardKind, error: err },
        eventContext,
      );
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
   * @description 语义刻意**不**收进准入层：应答形态是各协议自己的事（见
   * `admission.ts` 的「判定与应答要分离」），故它是本类自己的方法，被准入层的
   * `respond` 回调调用。
   * @param target - http 通道为 ServerResponse，tunnel/upgrade 通道为 Duplex
   */
  private writeAuthRejected(target: http.ServerResponse | Duplex): void {
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
  private writeIpRejected(target: http.ServerResponse | Duplex): void {
    this.writeRejected(target, {
      status: STATUS_FORBIDDEN,
      body: REASON_FORBIDDEN,
      raw: HTTP_403_FORBIDDEN,
    });
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
