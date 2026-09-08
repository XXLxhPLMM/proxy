/**
 * @fileoverview 代理核心类型总表（Single Source of Truth）
 * @module core/types/proxy
 * @description
 * 本文件是整个代理内核的「类型总表」，集中定义协议、配置、生命周期、
 * 事件契约、转发载体与认证等所有共享类型，是其它叶模块（auth/pipe/
 * connector/server）的唯一上游来源，叶模块仅做 `export type { ... } from "./proxy.js"` 转发。
 *
 * 职责：
 * - 定义代理协议、选项、统计与生命周期状态机类型
 * - 定义基于 Typed EventEmitter 的 `ProxyEventMap` 事件契约
 * - 定义 HTTP 服务与代理内核的抽象接口（ProxyHttpServer / ProxyCore）
 * - 集中定义认证、管道事件与拨号器（Connector）等跨层契约
 * - 避免循环依赖：所有叶类型文件均指向本文件，禁止反向引入
 *
 * 设计要点：
 * - 单一来源原则：所有类型在此定义一处，其它文件只做类型转发，保证改动收敛
 * - 事件契约化：`ProxyEventMap` 将 `forward/forwardError/serverError/auth/pipe/...` 等事件
 *   的 payload 定为元组类型，配合泛型 EventEmitter 实现 emit/on 两端的编译期检查
 * - Duplex 抽象：CONNECT/Upgrade 场景下 `http.Server` 的 socket 为 `Duplex`（非 net.Socket），
 *   全链路统一使用 `Duplex` 以兼容 TLS 包装后的流
 * - 分层解耦：`ProxyCore` 只暴露生命周期与统计，不持有具体传输实现；
 *   `ProxyHttpServer` 只暴露请求/隧道/升级等钩子与启停方法
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
import type { TlsKeyCert } from "@/utils/cert.js";

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
 * @param isWorker - 是否为 cluster 子进程，决定日志与信号处理行为
 * @example { port: 7890, host: "127.0.0.1", upstreamTimeout: 10000, isWorker: false }
 */
export interface ProxyOptions {
  port?: number;
  host?: string;
  auth?: AuthProvider;
  upstreamTimeout?: number;
  tls?: TlsKeyCert;
  isWorker?: boolean;
}

/**
 * 代理运行时统计快照
 * @param protocol - 当前代理协议
 * @param port - 实际监听端口
 * @param host - 实际监听地址
 * @param running - 是否处于运行态
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
 * @description `http` 普通 HTTP 请求转发；`tunnel` CONNECT 隧道；`upgrade` WebSocket 101 升级
 * @example "tunnel"
 */
export type ProxyForwardKind = "http" | "tunnel" | "upgrade";

/**
 * 转发开始事件
 * @param kind - 转发类型
 * @param req - 原始入站请求（`http.IncomingMessage`）
 * @example { kind: "http", req }
 */
export interface ProxyForwardEvent {
  kind: ProxyForwardKind;
  req: http.IncomingMessage;
}

/**
 * 转发异常事件
 * @param kind - 转发类型
 * @param error - 捕获的异常对象（可能是 Error 或任意 throw 值）
 * @example { kind: "tunnel", error: new Error("ECONNREFUSED") }
 */
export interface ProxyForwardErrorEvent {
  kind: ProxyForwardKind;
  error: unknown;
}

/**
 * 服务端错误事件
 * @param error - 服务底层抛出的 Error
 * @param host - 监听地址
 * @param port - 监听端口
 * @example { error, host: "0.0.0.0", port: 7890 }
 */
export interface ProxyServerErrorEvent {
  error: Error;
  host: string;
  port: number;
}

/**
 * 客户端连接错误事件
 * @param error - 客户端 socket 触发的错误
 * @example { error: new Error("socket hang up") }
 */
export interface ProxyClientErrorEvent {
  error: Error;
}

/**
 * 认证审计事件
 * @description 由 `BaseProxy.authorize()` 转抛为 proxy 的 `auth` 事件，最终由 `ProxyServer.bindProxyEventLogs()` 统一落盘
 * @param passed - 是否通过认证
 * @param tag - 场景标签（如 `tunnel ` 前缀用于 CONNECT 隧道区分）
 * @param client - 客户端地址（由 `getClientAddress` 提取）
 * @param target - 请求目标（authority / url）
 * @param user - 通过时的用户名（basic 的 username 或 JWT 的 sub）
 * @param attempted - 未通过时尝试的用户名（经 `extractUserFromToken` 脱敏截断）
 * @param expected - 期望的用户名（用于提示配置）
 * @param reason - 失败原因（如 `no-token`）
 * @example { passed: false, tag: "", client: "1.2.3.4", target: "example.com:443", reason: "no-token" }
 */
