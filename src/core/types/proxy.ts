/**
 * @fileoverview 代理核心类型总表（Single Source of Truth）
 * @module core/types/proxy
 * @description
 * 本文件是整个代理内核的「类型总表」，集中定义协议、配置、生命周期、事件契约、
 * 转发载体、身份与访问控制等所有共享类型，是其它叶模块（identity/pipe）的唯一上游来源，
 * 叶模块仅做 `export type { ... } from "./proxy.js"` 转发。
 *
 * 三条 `import type` 出边全部编译期擦除，故本文件对 `log-events.js` / `context.js` /
 * `connector/index.js` 都不产生运行期依赖边；`connector/registry.ts` 反过来只 type-only 引本表，
 * 环被切断。
 *
 * 设计要点：
 * - 单一来源原则：所有类型在此定义一处，其它文件只做类型转发，保证改动收敛
 * - **「Auth」只剩审计语义**：`AuthAccount`（账号表条目）与 `ProxyAuthEvent`（鉴权审计事件）
 *   两个名字**刻意保留**——它们描述的是数据而不是识别方式，改名只会给调用方凭空加一次翻译；
 *   端口名（`IdentityProvider` 等）则零 Auth 化
 * - **事件契约只有一份**：core 的全部事实（含生命周期跃迁 `lifecycle.changed`）都由
 *   `core/events/types.ts:AppEventMap` 声明。`types/` 下**零 EventEmitter 事件表**，
 *   也没有 Node `EventEmitter<…>` 那一层契约
 * - Duplex 抽象：CONNECT/Upgrade 场景下 `http.Server` 的 socket 为 `Duplex`（非 net.Socket），
 *   全链路统一使用 `Duplex` 以兼容 TLS 包装后的流
 * - 零运行时：本文件仅含类型与接口，无任何运行时代码，可被 `erasableSyntaxOnly` 安全擦除
 */

import type { Duplex } from "node:stream";
import type { TlsKeyCert } from "@/utils/tls/index.js";
import type { CoreContext } from "@/core/context.js";
import type { TrafficAccount } from "@/core/traffic/index.js";
import type { ConnectorSource } from "@/core/forward/upstream/connector/index.js";
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
 * @param port - 监听端口
 * @param host - 监听地址
 * @param upstreamTimeout - 上游拨号/请求超时（毫秒），同时用于隧道与 HTTP 转发
 * @param tls - TLS 证书上下文（供 https/sockss/tls 协议使用，来自 `loadTlsContext`）
 * @param isWorker - 是否为 cluster 子进程，决定日志与信号处理行为
 * @example { port: 7890, host: "127.0.0.1", upstreamTimeout: 10000, isWorker: false, ctx }
 */
