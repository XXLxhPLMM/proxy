/**
 * @fileoverview 代理核心类型总表（Single Source of Truth）
 * @module core/types/proxy
 * @description
 * 本文件是整个代理内核的「类型总表」，集中定义协议、配置、生命周期、
 * 事件契约、转发载体与认证等所有共享类型，是其它叶模块（auth/pipe）
 * 的唯一上游来源，叶模块仅做 `export type { ... } from "./proxy.js"` 转发。
 *
 * 职责：
 * - 定义代理协议、选项、统计与生命周期状态机类型
 * - 定义代理内核的抽象接口（ProxyCore）
 * - 集中定义认证与管道事件等跨层契约
 * - 避免循环依赖：所有叶类型文件均指向本文件，禁止反向引入
 * - 9 个与日志事件重名的 pipe 判别键引用 `core/log-events.ts` 的 `LogEvent` 表（`import type`，
 *   编译期擦除，不产生运行时边），使「同一语义只写一次字面量」在类型层成立；`log-events.ts`
 *   不 import 本文件，故无环。两侧差集是事实差异，故意不对称：
 *   `client-timeout` / `tls-client-error` 只属握手/接入期日志（没有对应 pipe 事件），
 *   `route` / `socks` / `dial` / `established` / `debug` 是落盘不走的内部细节事件
 * - `ProxyOptions.ctx` 引用 `core/context.ts` 的 `CoreContext`（同样 `import type`，编译期擦除）；
 *   `core/context.ts` 不 import 本文件，故无环。这是有意新增的第二条出边：`ctx` 替代了原先
 *   散装的 `config`/`logger` 两字段，是「依赖收成单个必填上下文」的类型落点
 *
 * 设计要点：
 * - 单一来源原则：所有类型在此定义一处，其它文件只做类型转发，保证改动收敛
 * - **事件契约只有一份**：core 的全部事实（含生命周期跃迁 `lifecycle.changed`）都由
 *   `core/events/types.ts:AppEventMap` 声明，`BaseProxy` 直接 `publish` 到注入的 `EventHub`。
 *   历史上的 `ProxyEventMap`（Node `EventEmitter<ProxyEventMap>` 契约）与
 *   `ProxyForwardEvent` / `ProxyForwardErrorEvent` / `ProxyServerErrorEvent` /
 *   `ProxyClientErrorEvent` 四个载荷接口**已在 Phase 1.3b 整体删除**（库尚未投入使用，不留兼容层）
 * - Duplex 抽象：CONNECT/Upgrade 场景下 `http.Server` 的 socket 为 `Duplex`（非 net.Socket），
 *   全链路统一使用 `Duplex` 以兼容 TLS 包装后的流
 * - 分层解耦：`ProxyCore` 只暴露生命周期与统计，不持有具体传输实现
 * - 零运行时：本文件仅含类型与接口，无任何运行时代码，可被 `erasableSyntaxOnly` 安全擦除
 *
 * 使用示例：
 * ```ts
 * import type { ProxyProtocol, ProxyOptions, ProxyCore } from "@/core/types/proxy.js";
 *
 * // 1) 构造代理选项（依赖上下文必须显式注入）
 * const opts: ProxyOptions = { host: "127.0.0.1", port: 1080, upstreamTimeout: 10_000, ctx };
 *
 * // 2) 状态跃迁直接发布到注入的总线（core 的唯一事件通道）
 * // setState("running") 等价于 ctx.events.publish("lifecycle.changed", { next, prev })
 * ```
 */

import type { Duplex } from "node:stream";
import type { TlsKeyCert } from "@/utils/tls/index.js";
import type { CoreContext } from "@/core/context.js";
import type { TrafficAccount } from "@/core/traffic/index.js";
import type { LogEvent } from "../log-events.js";

// ---------------------------------------------------------------------------
// 基础协议与配置
// ---------------------------------------------------------------------------