export interface ProxyAuthEvent {
  passed: boolean;
  tag: string;
  client: string;
  target: string;
  user?: string;
  attempted?: string;
  expected?: string;
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
 * @param pipe - 管道/路由事件（由 `createPipeEmitter` 产生，原样透传 req/target/mode）
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
 * HTTP 传输层服务器抽象（适配器接口）
 * @description 统一 `HttpServer` / `HttpsServer` 的对外形态，屏蔽 `http.Server` 与 `https.Server` 差异；
 * 上层 `BaseProxy` / `HttpProxy` 仅依赖此接口而非具体 Node Server 类型
 * @param onRequest - 普通 HTTP 请求回调 `(req, res) => void`
 * @param onConnect - CONNECT 隧道回调 `(req, socket, head) => void`
 * @param onUpgrade - WebSocket Upgrade 回调 `(req, socket, head) => void`
 * @param onError - 服务错误回调
 * @param onClientError - 客户端错误回调（含触发错误的 Duplex）
 * @param onClose - 服务关闭回调
 * @param onListening - 监听就绪回调
 * @param start - 启动监听（异步）
 * @param close - 关闭服务（异步）
 * @param started - 是否已启动（只读）
 * @example const srv: ProxyHttpServer = new HttpServer({ host, port }); await srv.start();
 */
export interface ProxyHttpServer {
  onRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  onConnect?: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  onUpgrade?: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  onError?: (err: Error) => void;
  onClientError?: (err: Error, socket: Duplex) => void;
  onClose?: () => void;
  onListening?: () => void;
  start(): Promise<void>;
  close(): Promise<void>;
  readonly started: boolean;
}

/**
 * 代理内核抽象（生命周期 + 统计）
 * @description 继承 `Lifecycle` 钩子，叠加协议、选项、状态与启停能力；`BaseProxy` 为其抽象实现
 * @param protocol - 代理协议（只读）
 * @param options - 归一化后的完整选项（Required，构造期由 defaults 补齐）
 * @param state - 当前生命周期状态（只读）
 * @param start - 启动代理（幂等，running 时直接返回）
 * @param stop - 停止代理（幂等，stopped 时直接返回）
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
 * @description 仅需 headers/url/socket 三字段，避免依赖完整的 `http.IncomingMessage`
 * @param headers - 请求头字典（键大小写不敏感，值可能为字符串或字符串数组）
 * @param url - 请求 URL（用于 target 回退展示）
 * @param socket - 底层 Duplex（用于提取远端地址，可选）
 * @example { headers: req.headers, url: req.url, socket }
 */
export interface AuthRequestLike {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  socket?: unknown;
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
 * 令牌提取器接口
 * @description 负责从 `AuthContext` 中抽取原始令牌；当前仅实现 header 提取（Proxy-Authorization 优先，Authorization 回退）
 * @param extract - 提取方法，返回令牌字符串或 undefined（未携带）
 * @returns 令牌或 undefined；支持同步或异步实现
 * @example class HeaderExtractor implements TokenExtractor { extract(ctx){ return ctx.req.headers["proxy-authorization"] as string; } }
 */
export interface TokenExtractor {
  extract(ctx: AuthContext): Promise<string | undefined> | string | undefined;
}

/**
 * 认证结果类型别名
 * @description `true` 通过，`false` 拒绝；Auth 内部异常由 `BaseProxy.authorize` 捕获并视为拒绝
 * @example true
 */
export type AuthResult = boolean;

/**
 * 认证提供者接口
 * @description 供 `BaseProxy.authorize()` 调用的统一认证入口
 * @param authenticate - 异步认证方法，入参为 AuthContext，返回 AuthResult
 * @returns Promise<boolean> 是否通过
 * @example const ok: boolean = await auth.authenticate({ protocol, req, socket, authority });
 */
export interface AuthProvider {
  authenticate(ctx: AuthContext): Promise<AuthResult>;
}

/**
 * 认证构造选项
 * @param enabled - 是否启用认证
 * @param type - 认证类型：none（放行）/ basic（对比用户名密码）/ jwt（委托 jwtVerify）
 * @param username - Basic 认证用户名
 * @param password - Basic 认证密码
 * @param jwtSecret - JWT 校验密钥
 * @param extractor - 自定义令牌提取器（可选，未提供时 Auth 内部使用 header 直提）
 * @param jwtVerify - JWT 校验函数 `(token, secret) => Promise<boolean>`，type=jwt 时必填
 * @param enableLogging - 是否启用认证审计日志（默认读取 store 的 authLogging）
 * @example { enabled: true, type: "basic", username: "admin", password: "s3cr3t" }
 * @example { enabled: true, type: "jwt", jwtSecret: "xxx", jwtVerify: async (t,s)=>true }
 */
export interface AuthOptions {
  enabled?: boolean;
  type?: "none" | "basic" | "jwt";
  username?: string;
  password?: string;
  jwtSecret?: string;
  extractor?: TokenExtractor;
  jwtVerify?: (token: string, secret: string) => Promise<boolean>;
  enableLogging?: boolean;
}

// ---------------------------------------------------------------------------
// 管道事件与拨号器契约（叶模块 `pipe.ts` / `connector.ts` 的来源）
// ---------------------------------------------------------------------------

/**
 * 管道路由事件（值传递）
 * @description 由 `forward/shared.ts:createPipeEmitter` 产生，经 `ProxyEventMap.pipe` 向 server 层透传；
 * 字段原样携带 req/target/mode，仅 upgrade 的报文 dump 含 message 形态
 * @param type - 事件类型（如 loop-detected / route / upgrade-raw 等）
 * @param target - 目标地址（host:port）
 * @param mode - 代理模式（server / client）
 * @param message - 报文或描述文本（upgrade 场景）
 * @param url - 请求 URL
 * @param req - 原始请求对象（透传）
 * @param statusLine - 状态行（响应场景）
 * @param kind - 转发类型细分
 * @param note - 备注
 * @example { type: "route", target: "example.com:80", mode: "server", url: "/api" }
 */
export interface PipeEvent {
  type: string;
  target?: string;
  mode?: string;
  message?: string;
  url?: string;
  req?: unknown;
  statusLine?: string;
  kind?: string;
  note?: string;
  [k: string]: unknown;
}

/**
 * 管道事件汇（回调类型）
 * @param e - 管道事件对象
 * @example const sink: PipeEventSink = (e) => proxy.emit("pipe", e);
 */
export type PipeEventSink = (e: PipeEvent) => void;

/**
 * 上游目标（拨号地址）
 * @param host - 目标主机名/IP
 * @param port - 目标端口
 * @param secure - 是否为 TLS 承载（true 则使用 tls.connect）
 * @example { host: "example.com", port: 443, secure: true }
 */
export interface UpstreamTarget {
  host: string;
  port: number;
  secure?: boolean;
}

/**
 * 拨号句柄
 * @description 拨号成功后返回的句柄，持有已建立的 Duplex 通道
 * @param socket - 已连接的上游 Duplex（net.Socket 或 tls.TLSSocket）
 * @example { socket: upstreamSocket }
 */
export interface DialHandle {
  socket: Duplex;
}

/**
 * 拨号回调（Node 回调风格）
 * @param err - 失败时的 Error，成功时为 undefined
 * @param handle - 成功时的句柄，失败时为 undefined
 * @example (err, handle) => { if(err) return cb(err); handle.socket.write(...); }
 */
export type DialCallback = (err?: Error, handle?: DialHandle) => void;

/**
 * 拨号器接口（函数式契约）
 * @description 统一各类 UpstreamConnector 的拨号形态，供 `forward/shared.ts:dialUpstream` 调用
 * @param dial - 拨号方法 `(target, cb) => void`
 * @example const dialer: ConnectorDial = new NetUpstreamConnector(); dialer.dial({host,port}, cb);
 */
export interface ConnectorDial {
  dial(target: UpstreamTarget, cb: DialCallback): void;
}

/**
 * 拨号结果（Promise 风格封装）
 * @description `shared.ts:dialUpstream` 将回调式拨号包装为 Promise 后返回的双重句柄
 * @param socket - 上游 Duplex（与 dial.socket 同一对象，便于直接 pipe）
 * @param dial - 完整句柄对象
 * @example const { socket } = await dialUpstream(target, sink);
 */
export interface DialResult {
  socket: Duplex;
  dial: DialHandle;
}