export interface ProxyOptions {
  port?: number;
  host?: string;
  /**
   * 身份提供者（`@/core/identity` 的 `IdentityProvider` 端口）。**可注入**：库调用方经
   * `createProxyRuntime({ services: { identity } })` 换掉配置驱动的默认实现；core 与四条
   * 入站通道只认端口，永不自己造实现。
   *
   * **缺省 = 显式 inert 档**（`noneIdentity()`，恒放行、恒不剥任何出站凭证）：直构 core 的
   * 低层调用方没注入它时有一个语义明确的答案——**不判定、只放行**，而不是「忘注入」变成
   * 运行期怪问题。归一在 `BaseProxy` 构造期做**一次**，之后 core 侧拿到的恒为非 optional 的端口
   * （见 `CoreServices` 与 `Required<ProxyOptions>`）。真正的默认实现（读 `users.json` +
   * 四个 `AUTH_TYPE` 模式）只在唯一组装点 `runtime/services.ts:buildDefaultServices` 解析，
   * core 内部零缺省解析。
   */
  identity?: IdentityProvider;
  upstreamTimeout?: number;
  tls?: TlsKeyCert;
  isWorker?: boolean;
  /**
   * 每用户流量配额服务（`@/core/traffic` 的 `TrafficAccount` 端口）。**可注入**，缺省 =
   * 显式禁用档（`inertTrafficAccount()`，不计量、不判定），与上面 `identity` 的缺省档
   * **完全同构**（含「真正的默认实现只在唯一组装点解析」与「只在 `BaseProxy` 构造期归一一次」）。
   */
  traffic?: TrafficAccount;
  /**
   * 访问控制服务（`AccessControl` 端口）。**必填、无缺省、无 inert 档**——**可注入**：库调用方
   * 经 `createProxyRuntime({ services: { access } })` 换掉配置驱动实现
   * （`createFileAccessControl(config)`，读 `acl.json` / `users.json` 的两层名单）。
   *
   * ### 为什么它是**唯一**没有缺省档的可注入位（与 `identity` / `traffic` 方向相反）
   *
   * 另两个端口的「缺席」都读作**关闭一项功能**（不判人 / 不计量），各有语义明确的 inert 档，
   * 让「忘注入」变成运行期一个**说得清**的答案。`access` 的缺席读作的是**取消防护**：缺省即
   * 全放行，而**全放行是所有失败形态里最危险的一种**——黑名单命中仍返回 200、SOCKS 应答
   * `05 00` 而非 `05 01`、该回落直连的请求走上游，**且零信号**。判据是仓库的通用纪律
   * 「**缺席会走到哪条路**」：对 `access` 而言缺席走到「放行」，于是「忘注入」必须在**编译期**红
   * ——这正是本字段**不带 `?`** 的全部理由。
   *
   * 代价如实记：低层直构 core 的调用方（测试、嵌入方）从此必须显式写一份判定。**想要
   * 「不判名单」就写一份显式放行实现**（三个方法恒放行 / `checkRoute` 恒 `{direct:false}`），
   * 那比「省略这一项」多一行代码，换来的是「这行是**你写的决定**」而不是「core 替你猜的」。
   * 真正的默认实现只在唯一组装根 `createProxyRuntime` →
   * `runtime/services.ts:buildDefaultServices` 解析；core 内部零缺省解析，`BaseProxy` 构造期
   * 对 `access` 也**零 `??` 归一**，直接透传。护栏 `tests/unit/access-control-port.test.ts`。
   *
   * ⚠️ 库调用方经 `services.access` 注入替身时**`acl.json` 整份不生效**（两份真相源只留一份，
   * 正当用法）；`acl-inert` 启动期告警由 `runtime/services.ts` 出。
   */
  access: AccessControl;

  /**
   * 上游接入来源（`ConnectorSource`：装配期已定死的「直连 / 走上游」两档）。
   * - **可注入**：库调用方可整体替换上游接入（自研协议、隧道中继、代理链），不必碰配置文件。
   * - **缺省 = `createConnectorSource(ctx)`**，且**只在 `BaseProxy` 构造期解析一次**，四个转发器
   *   共享同一份（各造各的会让「记忆上游协议」出现第二个真相源）。
   */
  connectors?: ConnectorSource;
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
 * 支持 `stopped → starting` 的重入重启。模板方法与幂等语义见 `core/server/base.ts:BaseProxy`
 * @example "running"
 */
export type LifecycleState = "idle" | "starting" | "running" | "stopping" | "stopped" | "error";

/**
 * 生命周期钩子契约
 * @description 供 `BaseProxy` 在 `start()` / `stop()` 模板流程中回调，子类可覆写以注入初始化/清理逻辑
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
 * 与 runtime 层 `[forwardXxx error]` 日志前缀表（`src/runtime/event-log.ts:FORWARD_ERROR_LABEL`）。
 * @example "tunnel"
 */
export type ProxyForwardKind = "http" | "tunnel" | "upgrade";

/**
 * 认证审计事件
 *
 * @description `IdentityContext.onAuthEvent` 的**内部审计回调契约**（`core/identity.ts` → `BaseProxy.authorize`），
 * **不是**事件总线的载荷：`BaseProxy.authorize` 读到它后转成 `AppEventMap` 的 `auth.decided`
 * （`{ passed, user?, attempted?, reason?, tag? }` 进 data，身份维度进 `EventContext`），
 * 原对象原样交给前一个 `onAuthEvent`（`prev`）继续走旁路。
 * @param tag - 场景标签：隧道场景（CONNECT / socks*）为 `"tunnel"`，其余为空串
 * @param client - 客户端地址（由 `getClientAddress` 提取，可能来自 XFF，仅用于展示与审计）
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
   * 请求/连接标识：由 `BaseProxy.authorize` 从 `IdentityContext` 取出并注入，
   * 使 `auth.decided` 能与该请求的终态事件按 requestId 串联。
   */
  requestId?: string;
  connectionId?: string;
}

