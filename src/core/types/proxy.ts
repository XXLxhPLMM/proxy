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
 * - 定义基于 Typed EventEmitter 的 `ProxyEventMap` 事件契约
 * - 定义代理内核的抽象接口（ProxyCore）
 * - 集中定义认证与管道事件等跨层契约
 * - 避免循环依赖：所有叶类型文件均指向本文件，禁止反向引入
 *
 * 设计要点：
 * - 单一来源原则：所有类型在此定义一处，其它文件只做类型转发，保证改动收敛
 * - 事件契约化：`ProxyEventMap` 将 `forward/forwardError/serverError/auth/pipe/...` 等事件
 *   的 payload 定为元组类型，配合泛型 EventEmitter 实现 emit/on 两端的编译期检查
 * - Duplex 抽象：CONNECT/Upgrade 场景下 `http.Server` 的 socket 为 `Duplex`（非 net.Socket），
 *   全链路统一使用 `Duplex` 以兼容 TLS 包装后的流
 * - 分层解耦：`ProxyCore` 只暴露生命周期与统计，不持有具体传输实现
 * - 零运行时：本文件仅含类型与接口，无任何运行时代码，可被 `erasableSyntaxOnly` 安全擦除
 *
 * 使用示例：
 * ```ts
 * import type { ProxyProtocol, ProxyOptions, ProxyCore, ProxyEventMap } from "@/core/types/proxy.js";
 * import { TypedEmitter } from "tiny-typed-emitter"; // 示例
 *
 * // 1) 构造代理选项
 * const opts: ProxyOptions = { host: "127.0.0.1", port: 1080, upstreamTimeout: 10_000 };
 *
 * // 2) 定义强类型事件发射器
 * class MyProxy extends (TypedEmitter<ProxyEventMap> as new() => TypedEmitter<ProxyEventMap>) implements ProxyCore {
 *   protocol: ProxyProtocol = "http";
 *   // ...实现 ProxyCore / ProxyEventMap 契约
 * }
 *
 * // 3) 监听转发事件（payload 类型由 ProxyEventMap 推导）
 * declare const proxy: MyProxy;
 * proxy.on("forward", (e) => console.log(e.kind, e.req.url));
 * proxy.on("auth", (e) => console.log(e.passed ? "allow" : "deny", e.client));
 * ```
 */

import type http from "node:http";
import type { Duplex } from "node:stream";
import type { TlsKeyCert } from "@/utils/net/tls.js";

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
 * @description 所有字段均为可选，缺省值由 `src/config/store.ts` 的 defaults 与 `ProxyServer` 的 baseOpts 补齐
 * @param port - 监听端口，未指定时由配置层注入
 * @param host - 监听地址，未指定时由配置层注入
 * @param auth - 认证提供者（实现 `AuthProvider`），由 `createAuthFromConfig()` 注入
 * @param upstreamTimeout - 上游拨号/请求超时（毫秒），同时用于隧道与 HTTP 转发
 * @param tls - TLS 证书上下文（供 https/sockss/tls 协议使用，来自 `loadTlsContext`）
 * @example { port: 7890, host: "127.0.0.1", upstreamTimeout: 10000 }
 */