/**
 * 代理对外暴露的协议类型
 * @description
 * - `http` / `https`：基于 HTTP 的正向代理（CONNECT 隧道 / 普通转发）
 * - `socks4` / `socks5`：SOCKS 明文代理
 * - `sockss4` / `sockss5`：SOCKS over TLS（带 `s` 后缀表示 TLS 承载）
 * @example "http" | "https" | "socks5" | "sockss5"
 */
export type ProxyProtocol = "http" | "https" | "socks4" | "socks5" | "sockss4" | "sockss5";

/**
 * 代理实例化选项
 * @description 依赖以单个必填 `ctx`（`CoreContext`：配置访问器/日志/事件总线）整体注入；其余字段由 BaseProxy 在构造期归一化
 * @param port - 监听端口，未指定时由配置层注入
 * @param host - 监听地址，未指定时由配置层注入
 * @param auth - 认证提供者（实现 `AuthProvider`），由 `createAuthFromConfig()` 注入
 * @param upstreamTimeout - 上游拨号/请求超时（毫秒），同时用于隧道与 HTTP 转发
 * @param tls - TLS 证书上下文（供 https/sockss/tls 协议使用，来自 `loadTlsContext`）
 * @param isWorker - 是否为 cluster 子进程，决定日志与信号处理行为
 * @param ctx - 依赖上下文（三件套全必填，无缺省），必须由调用方显式注入；core 不提供全局回退
 * @example { port: 7890, host: "127.0.0.1", upstreamTimeout: 10000, isWorker: false, ctx }
 */
export interface ProxyOptions {
  port?: number;
  host?: string;
  auth?: AuthProvider;
  upstreamTimeout?: number;
  tls?: TlsKeyCert;
  isWorker?: boolean;
  /**
   * 每用户流量配额服务（`@/core/traffic` 的 `TrafficAccount` 端口）。
   *
   * - **可注入**：库调用方经 `createProxyRuntime({ services: { traffic } })` 换掉内存实现；
   *   core 与四个转发器只认端口，永不自己造实现。
   * - **缺省 = 显式禁用档**，与本文件已有的 `auth ?? new Auth({ enabled: false })` **完全同构**：
   *   直构 core（低层调用方 / 测试）没注入它时有一个语义明确的答案——**不计量、不判定**，
   *   而不是「忘注入」变成运行期怪问题。归一在 `BaseProxy` 构造期做**一次**。
   * - **真正的默认实现（读 `users.json` 的内存账本）只在唯一组装点解析**：
   *   `createProxyRuntime` → `runtime/services.ts:buildDefaultServices`。core 内部零缺省解析。
   * - 归一后 core 侧拿到的一定是非 optional 的端口（见 `BaseProxy` 的 `Required<ProxyOptions>`）。
   */
  traffic?: TrafficAccount;
  /**
   * 依赖上下文：`config` / `logger` / `events` 三件套的只读载体，**必填且不做任何缺省解析**。
   * 缺省解析只允许发生在唯一组装根 `createProxyRuntime()`。
   */
  ctx: CoreContext;
}

/**
 * 代理运行时统计快照
 * @param startedAt - 启动时间戳（毫秒，`Date.now()`），未启动时为 undefined
 * @example { protocol: "http", port: 7890, host: "0.0.0.0", running: true, startedAt: 1710000000000 }
 */
export interface ProxyStats {
  protocol: ProxyProtocol;
  port: number;
  host: string;
  running: boolean;
  startedAt?: number;
}

/**
 * 代理生命周期状态机
 * @description 状态流转：`idle → starting → running → stopping → stopped`，任意阶段异常进入 `error`；
 * 支持 `stopped → starting` 的重入重启。由 `BaseProxy` 模板方法驱动。
 * @example "running"
 */
export type LifecycleState = "idle" | "starting" | "running" | "stopping" | "stopped" | "error";