/**
 * 代理内核抽象（生命周期 + 统计）
 * @description 继承 `Lifecycle` 钩子，叠加协议、选项、状态与启停能力；`BaseProxy` 为其抽象实现。
 *   `options` 是归一化后的完整选项（Required，构造期由显式配置与默认值补齐）；
 *   `start` / `stop` 是幂等的（running / stopped 时直接返回）
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
// 身份契约（叶模块 `identity.ts` 的来源）
// ---------------------------------------------------------------------------

/**
 * 身份识别所需的类请求对象（最小集）
 * @description 仅需 headers/url/socket/method 四字段，避免依赖完整的 `http.IncomingMessage`
 * @param headers - 请求头字典（键大小写不敏感，值可能为字符串或字符串数组）
 * @param url - 请求 URL（用于 target 回退展示）
 * @param socket - 底层 Duplex（用于提取远端地址，可选）
 * @param method - HTTP 方法（如 "CONNECT"），用于隧道场景 tag 判定；http.ts 传入的是真 `http.IncomingMessage`，运行时天然具备该字段
 * @example { headers: req.headers, url: req.url, socket, method: req.method }
 */
export interface IdentityRequestLike {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  socket?: unknown;
  method?: string;
}

/**
 * 身份上下文
 * @description 每次 `identify` 调用时构造，携带协议、请求、通道与审计回调
 * @param authority - 请求权威（CONNECT 的 authority 或普通请求的 host:port，用于日志 tag 与审计）
 * @param onAuthEvent - 审计事件回调（由 BaseProxy 注入，转抛为 proxy "auth" 事件）。
 *   字段名**刻意保留 `onAuthEvent` 不改**（它回调的载荷是 `ProxyAuthEvent`，同样原名不动），
 *   见下方 `ProxyAuthEvent` 与文件头「「Auth」只剩审计语义」那条
 * @example { protocol: "http", req, socket, authority: "example.com:443", onAuthEvent: (e) => publishAuthEvent(e) }
 */