export interface ProxyOptions {
  port?: number;
  host?: string;
  auth?: AuthProvider;
  upstreamTimeout?: number;
  tls?: TlsKeyCert;
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
 * `stopping` 期间（含 `stopped` 发布前的收尾窗口）`start()` 一律拒绝，不并发建服。
 * `error` 是**可重试**的诚实态而非终态：`stop()` 失败时底层 server 引用被保留，
 * 调用方可重试 `stop()`（重试会命中同一个 server），也可直接 `start()` 重新建服。
 * @example "running"
 */
export type LifecycleState = "idle" | "starting" | "running" | "stopping" | "stopped" | "error";

/**
 * 生命周期拒绝的稳定错误码
 * @description 生命周期错误码的**唯一类型来源**：`BaseProxy.start()` 在停机在途
 * （`stopInFlight` 存在或状态为 `stopping`）时一律以 `ERR_PROXY_STOP_IN_PROGRESS` 拒绝；
 * 旧代 start 被 stop 取消时使用 `ERR_PROXY_START_CANCELLED`；runtime service deadline
 * 超时使用 `ERR_PROXY_SERVICE_OPERATION_TIMEOUT`；core 关服（`closeServer`）在有界 deadline 内
 * 没等到 `close` 回调时使用 `ERR_PROXY_CLOSE_TIMEOUT`（句柄保留、可重试，绝不永久 pending）。
 * 各错误类的 `code` 字段以 `satisfies ProxyLifecycleErrorCode` 绑定到本联合（字面量漏登记即编译失败）。
 * `ProxyServer` 的停机 ownership 闸门抛同 code 的私有类（`instanceof` 不可跨层复用，只按 code 判定）。
 * runtime 只通过 type import 绑定本联合，不在运行时依赖 server/core 实现。
 * 调用方按 code 统一处理并在 full stop settle 后重试，不必区分是哪一层拒绝。
 * 新增码必须先登记进本联合再落地实现，禁止各处裸写字面量或另开 `string & {}` 之类的假扩展点。
 * @example (e as { code?: string }).code === "ERR_PROXY_STOP_IN_PROGRESS"
 */
export type ProxyLifecycleErrorCode =
  | "ERR_PROXY_START_CANCELLED"
  | "ERR_PROXY_STOP_IN_PROGRESS"
  | "ERR_PROXY_SERVICE_OPERATION_TIMEOUT"
  | "ERR_PROXY_CLOSE_TIMEOUT";

/**
 * 生命周期钩子契约
 * @description 供 `BaseProxy` 在 `start()` / `stop()` 模板流程中回调，子类可覆写以注入初始化/清理逻辑
 * @param onBeforeStart - 进入 `starting` 前调用，适合资源预检/证书加载
 * @param onStarted - 进入 `running` 后调用，适合事件绑定完成后的处理
 * @param onBeforeStop - 进入 `stopping` 前调用，适合优雅关闭前的通知
 * @param onStopped - `doStop` 之后、`stopped` 发布之前调用，适合资源释放；钩子抛错则状态转 `error`，不发布 `stopped`
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
 * @description `http` 普通 HTTP 请求转发；`tunnel` CONNECT 隧道；`upgrade` WebSocket 101 升级
 * @example "tunnel"
 */
export type ProxyForwardKind = "http" | "tunnel" | "upgrade";

/**
 * 转发开始事件
 * @param kind - 转发类型
 * @param req - 原始入站请求（`http.IncomingMessage`）
 * @param username - 鉴权通过的用户名（鉴权关闭或无用户名时为 undefined），用于把身份带进逐连接日志
 * @example { kind: "http", req, username: "alice" }
 */
export interface ProxyForwardEvent {
  kind: ProxyForwardKind;
  req: http.IncomingMessage;
  username?: string;
}

/**
 * 转发异常事件
 * @example { kind: "tunnel", error: new Error("ECONNREFUSED") }
 */
export interface ProxyForwardErrorEvent {
  kind: ProxyForwardKind;
  error: unknown;
}

/**
 * 服务端错误事件
 * @example { error, host: "0.0.0.0", port: 7890 }
 */
export interface ProxyServerErrorEvent {
  error: Error;
  host: string;
  port: number;
}

/**
 * 客户端连接错误事件
 * @description 不带 socket：`HttpProxy` 在 `clientError` 回调内已就地回 400 并结束 socket，
 * 上层只需按 error 落盘；客户端关联靠 `forward` 事件的 req/访问日志，而非逐错误传通道
 * @example { error: new Error("socket hang up") }
 */
export interface ProxyClientErrorEvent {
  error: Error;
}

/**
 * 认证审计事件
 * @description 由 `BaseProxy.authorize()` 转抛为 proxy 的 `auth` 事件，最终由 `ProxyServer.bindProxyEventLogs()` 统一落盘
 * @param passed - 是否通过认证
 * @param tag - 场景标签：隧道场景（CONNECT / socks*）为 `"tunnel"`，其余为空串；**通过与拒绝两侧都必带**，
 *   否则审计无法区分被拒的是普通请求还是隧道请求
 * @param client - 客户端地址（由 `getClientAddress` 提取，可能来自 XFF，仅用于展示与审计）
 * @param target - 请求目标（authority / url）
 * @param user - 通过时的用户名（命中的账号名或 JWT 的 sub）
 * @param attempted - 未通过时尝试的用户名（经 `extractUserFromToken` 脱敏截断）
 * @param reason - 失败原因（如 `no-token`）
 * @example { passed: false, tag: "tunnel", client: "1.2.3.4", target: "example.com:443", reason: "no-token" }
 * @example { passed: false, tag: "", client: "1.2.3.4", target: "http://example.com/x", reason: "bad-credentials" }
 */
export interface ProxyAuthEvent {
  passed: boolean;
  tag: string;
  client: string;
  target: string;
  user?: string;
  attempted?: string;
  reason?: string;
}

/**
 * 代理强类型事件映射表（Typed EventEmitter 契约）
 * @description key 为事件名，value 为元组形式的 payload；`BaseProxy` 泛型继承此接口后，
 * `emit/on` 均可在编译期校验事件名与参数类型是否匹配
 * @param forward - 转发开始
 * @param forwardError - 转发异常
 * @param serverError - 服务错误
 * @param clientError - 客户端错误
 * @param auth - 认证审计
 * @param pipe - 管道/路由事件（由转发层产生，原样透传 req/target/mode）
 * @param stateChange - 生命周期状态变更（next, prev）
 * @param listening - 监听就绪（host/port）
 * @param close - 服务关闭（无参）
 * @example proxy.on("stateChange", (next, prev) => console.log(prev, "->", next));
 */
export interface ProxyEventMap {
  forward: [e: ProxyForwardEvent];
  forwardError: [e: ProxyForwardErrorEvent];
  serverError: [e: ProxyServerErrorEvent];
  clientError: [e: ProxyClientErrorEvent];
  auth: [e: ProxyAuthEvent];
  pipe: [e: PipeEvent];
  stateChange: [next: LifecycleState, prev: LifecycleState];
  listening: [info: { host: string; port: number }];
  close: [];
}

/**
 * 代理内核抽象（生命周期 + 统计）
 * @description 继承 `Lifecycle` 钩子，叠加协议、选项、状态与启停能力；`BaseProxy` 为其抽象实现。
 * 启停均为幂等模板方法：重入复用同一在途 promise，绝不并发建服/关服。
 * @param protocol - 代理协议（只读）
 * @param options - 归一化后的完整选项（Required，构造期由 defaults 补齐）
 * @param state - 当前生命周期状态（只读）
 * @param start - 启动代理（running 时直接返回；停机在途时以 `ERR_PROXY_STOP_IN_PROGRESS` 拒绝）
 * @param stop - 停止代理（idle/stopped 时直接返回；stopping 时复用同一在途 stop promise）
 * @param isRunning - 是否处于 running 态
 * @param getStats - 获取统计快照
 * @example const core: ProxyCore = new HttpProxy({ port: 7890 }); await core.start();
 */
export interface ProxyCore extends Lifecycle {
  readonly protocol: ProxyProtocol;
  readonly options: Required<ProxyOptions>;
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
 * @param enableLogging - 是否启用认证审计日志（默认读取 store 的 authLogging）
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

/**
 * 管道路由事件（值传递）
 * @description 由转发层产生，经 `ProxyEventMap.pipe` 向 server 层透传；
 * 字段原样携带 req/target/mode，仅 upgrade 的报文 dump 含 message 形态
 * @param type - 全量：target-unresolved（解析失败，带 url）/ loop（http 自环裸 type，server 侧按 loop-detected 消费，带 req/target）/ route（路由决策，四转发器 emitRoute 统一发，带 target/mode + 路由判定 route/reason；server 模式短路不发）/ upstream-refused（上游 CONNECT 非 200，带 statusLine）/ ip-denied（客户端名单拒绝，带 client/reason/protocol）/ target-denied（目标名单拒绝，带 target/host/reason）/ debug（透传 message）
 * @param target - 目标地址（host:port）
 * @param mode - 代理模式（server / client；route 事件为**有效模式**，client 命中路由名单回落 server）
 * @param route - 路由判定（route 事件：direct | upstream）
 * @param message - 报文或描述文本（upgrade 场景）
 * @param url - 请求 URL
 * @param req - 原始请求对象（透传）
 * @param statusLine - 状态行（响应场景）
 * @param user - 已鉴权用户名（由 server 层按连接注入，供日志按账号查询）
 * @param client - 客户端地址（服务端提取的对端/请求来源）
 * @param reason - 拒绝原因（ip-denied/target-denied 为 whitelist|blacklist）；route 事件为路由名单命中原因
 * @example { type: "route", target: "example.com:80", mode: "server", route: "direct", reason: "blacklist" }
 */
export interface PipeEvent {
  type: string;
  target?: string;
  mode?: string;
  route?: string;
  message?: string;
  url?: string;
  req?: unknown;
  statusLine?: string;
  user?: string;
  client?: string;
  reason?: string;
  [k: string]: unknown;
}

/**
 * 管道事件汇（回调类型）
 * @example const sink: PipeEventSink = (e) => proxy.emit("pipe", e);
 */
export type PipeEventSink = (e: PipeEvent) => void;
