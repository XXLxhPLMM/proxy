/**
 * @fileoverview 转发计划契约 - 路由决策与传输策略之间的唯一接缝
 * @module core/types/plan
 * @description
 * 本文件定义「转发器插件只消费计划、绝不自己查配置」的契约。这是把
 * `dial.ts` 里那棵 665 行的 if/switch 分支树劈成两层的接缝：
 *
 * ```
 * 入站协议插件            RoutingProvider 插件           ForwarderProvider 插件
 * (解析协议/回应答)  ──▶  (决定走直连还是上游)  ──▶  (按 plan.transport 选策略)
 *      │                        │                            │
 *      │                        ▼                            ▼
 *      └── RoutingInput ──▶ ForwardPlan（自包含：目标 + 上游 + 传输方式 + 超时）
 * ```
 *
 * 关键不变量（破坏其中任何一条都等于退回全局配置）：
 * - **ForwardPlan 必须自包含**。`upstream` 目标由路由插件在决策时填好，
 *   转发器插件**一个配置项都不读**。此前 `resolveForwardTargets()` 现场
 *   `get("upstreamHost")`，于是「选上游」和「连上游」耦死在同一处——
 *   既没法换路由策略，也没法在同进程里让两个实例走不同上游。
 * - **`listen` 随计划走**。自环判定需要「本实例的监听地址」，它属于实例而非全局；
 *   放进 plan 后转发器不需要知道任何实例上下文。
 * - **`upstreamTls` 随计划走**。出站 TLS 校验策略（`upstreamInsecure` / `upstreamCa`）
 *   曾是「转发器零配置读取」原则的**唯一例外**：基类 `tlsPolicy()` 每次转发现读
 *   `deps.config.scope`。冻结进计划后例外消失，传输策略不必再持有 `ConfigProvider`。
 *   **热加载能力不丢**：路由插件每次 `plan()` 都现读 scope 生成新计划，改完配置
 *   对**新请求**立即生效（与 `timeoutMs` / `upstream` 同一套机制）。
 * - 计划是**值对象**，不是回调、不持有 socket、不跨事件总线。字节流永远不
 *   进事实事件（本文件是那条禁令下能表达控制流的方式）。
 *
 * @example
 * ```ts
 * // 路由插件产出一个「经 http 上游转发普通 HTTP 请求」的计划
 * const plan: ForwardPlan = {
 *   inbound: "http",
 *   transport: "http-upstream",
 *   target: { host: "example.com", port: 80, path: "/api?q=1" },
 *   upstream: { protocol: "http", host: "127.0.0.1", port: 8080, secure: false },
 *   payload: "http-request",
 *   timeoutMs: 10_000,
 *   listen: { host: "0.0.0.0", port: 3000 },
 *   upstreamTls: { insecure: false, ca: "" },
 * };
 * ```
 */

import type { Duplex } from "node:stream";
import type http from "node:http";
import type { ProxyProtocol } from "./proxy.js";
import type { AclScope, AuthProvider } from "@/plugins/contracts.js";

/**
 * 入站通道类型 - 客户端用什么形态发起了这次请求
 * @description 决定协议插件负责应答的形态（HTTP 响应 / 状态行 / SOCKS 二进制），
 * 与传输策略**正交**：同一个 `connect` 通道既可能直连也可能经上游。
 * @example "connect"
 */
export type ForwardInbound = "http" | "connect" | "upgrade" | "socks";

/**
 * 传输策略标识 - ForwarderProvider 注册表的键
 * @description
 * 这是**传输方式**维度，与 `ForwardInbound`（入站协议维度）正交。
 * 新增一种传输方式 = 往注册表加一个实现，不改任何既有策略
 * （此前 `dial.ts` 的分支树把这两个维度缠在一起，加一种要动全部代码）。
 * @example "socks-upstream"
 */
export type ForwardTransport = "direct-stream" | "http-upstream" | "socks-upstream";

/**
 * 载荷形态 - 转发器拿到目标后要搬什么
 * @description `http-request` 走 `http.request`/`https.request`（有语义、可复用连接池），
 * 其余走裸流桥接。刻意不合并：二者的失败语义、超时语义、报文整形都不同。
 * @example "raw-stream"
 */