export interface IdentityContext {
  protocol: string;
  req: IdentityRequestLike;
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
 * 身份识别结果类型
 * @description `passed` 通过与否；`username` 为通过时的用户名（basic/uid 取命中的账号名，
 * jwt 取 token 中的 sub/username）；未通过时不含用户名。
 * 识别内部异常由 `BaseProxy.authorize` 捕获并视为 `{ passed: false }`
 * @example { passed: true, username: "alice" }
 */
export interface IdentityResult {
  passed: boolean;
  username?: string;
}

/**
 * 单个账号（来源：AUTH_USERS_FILE 指向的 users.json）
 * @description 名字**保留 `AuthAccount`**：它描述的是「账号表里的一条条目」这一数据，
 * 与「用哪种方式识别身份」正交——换任何身份插件，这张表都还是这张表
 * @param username - 用户名，非空且不含 `:`（Basic 凭证为 `user:pass`，含冒号有歧义）
 * @param password - 密码，允许空串（uid 模式只用用户名）
 * @param expiresAt - 可选，账号有效期截止（**epoch 毫秒**）。`now >= expiresAt` → 认证不通过。
 *   **绝不能进凭证索引**：索引同时供出站剥离判据（`isOwnCredential`）使用，过期账号一旦
 *   不在索引里，它的凭证就不再被剥掉、会被原样转发给目标站。归一（ISO 8601 → 毫秒）在
 *   `config/files/users.ts:normalizeAccountExpiry` 做，本层只消费已归一的数字。
 */
export interface AuthAccount {
  username: string;
  password: string;
  expiresAt?: number;
}

/**
 * 身份提供者（身份识别端口）
 * @description 「你是谁」的唯一入口：core 与四条入站通道只认这个端口，从不知道也不关心它背后是
 * 账号表比对、异步验签、还是干脆什么都不判——那是被注入方的事。
 *
 * ⚠️ **`isOwnCredential` 是必填成员**（既无缺省实现、也禁止返回 `undefined`）：它是
 * 「出站剥不剥**每一个**出站头里的本代理凭证」的**唯一**判据，漏实现必须在**编译期**炸，
 * 而不是运行期静默把调用方的凭证原样送给目标站。详见该成员自己的注释。
 *
 * @example const r: IdentityResult = await identity.identify({ protocol, req, socket, authority });
 */
export interface IdentityProvider {
  /**
   * 身份类型标识（"none"|"basic"|"jwt"|"uid" 或自定义）；仅用于展示/审计，不参与控制流。
   *
   * 消费方读它的**唯一**用途是「要不要走鉴权握手分支」（SOCKS5 选 user/pass 还是
   * 无认证方法）——所以它必须是一个**稳定字符串**，但不需要是闭合字面量集：
   * 自定义身份插件可以给任意值，core 遇到不认识的值的默认行为恒是「当作已启用」。
   */
  readonly kind: string;
  /**
   * 是否启用身份识别。false = 放行一切。
   *
   * 口径是「**本实例会不会拒绝任何人**」，而不是「有没有装身份判定器」——它与
   * 「识别模板方法首行直接放行」是**同一个事实**，故不需要第二个开关与之同步。
   * 三个内置插件的答案恒为：`noneIdentity()` → false（不判人），basic/uid/jwt → true。
   * **消费方只许读它一个字段，绝不许自己再判一次 `kind !== "none"`**（自定义插件的 `kind`
   * 可以是任意值，见上一条）。
   */
  readonly isEnabled: boolean;
  /**
   * 出站凭证判据：**这一个 `(头名, 头值)` 对，是不是本代理自己发出的凭证？**
   *
   * 答 `true` = 「这两个字面量合起来构成本代理签发的那份凭证，必须在转发给目标站点之前被
   * 剥掉」；答 `false`（含「我不认识」）= 「这不是我的凭证，原样保留」——目标的
   * `Authorization: Bearer <token>` 属于这一档，剥了它目标站就少收一个它要的头。
   *
   * **必填、无缺省、不可返回 `undefined`——这是身份可插值化的安全地基。** 漏实现的代价不是
   * 「剥多了」，而是反过来：**代理自己的凭证被原样转发给目标站**，等于把内网口令 / 代理
   * 令牌泄露给第三方。判据必须**由插件自己给出**（它才知道自己的凭证形态长什么样：
   * 自定义 `Authorization` 头名、`X-Api-Key`、HMAC 摘要、云厂商网关签名……），因为身份一旦
   * 可插值，`config` 就不再是凭证真相源，继续从 config 猜**必然失配**。判据归属与库层纪律
   * 见 `tests/unit/identity-credential-seam.test.ts` 头注释。
   *
   * **库层「每个出站头都问一遍」，本方法不只对 `authorization` 生效。**
   * `helpers/headers.ts:isStrippableOutboundHeader` 的形状是：`proxy-` 前缀走协议规则直接剥，
   * **其余每一个出站头名 × 每一个头值都调本方法**（数组值取任一命中即整条剥离）。库层
   * **不**对它做任何头名限制（替插件规定「凭证只能放 `authorization`」等于把已被推翻的
   * 「配置即身份真相源」假设换个地方再立一次）；内置四插件在
   * `core/identity/token.ts:ownCredentialForms` 里对非 `authorization` 头名恒返回 `false`，
   * **那是它们自己的廉价早退、不是对端口的限制**。**别用「多问几次不值得」为名在库层加头名
   * 门禁**——剩下的缺口在 `readJsonCached` 那一侧（`path.resolve` 占 `loadAuthUsers` 的 44%），
   * 修它与本端口无关。
   *
   * 契约细节：`name` 传入的是**出站头名、已按大小写不敏感归一为小写**（端口契约：调用方先
   * 归一，故实现侧不必再假设大小写形态，但仍应容忍）；`value` 是**头值原文**（可能带
   * `Basic ` / `Bearer ` 前缀，也可能是无 scheme 裸值——两种形态都要判）。
   * 判定粒度是**「这一对」而不是「这个值」**：同一个值放在不同头里答案可以不同（`X-Api-Key`
   * 与 `Authorization` 对自定义插件而言是两回事），所以 `name` 是必答项，不是上下文。
   *
   * **热路径约束**：本方法在每个转发请求的**每个出站头**上都会被调用（实测 17 头请求 =
   * 17 次委派，空实现每头 ≈44 ns），所以它**必须便宜且同步**——**先按头名早退、再做值判定**
   * （内置四插件就是这个顺序），不要在头名判完之前做 `trim`/base64 解码/HMAC/文件读取。签名是
   * `boolean` 而非 `Promise` 同理：出站剥离在组装报文的同步路径上，await 不了（内置 jwt 判据
   * 因此走同步 HS256 验签而不是注入的异步 `jwtVerify`——见 `core/identity/file-account.ts`）。
   * ⚠️ 已知代价（实测，见 `helpers/headers.ts` 文件头「代价」一节）：配置驱动的动态门面
   * `createIdentityFromConfig` 每次委派 ≈ **1.8 µs**，17 头 ≈ **31 µs/请求**；归因是
   * `loadAuthUsers`（`readJsonCached` 编排）占 **87.7%**——**不是「每请求现造一份快照」**
   * （那条待办已由 `factory.ts` 的 `liveSnapshots` 记忆表完成，但它消除的是重复构造而不是性能
   * 优化），涨上去的是那段编排**被调了 N 次**（N = 出站头数）。
   *
   * @param name - 出站头名（小写归一后；每个出站头都会被问一次，不是只有 `authorization`）
   * @param value - 出站头值原文
   * @returns true = 这一对是本代理凭证，必须剥掉再发给目标站
   * @example identity.isOwnCredential("x-api-key", "k-42") // 自定义头名插件返回 true → 出站被剥
   * @example identity.isOwnCredential("authorization", "Bearer target-site-token") // => false（目标的凭证）
   */
  isOwnCredential(name: string, value: string): boolean;
  /** 识别身份。异常一律按拒绝处理（上层 `BaseProxy.authorize` 捕获）。 */
  identify(ctx: IdentityContext): Promise<IdentityResult>;
}

/**
 * 身份构造选项
 * @param enabled - 是否启用身份识别
 * @param type - 身份类型：none（放行）/ basic（比对账号表用户名密码）/ jwt（委托 jwtVerify）/ uid（仅比对用户名，socks4 USERID）
 * @param accounts - 账号表（来源见 `AUTH_USERS_FILE`），basic/uid 时生效；空表一律判否
 * @param jwtSecret - JWT 校验密钥
 * @param jwtVerify - JWT 校验函数 `(token, secret) => Promise<boolean>`；`jwtIdentity()` 要求显式注入（未注入一律拒绝），
 *   `FileAccountIdentity` 直构时 type=jwt 必填（未注入一律拒绝），`createIdentityFromConfig()` 默认注入内置 HS256 实现
 *   `defaultJwtVerify`，显式注入优先
 * @param enableLogging - 是否启用身份审计事件（缺省为 true；配置工厂可显式注入）
 * @param now - 账号有效期判定的时钟源（缺省墙钟）。可注入的理由与 `core/traffic` 相同：
 *   「到期」这类边界最容易写错，靠真实时钟只能写出测不出回归的用例
 * @example { enabled: true, type: "basic", accounts: [{ username: "alice", password: "pw1" }] }
 * @example { enabled: true, type: "uid", accounts: [{ username: "test", password: "" }] } // socks4 USERID
 * @example { enabled: true, type: "jwt", jwtSecret: "xxx", jwtVerify: async (t,s)=>true }
 */
export interface IdentityOptions {
  enabled?: boolean;
  type?: "none" | "basic" | "jwt" | "uid";
  accounts?: AuthAccount[];
  jwtSecret?: string;
  jwtVerify?: (token: string, secret: string) => Promise<boolean>;
  enableLogging?: boolean;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// 访问控制契约（`core/access-control.ts` 实现的端口形态）
// ---------------------------------------------------------------------------
// 判定输入一律只读入参对象、无位置参数（加字段不破坏既有实现位置参数，也便于整组透传）。

/** 入站对端准入的判定输入。 */
export interface AccessClientInput {
  /**
   * 客户端对端地址。口径是 **TCP 对端**（`getSocketAddress(socket)`），不是
   * `getClientAddress(req)`：后者会读 XFF / X-Real-IP / Forwarded，那是被客户端自己写出来的
   * 值，用它做准入等于让请求方自己决定能不能进来。两种口径**刻意不合并**（终态/事件侧那条走
   * `getClientAddress`）。
   */
  readonly client: string;
}

/** 出站目标准入的判定输入。 */
export interface AccessTargetInput {
  /** 目标主机（域名或 IP，可带方括号；不做 DNS）。 */
  readonly host: string;
  /**
   * 已鉴权用户名（两层名单合流时判个人名单）。**可空且必须可空**：入站 IP 准入发生在
   * 鉴权**之前**，那时还不存在「你是谁」；路由判定同理（与身份正交）。
   */
  readonly user?: string;
}

/** client 模式路由判定输入。 */
export interface AccessRouteInput {
  /** 目标主机（域名或 IP，可带方括号；不做 DNS）。 */
  readonly host: string;
}

/**
 * 准入判定结果
 * @description `reason` / `source` **刻意从闭合字面量集放宽为自由 `string`**：
 * 名单判定只会说 `whitelist` / `blacklist`，但端口一旦对外暴露，替换实现可能是
 * 限速引擎、地理封锁、订阅制网关——它们要能表达自己的原因（`"rate-limited"`、
 * `"geo-blocked"`），闭合字面量集会让这些实现**没法用类型描述自己的结论**，只能回去
 * `as never` 强转。
 *
 * **消费方必须原样透传：只有缺失/空串才跳过，绝不许加收窄。** 库层唯一的判据是「有值就原样
 * 带上去」。收窄会让表外值**整条不发布** `access.target-denied`，于是一条真实的拒绝事实
 * **从公共事件面上彻底消失**——它连「这里发生过什么」都不留痕，比「载荷里带一个没人认识的
 * reason」坏得多。**静默丢事件比字段缺失更坏。**
 *
 * 代价如实写：`reason` / `source` **没有闭合集保证**，消费方**不能**拿它做穷尽 `switch`
 * （先比已知值、其余落 `other` 桶）。**内置引擎的取值恒定**：`createFileAccessControl`
 * 仍只出 `whitelist|blacklist` 与 `global|user`，CLI 落的 `[ip-denied]` / `[target-denied]`
 * 行也逐字不变。**闭合集纪律的落点在生产者**（`access-control.ts:hostDenied` 与 `source:`
 * 字面量集合那几条源码级断言）；护栏见 `tests/unit/access-control-port.test.ts` +
 * `tests/unit/user-acl-merge.test.ts` 头注释。
 * @param allowed - 是否放行（放行恒为 `{allowed:true}`，不写 `reason` / `source`——
 *   「哪一层放的」对放行没有意义，写了还让「两关都过」与「上层不存在」无法区分）
 * @param reason - 拒绝/回落原因（自由文本；名单语义为 `whitelist` | `blacklist`）
 * @param source - 拒绝来自哪一层（自由文本；名单语义为 `global` | `user`）
 */
export interface AccessDecision {
  allowed: boolean;
  reason?: string;
  source?: string;
}

/**
 * 路由判定结果：`direct` = 直连（不交上游），非 direct = 走上游
 * @param reason - 因名单命中而回落的自由文本原因（名单语义为 `whitelist` | `blacklist`）
 */
export interface AccessRouteDecision {
  direct: boolean;
  reason?: string;
}

/**
 * 访问控制端口（入站对端 / 出站目标 / 路由三组判定）
 *
 * ⚠️ **三个方法都是同步的，这是硬裁决，不是省事。**
 * `checkRoute` 被**四条入站通道**（http / tunnel / upgrade / socks）在**拨号之前**调用，
 * 是一条同步纯函数热路径上的必经一步：它的返回值要立刻喂给「选哪个连接器 / 拒绝应答 /
 * 发 `route` 事件」这一串**同步**控制流。改成 `async` 会级联改掉整条转发链（每条通道各多
 * 一个 `await` 边界、`resolveForwardTargets` 连带变 async、转发器入口签名与两阶段准入的
 * 时序全部要重排）。
 * **需要远程查策略的诉求归 `IdentityProvider`（`identify` 本来就是 async）**，不归访问
 * 控制：身份判定的结果本来就允许等，准入判定不允许。判据与护栏见
 * `tests/unit/access-control-port.test.ts` 头注释。
 * @param checkClient - 入站对端准入（TCP 对端 IP 名单）
 * @param checkTarget - 出站目标准入（全局名单 ∩ 该用户个人名单）
 * @param checkRoute - client 模式路由判定（命中名单则回落直连）
 * @example const ok = access.checkTarget({ host, user }); if (!ok.allowed) refuse();
 */
export interface AccessControl {
  checkClient(input: AccessClientInput): AccessDecision;
  checkTarget(input: AccessTargetInput): AccessDecision;
  checkRoute(input: AccessRouteInput): AccessRouteDecision;
}

// ---------------------------------------------------------------------------
// 归一后的服务包
// ---------------------------------------------------------------------------

/**
 * core 内部的**归一后**服务包（三项全必填）。
 *
 * - **为什么在这一层归一**：沿 `ProxyOptions` 进 core 的三个服务是**非 optional 的冻结包**。
 *   `identity` / `traffic` 在 `ProxyOptions` 上可选、各自带一个显式 inert 档，在
 *   `BaseProxy` 构造期归一**一次**（`identity ?? noneIdentity()` / `traffic ??
 *   inertTrafficAccount()`）；`access` 在 `ProxyOptions` 上**就是必填**、core 侧**零缺省解析**，
 *   缺省即全放行的后果由编译期强制（见 `ProxyOptions.access` 自己的注释）。
 *   归一之后 core 内部一路拿到的都是这个**非 optional 的冻结包**——转发器与准入层因此不必在
 *   每个使用点写 `?.` 或 `??`，「忘注入」也不会退化成运行期的 `undefined is not a function`。
 * - **为什么打包成三项而不是散装注入位、为什么 `trafficLedger` 刻意不在包里**：判据是
 *   **生命周期**不是存取方式——落盘账本有 `runtime.start/stop` 驱动面，进程级而生命周期是
 *   `runtime` 级，装进「core 随请求用的服务包」会让它在每一层都被当成已就绪的依赖。
 */
export interface CoreServices {
  readonly identity: IdentityProvider;
  readonly access: AccessControl;
  readonly traffic: TrafficAccount;
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
/** 目标名单拒绝（target 名单/黑名单命中） */
export interface PipeTargetDeniedEvent extends PipeEventBase {
  type: typeof LogEvent.TargetDenied;
  host?: string;
  /**
   * 哪一层拒的（名单语义为 `global` / `user`）。**缺失即跳过，禁倒填成 `global`**——倒填会把
   * 「个人名单拒的」伪装成「全局拒的」，运维去改错文件；放行路径同样不写该键。
   * 自由 `string` 的取舍与「消费方只许透传」见上方 {@link AccessDecision}；`source` 刻意不进
   * `PipeEventBase`，分层信息也**不许**塞进 `reason`（写成 `"user:blacklist"` 会让按取值收窄的
   * 消费方认不出，把整条安全事实弄丢）。
   */
  source?: string;
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
 * `type` 为字面量的**判别联合**：每个变体的字段在编译期可见，
 * 消费端 `switch (e.type)` 可获得收窄类型，无需 `as string` / `as unknown` 强转。
 * - 生产者（forward/guard/helpers/server）只经 `RequestScope.emit` 发出
 * - 消费端（`src/runtime/event-log.ts:bindProxyEventLogs`）按 type 分发落盘
 * - 名单语义为 `whitelist`/`blacklist`；`[route]` 与 `route` 事件 1:1
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