/**
 * 生命周期钩子契约
 * @description 供 `BaseProxy` 在 `start()` / `stop()` 模板流程中回调，子类可覆写以注入初始化/清理逻辑
 * @param onBeforeStart - 进入 `starting` 前调用，适合资源预检/证书加载
 * @param onStarted - 进入 `running` 后调用，适合事件绑定完成后的后处理
 * @param onBeforeStop - 进入 `stopping` 前调用，适合优雅关闭前的通知
 * @param onStopped - 进入 `stopped` 后调用，适合资源释放
 * @example class MyProxy extends BaseProxy { async onStarted(){ logger.info("ready"); } }
 */
export interface Lifecycle {
  onBeforeStart?(): Promise<void>;
  onStarted?(): Promise<void>;
  onBeforeStop?(): Promise<void>;
  onStopped?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 转发与事件契约
// ---------------------------------------------------------------------------

/**
 * 转发类型
 * @description `http` 普通 HTTP 请求转发；`tunnel` CONNECT 隧道；`upgrade` WebSocket 101 升级。
 * 现存于 `AppEventMap` 的 `request.started` / `forward.error` / `forward.request-headers` 三条公共事件
 * 与 server 层 `[forwardXxx error]` 日志前缀表（`src/server/index.ts:FORWARD_ERROR_LABEL`）。
 * @example "tunnel"
 */
export type ProxyForwardKind = "http" | "tunnel" | "upgrade";

/**
 * 认证审计事件
 *
 * @description `AuthContext.onAuthEvent` 的**内部审计回调契约**（`core/auth.ts` → `BaseProxy.authorize`），
 * **不是**事件总线的载荷：`BaseProxy.authorize` 读到它后转成 `AppEventMap` 的 `auth.decided`
 * （`{ passed, user?, attempted?, reason?, tag? }` 进 data，身份维度进 `EventContext`），
 * 原对象原样交给前一个 `onAuthEvent`（`prev`）继续走旁路。
 * @param passed - 是否通过认证
 * @param tag - 场景标签：隧道场景（CONNECT / socks*）为 `"tunnel"`，其余为空串
 * @param client - 客户端地址（由 `getClientAddress` 提取，可能来自 XFF，仅用于展示与审计）
 * @param target - 请求目标（authority / url）
 * @param user - 通过时的用户名（命中的账号名或 JWT 的 sub）
 * @param attempted - 未通过时尝试的用户名（经 `extractUserFromToken` 脱敏截断）
 * @param reason - 失败原因（如 `no-token`）
 * @example { passed: false, tag: "tunnel", client: "1.2.3.4", target: "example.com:443", reason: "no-token" }
 */
export interface ProxyAuthEvent {
  passed: boolean;
  tag: string;
  client: string;
  target: string;
  user?: string;
  attempted?: string;
  reason?: string;
  /**
   * 请求/连接标识：由 `BaseProxy.authorize` 从 `AuthContext` 取出并注入，
   * 使 `auth.decided` 能与该请求的终态事件按 requestId 串联。
   */
  requestId?: string;
  connectionId?: string;
}

/**
 * 代理内核抽象（生命周期 + 统计）
 * @description 继承 `Lifecycle` 钩子，叠加协议、选项、状态与启停能力；`BaseProxy` 为其抽象实现
 * @param protocol - 代理协议（只读）
 * @param options - 归一化后的完整选项（Required，构造期由显式配置与默认值补齐）
 * @param state - 当前生命周期状态（只读）
 * @param start - 启动代理（幂等，running 时直接返回）
 * @param stop - 停止代理（幂等，stopped 时直接返回）
 * @param isRunning - 是否处于 running 态
 * @param getStats - 获取统计快照
 * @example const core: ProxyCore = new HttpProxy({ port: 7890, ctx }); await core.start();
 */
export interface ProxyCore extends Lifecycle {
  readonly protocol: ProxyProtocol;
  readonly options: Readonly<Required<ProxyOptions>>;
  readonly state: LifecycleState;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getStats(): ProxyStats;
}

// ---------------------------------------------------------------------------
// 认证契约（叶模块 `auth.ts` 的来源）
// ---------------------------------------------------------------------------

/**
 * 认证所需的类请求对象（最小集）
 * @description 仅需 headers/url/socket/method 四字段，避免依赖完整的 `http.IncomingMessage`
 * @param headers - 请求头字典（键大小写不敏感，值可能为字符串或字符串数组）
 * @param url - 请求 URL（用于 target 回退展示）
 * @param socket - 底层 Duplex（用于提取远端地址，可选）
 * @param method - HTTP 方法（如 "CONNECT"），用于隧道场景 tag 判定；http.ts 传入的是真 `http.IncomingMessage`，运行时天然具备该字段
 * @example { headers: req.headers, url: req.url, socket, method: req.method }
 */
export interface AuthRequestLike {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  socket?: unknown;
  method?: string;
}

/**
 * 认证上下文
 * @description 每次 `authenticate` 调用时构造，携带协议、请求、通道与审计回调
 * @param protocol - 代理协议字符串（如 "http"）
 * @param req - 类请求对象
 * @param socket - 客户端 Duplex 通道
 * @param authority - 请求权威（CONNECT 的 authority 或普通请求的 host:port，用于日志 tag 与审计）
 * @param onAuthEvent - 审计事件回调（由 BaseProxy 注入，转抛为 proxy "auth" 事件）
 * @example { protocol: "http", req, socket, authority: "example.com:443", onAuthEvent: (e) => proxy.emit("auth", e) }
 */
export interface AuthContext {
  protocol: string;
  req: AuthRequestLike;
  socket: Duplex;
  authority: string;
  onAuthEvent?: (e: ProxyAuthEvent) => void;
  /**
   * 请求/连接标识：协议入口注入，`BaseProxy.authorize` 转填进 `ProxyAuthEvent`，
   * 使鉴权事件与该请求的终态事件共享 requestId。
   */
  requestId?: string;
  connectionId?: string;
}

/**
 * 认证结果类型
 * @description `passed` 通过与否；`username` 为通过时的用户名（basic/uid 取命中的账号名，
 * jwt 取 token 中的 sub/username）；未通过时不含用户名。
 * Auth 内部异常由 `BaseProxy.authorize` 捕获并视为 `{ passed: false }`
 * @example { passed: true, username: "alice" }
 */
export interface AuthResult {
  passed: boolean;
  username?: string;
}

/**
 * 单个账号（来源：AUTH_USERS_FILE 指向的 users.json）
 * @param username - 用户名，非空且不含 `:`（Basic 凭证为 `user:pass`，含冒号有歧义）
 * @param password - 密码，允许空串（uid 模式只用用户名）
 */
export interface AuthAccount {
  username: string;
  password: string;
}

/**
 * 认证提供者接口
 * @description 供 `BaseProxy.authorize()` 调用的统一认证入口
 * @example const r: AuthResult = await auth.authenticate({ protocol, req, socket, authority });
 */
export interface AuthProvider {
  authenticate(ctx: AuthContext): Promise<AuthResult>;
  readonly isEnabled?: boolean;
  readonly authType?: string;
}

/**
 * 认证构造选项
 * @param enabled - 是否启用认证
 * @param type - 认证类型：none（放行）/ basic（比对账号表用户名密码）/ jwt（委托 jwtVerify）/ uid（仅比对用户名，socks4 USERID）
 * @param accounts - 账号表（来源见 `AUTH_USERS_FILE`），basic/uid 时生效；空表一律判否
 * @param jwtSecret - JWT 校验密钥
 * @param jwtVerify - JWT 校验函数 `(token, secret) => Promise<boolean>`；直构 `Auth` 时 type=jwt 必填（未注入一律拒绝），`createAuthFromConfig()` 默认注入内置 HS256 实现 `defaultJwtVerify`，显式注入优先
 * @param enableLogging - 是否启用认证审计日志（缺省为 true；配置工厂可显式注入）
 * @example { enabled: true, type: "basic", accounts: [{ username: "alice", password: "pw1" }] }
 * @example { enabled: true, type: "uid", accounts: [{ username: "test", password: "" }] } // socks4 USERID
 * @example { enabled: true, type: "jwt", jwtSecret: "xxx", jwtVerify: async (t,s)=>true }
 */
export interface AuthOptions {
  enabled?: boolean;
  type?: "none" | "basic" | "jwt" | "uid";
  accounts?: AuthAccount[];
  jwtSecret?: string;
  jwtVerify?: (token: string, secret: string) => Promise<boolean>;
  enableLogging?: boolean;
}

// ---------------------------------------------------------------------------
// 管道事件契约（叶模块 `pipe.ts` 的来源）
// ---------------------------------------------------------------------------
// 判别字面量的权威在 `core/log-events.ts` 的 `LogEvent` 表：与日志事件重名的 9 个变体
// 一律写 `typeof LogEvent.Xxx`（运行时值一字不变），改码只动那张表一处。
/**
 * 事件公共维度（所有 pipe 变体共有，按需可选）
 * @param target - 目标地址（host:port 或 url）
 * @param user - 已鉴权用户名（由 server 层按连接注入，供日志按账号查询）
 * @param client - 客户端地址（服务端提取的对端/请求来源）
 * @param reason - 拒绝/命中原因（名单类为 whitelist|blacklist；route 事件为路由名单命中原因）
 */
export interface PipeEventBase {
  target?: string;
  message?: string;
  url?: string;
  req?: unknown;
  statusLine?: string;
  user?: string;
  client?: string;
  reason?: string;
  /**
   * 请求标识：由协议入口（`handleForward` 的逐请求事件槽）注入，同一请求的所有 pipe 事件共享。
   * 供 runtime bridge 把 mid-flight 事件与 `request.completed` 终态按请求串联。
   */
  requestId?: string;
  /** 连接标识：keep-alive 下同一 TCP 连接共享，SOCKS 与 requestId 同值。 */
  connectionId?: string;
}

/** 目标解析失败（absolute-form/Host 均解析不出目标） */
export interface PipeTargetUnresolvedEvent extends PipeEventBase {
  type: typeof LogEvent.TargetUnresolved;
}
/** 自环/上游回环（dial 指回自身监听地址） */
export interface PipeLoopDetectedEvent extends PipeEventBase {
  type: typeof LogEvent.LoopDetected;
}
/** 路由判定（有效模式 + direct/upstream + 命中原因；与 `[route]` 落盘行 1:1） */
export interface PipeRouteEvent extends PipeEventBase {
  type: "route";
  mode: "server" | "client";
  route: "direct" | "upstream";
}
/** 上游 CONNECT 非 200（带状态行原文） */
export interface PipeUpstreamRefusedEvent extends PipeEventBase {
  type: typeof LogEvent.UpstreamRefused;
}
/** 上游错误（拨号/等状态行/握手失败，成因上抛） */
export interface PipeUpstreamErrorEvent extends PipeEventBase {
  type: typeof LogEvent.UpstreamError;
  err?: unknown;
}
/** 上游超时（`DialTimeoutError`，落 504 路径） */
export interface PipeUpstreamTimeoutEvent extends PipeEventBase {
  type: typeof LogEvent.UpstreamTimeout;
}
/** 客户端 IP 名单拒绝（http/socks 同形） */
export interface PipeIpDeniedEvent extends PipeEventBase {
  type: typeof LogEvent.IpDenied;
  protocol?: string;
}
/**
 * 目标拒绝的判定层：全局 `acl.json` 还是该用户的个人名单（`users.json` 的 `acl`）
 * @description
 * 两层都是「黑名单命中 → 拒 / 白名单非空且未命中 → 拒」，但**权威性不同**：全局是运维的
 * 一刀切，个人名单只能更严、不能更松（`放行 ⇔ 全局放行 ∧ 个人放行`）。故拒绝时必须能
 * 区分是哪一层拒的，否则运维看到 403 不知道该改 `acl.json` 还是 `users.json`。
 *
 * 声明位置选在事件契约模块（本文件是 `PipeEvent` 的唯一真相源）：判定层
 * （`core/access-control.ts:AclDecision`）、pipe 事件、公共 `access.target-denied` 载荷
 * 三处共用这一个字面量联合，**不许**各自抄一份——抄错一处就会让某一层静默不发布事件。
 */
export type AclSource = "global" | "user";

/** 目标名单拒绝（target 名单/黑名单命中） */
export interface PipeTargetDeniedEvent extends PipeEventBase {
  type: typeof LogEvent.TargetDenied;
  host?: string;
  /**
   * 哪一层拒的（`global` / `user`）；**放行路径不写该键**，拒绝路径缺失即「未知来源」，
   * 消费方不得臆造（`runtime/bridge.ts:aclSource` 只认这两个值）。
   * 刻意**不**进 `PipeEventBase`：它是这一个变体独有的维度，且 `reason` 的
   * `whitelist|blacklist` 闭合集合同样不许被扩成 `"user:blacklist"` 之类
   * ——`runtime/bridge.ts:aclReason` 遇到表外值**静默不发布**事件。
   */
  source?: AclSource;
}
/** SOCKS 会话可读描述（成功/失败人类可读文本） */
export interface PipeSocksEvent extends PipeEventBase {
  type: "socks";
}
/** SOCKS 握手报文非法 */
export interface PipeBadRequestEvent extends PipeEventBase {
  type: typeof LogEvent.BadRequest;
}
/** 拨号守卫：开始拨号 */
export interface PipeDialEvent extends PipeEventBase {
  type: "dial";
}
/** 拨号守卫：已建链 */
export interface PipeEstablishedEvent extends PipeEventBase {
  type: "established";
}
/** 拨号守卫：客户端侧错误（半关闭联动） */
export interface PipeClientErrorEvent extends PipeEventBase {
  type: typeof LogEvent.ClientError;
  err?: unknown;
}
/** 兜底调试事件（无结构化维度，仅文本） */
export interface PipeDebugEvent extends PipeEventBase {
  type: "debug";
}

/**
 * 管道事件（判别联合）
 * @description
 * `type` 为字面量的**判别联合**取代原先的宽泛事件袋：每个变体的字段在编译期可见，
 * 消费端 `switch (e.type)` 可获得收窄类型，不再需要 `as string` / `as unknown` 强转。
 * - 生产者（forward/guard/helpers/server）只经 `ForwarderBase.emit` 发出
 * - 消费端（`src/server/index.ts:bindProxyEventLogs`）按 type 分发落盘
 * - 名单语义与路由判定见 `src/core/AGENTS.md`；`[route]` 与 `route` 事件 1:1
 * @example { type: "route", target: "example.com:80", mode: "server", route: "direct", reason: "blacklist" }
 */
export type PipeEvent =
  | PipeTargetUnresolvedEvent
  | PipeLoopDetectedEvent
  | PipeRouteEvent
  | PipeUpstreamRefusedEvent
  | PipeUpstreamErrorEvent
  | PipeUpstreamTimeoutEvent
  | PipeIpDeniedEvent
  | PipeTargetDeniedEvent
  | PipeSocksEvent
  | PipeBadRequestEvent
  | PipeDialEvent
  | PipeEstablishedEvent
  | PipeClientErrorEvent
  | PipeDebugEvent;

/** pipe 事件的判别键 */
export type PipeEventType = PipeEvent["type"];

/**
 * 管道事件汇（回调类型）
 * @example const sink: PipeEventSink = (e) => proxy.emit("pipe", e);
 */
export type PipeEventSink = (e: PipeEvent) => void;