export type ForwardPayload = "http-request" | "raw-stream";

/**
 * 客户端请求的目标（名单判定对象）
 * @param host - 目标主机名或 IP 字面量（IPv6 不带方括号）
 * @param port - 目标端口
 * @param path - 请求路径（含 query）；隧道与 SOCKS 场景为空串
 * @example { host: "example.com", port: 443, path: "" }
 */
export interface ForwardTarget {
  host: string;
  port: number;
  path: string;
}

/**
 * 上游代理端点 - 由路由插件在决策时解析完毕
 * @param protocol - 上游协议（决定 CONNECT / SOCKS 握手 / TLS 承载）
 * @param host - 上游主机名或 IP 字面量
 * @param port - 上游端口
 * @param secure - 是否 TLS 承载
 * @param username - 上游 Basic 用户名（仅显式配置时存在）
 * @param password - 上游 Basic 密码
 * @example { protocol: "socks5", host: "127.0.0.1", port: 1080, secure: false }
 */
export interface UpstreamEndpoint {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
}

/**
 * 转发计划 - 路由插件的产物，转发器插件的唯一输入
 * @description 自包含：目标、上游、传输方式、载荷、超时、出站 TLS 策略、自环判定基准全在里面。
 * 转发器**禁止**再查任何配置（本实例的上游地址/超时/凭证/证书校验策略都已在生成计划时冻结）。
 * @param inbound - 入站通道
 * @param transport - 传输策略标识，对应 ForwarderProvider 注册表的键
 * @param target - 客户端请求的目标（ACL 的 `target`/`upstream` 名单判定对象）
 * @param upstream - 上游端点；`transport` 为 `direct-stream` 时**必须缺省**
 * @param payload - 载荷形态
 * @param timeoutMs - 拨号与转发的超时预算（毫秒）
 * @param listen - 本实例监听地址，供自环判定；客户端要访问的目标指回它即拒绝
 * @param upstreamTls - 出站 TLS 校验策略（形状同 `forward/dial.ts:UpstreamTlsPolicy`；
 *   就地展开而非命名别名，避免 `types/plan` → `forward/dial` 的反向依赖）
 * @param routeReason - 路由回落原因（命中名单直连时记录，供 `[route]` 日志一行）
 * @example 见文件头
 */
export interface ForwardPlan {
  readonly inbound: ForwardInbound;
  readonly transport: ForwardTransport;
  readonly target: ForwardTarget;
  readonly upstream?: UpstreamEndpoint;
  readonly payload: ForwardPayload;
  readonly timeoutMs: number;
  readonly listen: { host: string; port: number };
  readonly upstreamTls: { insecure: boolean; ca: string };
  readonly routeReason?: string;
  /**
   * 路由回落来源（`instance` / `user`）——「是哪一道闸门要求直连的」
   * @description 与 `routeReason` 成对出现：后者是自由文本（`blacklist`/`whitelist`，
   * `[route]` 行的稳定 grep 契约），本字段是新增的诊断维度，落到日志的 `scope` 字段。
   * 缺省 = server 模式短路（非 client），或走上游。
   */
  readonly routeScope?: AclScope;
}

/**
 * 路由判定被拒 - 不是 ForwardPlan 的变体，而是「没有计划」
 * @description 与计划分开建模，避免用 `plan: ForwardPlan | undefined` 让调用方
 * 到处写可空判断；拒绝必须携带可执行的原因与状态码。
 * @param reason - 拒绝原因标识（稳定 grep 契约，如 `loop-detected` / `target-denied`）
 * @param status - 协议应答状态码（HTTP 403/502；SOCKS 侧由协议插件忽略）
 * @param detail - 人类可读细节（进日志字段，不进协议应答）
 */
export interface RoutingRejection {
  readonly reason: string;
  readonly status: number;
  readonly detail?: string;
  /**
   * 判定来源（`instance` = 实例级 `acl.json`，`user` = 该账号自己的名单）
   * @description **刻意与 `detail` 分开两个字段**：`detail` 承载 `blacklist|whitelist`，
   * 是 `[target-denied]` 的稳定 grep 契约，一个字都不能挪；来源是新增的诊断维度，
   * 落到事件的 `scope` 字段上。缺省表示非名单类拒绝（自环）。
   */
  readonly scope?: AclScope;
}

/**
 * 路由决策的产物
 * @description 计划与拒绝是互斥的两条成功路径，用可辨识联合让调用方穷尽。
 */
export type RoutingOutcome =
  | { readonly ok: true; readonly plan: ForwardPlan }
  | { readonly ok: false; readonly rejection: RoutingRejection };

/**
 * 路由插件的输入 - 协议插件在「目标已解析、尚未拨号」处交给路由层的东西
 * @param inbound - 入站通道
 * @param target - 客户端请求的目标
 * @param requestPath - 原始 request-target（client 模式串联给上游时必须是 absolute-form）
 * @param clientAddress - 客户端对端地址（审计用；名单判定另走 `AccessControlProvider`，
 *   它自己从 scope 取实例名单并按需叠加该账号的名单）
 * @param username - 已鉴权用户名。**四条入站都必须填**（此前 http/connect/upgrade 三条经
 *   `responder.username` 取值、而那三处恒为空串，导致账号级名单在这三条通道上静默失效）；
 *   SOCKS 每会话传参。无鉴权（`AUTH_ENABLED=false`）为 undefined。既是审计字段，
 *   也是**账号级名单与配额的身份输入**（`RoutingProvider.plan()` 据此调
 *   `acl.checkTargetHost(host, username)` / `checkUpstreamRoute(host, username)`）。
 * @param incoming - 入站请求对象（转发器可能要复用其头；SOCKS 场景可缺省）
 */
export interface RoutingInput {
  readonly inbound: ForwardInbound;
  readonly target: ForwardTarget;
  readonly requestPath: string;
  readonly clientAddress?: string;
  readonly username?: string;
  readonly incoming?: http.IncomingMessage;
}

/**
 * 上游应答的透传载荷 - `ProtocolResponder.relayUpstreamResponse` 的入参
 * @description
 * 「上游给了应答，但不是我要的成功码」这件事**只有协议层知道怎么答**：裸 socket 通道
 * 把状态行原样写回客户端即可，HTTP 通道要写 `ServerResponse`（含 `Proxy-Authenticate`
 * 等上游头），SOCKS 通道**根本不能答**（把 HTTP 字节写进 SOCKS 流就是协议污染）。
 * 传输策略因此只交事实，形态由应答器自决。
 *
 * @param status - 上游状态码（数值化后的三位码；`readResponseHead` 已严格提取）
 * @param statusLine - 上游原始状态行（只进日志字段与 `upstream-refused` 事件，不进报文）
 * @param head - 上游应答首包：状态行 + 响应头 + **紧随其后的已读字节**（可能为空）。
 *   裸 socket 通道原样写给客户端即可保住「非 200 也透传不断链」的语义
 * @param socket - 已建链的上游（应答器负责销毁：应答写完它就没有存在意义了）
 * @param incoming - `http-request` 载荷的**正常**上游响应（Node 已解析好的 `IncomingMessage`）。
 *   HTTP 通道据此 `writeHead(statusCode, headers)` + `pipe`；裸 socket 通道恒为 undefined
 */
export interface UpstreamResponseRelay {
  status: number;
  statusLine: string;
  head?: Buffer;
  socket?: Duplex;
  incoming?: http.IncomingMessage;
}

/**
 * 协议应答器 - 由**入站协议插件**注入，转发器用它应答而不必认识协议
 * @description
 * 这是让转发器插件保持协议无关的关键：HTTP 要写 `ServerResponse` 头、
 * SOCKS 要回二进制 reply、CONNECT/Upgrade 要往裸 socket 写状态行——三者形态
 * 本质不同，强行统一是假抽象。于是反转依赖：**协议插件把「怎么应答」作为
 * 闭包交给转发器**，转发器只说「建链成功了」或「失败了，回 403」。
 *
 * 转发器因此完全不需要 `import http`、不认识 `ServerResponse`、不知道 SOCKS
 * 字节序，也就与入站协议彻底解耦。
 */
export interface ProtocolResponder {
  /**
   * 建链成功后的协议应答（HTTP 200 / SOCKS replySuccess / Upgrade 101）。
   * @param extra.head - 上游在应答之后先发到的余量，转发器已代为回灌给客户端时可省
   * @param extra.local - 出站 socket 的本地绑定，供 SOCKS 应答填 BND.ADDR/BND.PORT
   */
  establish(extra?: { head?: Buffer; local?: { host: string; port: number } }): void;
  /**
   * 拨号前失败（自环/名单拒绝/超时/连接错误）时的协议应答。
   * @param status - 语义状态码；协议插件决定映射到 403/502/504 还是 SOCKS FAIL
   * @param detail - 人类可读原因（只进日志，不进协议报文）
   */
  fail(status: number, detail?: string): void;
  /**
   * 上游应答透传（**可选**）：把上游非预期状态码的响应交给协议层自己答
   * @description
   * **不实现即视为「本协议无法透传」**：传输策略回退到「写预拼状态行 / `fail(502)`」。
   * SOCKS 通道**刻意不实现**（把 HTTP 字节写进 SOCKS 流是协议污染），它一律回 FAIL。
   * `http-request` 载荷遇到上游应答时**必须**经本钩子（`incoming` 形态）交出去，
   * 不得降级成 502 —— 上游的 404/407/500 对客户端都是有效应答。
   * @param info - 见 {@link UpstreamResponseRelay}
   */
  relayUpstreamResponse?(info: UpstreamResponseRelay): void;
  /** 本次会话已鉴权用户名（供审计事件；未鉴权为空串） */
  readonly username: string;
}

/**
 * 转发器插件的执行上下文 - 计划之外唯一允许出现的东西
 * @description 只承载**本次连接**的活对象（socket / 请求 / 事件汇 / 应答器），
 * 绝不承载配置：配置在 `ForwardPlan` 里已经冻结完毕。唯一的非活对象是
 * {@link ForwarderContext.auth}，它是**判据**不是配置（无状态、每实例一个实现）。
 * @param plan - 本次转发计划
 * @param responder - 协议应答器（协议插件注入，转发器不认协议）
 * @param client - 客户端双工流（CONNECT/Upgrade/SOCKS 与 http 通道的连接生命周期都靠它；
 *   `http-request` 载荷场景用于「客户端中断即销毁上游请求」）
 * @param request - 入站请求（`http-request` 载荷场景；转发器只读其头与 URL）
 * @param head - 劫持时已读到的首包余量（需回灌给上游）
 * @param emit - 事实事件汇（core 零日志：只发事实，落盘在 server/plugin 层）
 * @param auth - 本实例鉴权插件（**出站凭证剥离的唯一判据**：`isOwnCredential` 与
 *   入站鉴权同源，漂移就会把代理凭证泄漏给目标站）
 */
export interface ForwarderContext {
  readonly plan: ForwardPlan;
  readonly responder: ProtocolResponder;
  readonly client?: Duplex;
  readonly request?: http.IncomingMessage;
  readonly head?: Buffer;
  readonly emit: (event: ForwardFact) => void;
  readonly auth: AuthProvider;
}

/**
 * 转发过程事实事件 - 只表达「发生了什么」，不承担控制流
 * @description
 * 转发器**只发事实、不做决策**：超时、上游拒绝、目标非法都发事件，
 * 由 server/plugin 插件层按类型落盘。成败应答归协议插件（HTTP 响应 /
 * SOCKS 二进制 reply 形态本质不同，强行统一是假抽象）。
 * @param type - 事实类型（稳定 grep 契约，见 `utils/log/events.ts`）
 * @param fields - 结构化字段（target / route / mode / statusLine 等）
 */
export interface ForwardFact {
  readonly type: string;
  readonly [key: string]: unknown;
}
