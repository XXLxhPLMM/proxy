/**
 * 库入口：纯导出、零 import 期副作用。
 *
 * `import "@b-hole/proxy"` **不做任何事**：不读 env / argv / 配置文件、不写 `process.env`、
 * 不注册 `process` 监听、不建 server、不写日志文件、不 fork cluster。`server/process-guards`
 * 与 `server/log/config-log` 都是**惰性动态 import**（守卫安装与配置快照打印都是显式动作），
 * 本文件导出它们时**必须保持动态 import 形态** —— 改成静态 import 就等于把守卫装进 import 期。
 *
 * ## 分层：门面 / 可插值端口 / 进程级 API 三者正交
 *
 * | 层 | 入口 | 边界 |
 * |---|---|---|
 * | **库门面** | `createProxyRuntime()` | 零进程副作用。接受显式 `ConfigContext` 或纯内存 `config`，不采集宿主来源 |
 * | **可插值端口** | 身份 / 访问控制 / 流量配额 / 上游接入 / 日志 / 事件总线 | 每一层都同时导出**接口 + 输入/结果类型 + 内置实现**，否则「可插值」只是口号 |
 * | **进程级 API** | `runServer()` / `ProxyServer` / `cliPreset()` / `ProcessPolicy` | 拥有进程的那一侧：信号、守卫、banner、退出、cluster。与库门面**正交**，不互相调用 |
 *
 * 库调用方要换掉任何一层，只需要 `createProxyRuntime({ services, connectors, assembly })`；
 * 要换掉「谁拥有这个进程」，才去看 `ProcessPolicy` 那一组。
 *
 * ## 每层都导出「接口 + 输入 + 结果 + 内置实现」
 *
 * 这条是本文件的**唯一收录判据**：一个符号该不该出现在包入口，只问一句 ——
 * **「要写一个自定义插件的人，必须能 import 到它吗？」**
 *
 * - 身份 → `IdentityProvider` + `IdentityContext`/`IdentityResult`/`IdentityOptions` +
 *   `basicIdentity()`/`uidIdentity()`/`jwtIdentity()`/`noneIdentity()`/`createIdentityFromConfig()`
 * - 访问控制 → `AccessControl` + 三组输入/结果类型 + `createFileAccessControl()`
 * - 流量配额 → `TrafficAccount` + `TrafficVerdict`/`TrafficUsage` + `createMemoryTrafficAccount()`/
 *   `inertTrafficAccount()`/`JsonlTrafficLedger`
 * - 上游接入 → `ConnectorSource` + `UpstreamConnector`/`OpenContext`/`OpenedUpstream` +
 *   `createConnectorSource()` 与四个内置连接器
 * - 日志 / 事件总线 → `Logger`/`LoggerImpl` + `EventHub` 与全部事件契约
 *
 * 端口的**依赖承载体 `CoreContext`** 也必须出去：几乎每个工厂的第一个形参就是它
 * （`createIdentityFromConfig(ctx)`、`assembly.connectors(ctx)`），调用方连它的类型都写不出来
 * 就没法正确接线。
 *
 * **反过来说**：core 内部件一律**不**出去（`helpers/**` 的出站头剥离原语、`meterStream` 计量挂点、
 * 压缩/解析纯函数、`sources/` 的 argv/env 解析器）。它们要么是**装配期**就定死的实现细节，
 * 要么没有跨目录调用方 —— 出口膨胀会让「删掉一个内部函数」变成破坏性变更。
 *
 * ## 具名装配：`StartupPreset` + `assembly`
 *
 * 预设是**装配决策**（协议 / 服务替身 / 上游接入），与 `@/config/presets.ts` 的 `ProxyPreset`
 *（配置值打包）**完全无关**，名字刻意错开。`pickStartupPreset(context, name?)` 是个纯函数、
 * **零 `process.env`**：`env` 的影响**全部收敛在 `loadConfig`** —— 那是本仓唯一读
 * env / argv / env 文件的入口，库层再读一次就是「协议由两处决定」的第二真相源。
 *
 * ## 不留兼容层
 *
 * 旧名（`AuthProvider`/`AuthOptions`/`AuthContext`/`AuthResult`/`AclSource`/`AclReason`/
 * `checkClientIp`/`checkTargetHost`/`checkUpstreamRoute`/`connectorFor`/`directConnector`/
 * `isProxyCredentialValue`/`createAuthFromConfig` …）**一律不导出、也不加别名**。
 * 包入口明确不导出 `get`/`getAll`/`set`/`defaultConfigStore`/`globalConfigAccessor`。
 * 机器可读护栏在 `tests/library/entry.test.ts`。
 */

// ---------------------------------------------------------------------------
// 库门面（runtime）
// ---------------------------------------------------------------------------

export { createProxyRuntime, buildDefaultServices, RuntimeContext } from "@/runtime/index.js";
export type {
  ProxyRuntime,
  ProxyRuntimeOptions,
  RuntimeServices,
  RuntimeWarning,
  RuntimeContextOptions,
} from "@/runtime/index.js";

/**
 * 具名装配（协议 / 服务替身 / 上游接入的整份组装件）。**零 import 期副作用**：模块加载只
 * 创建内置字面量与一张内存 `Map`。
 */
export {
  builtinStartupPresets,
  defineStartupPreset,
  getStartupPreset,
  listStartupPresets,
  pickStartupPreset,
  registerStartupPreset,
} from "@/runtime/index.js";
export type { StartupPreset } from "@/runtime/index.js";

// ---------------------------------------------------------------------------
// 配置层（统一走 @/config/index.js 出口：库调用方不需要知道 config 内部的文件布局）
// ---------------------------------------------------------------------------

export {
  ConfigStore,
  defaults,
  configAccessorFromStore,
  createConfigContext,
  // loadConfig 只在显式调用时按传入来源异步读取；import 本身零配置副作用。
  loadConfig,
  // 字段元数据与相位表：库调用方要判断「这个键热改是否生效」时读它，不必猜。
  FIELDS,
  keysByPhase,
  // CLI 侧的来源编排入口：自己决定读哪些 env 文件 / 用哪个 configDir。
  defaultEnvFileNames,
  // 纯内存 runtime 重建 context 时的归一化装配入口（与 loadConfig 共用 URL 拆项实现）。
  prepareRuntimeConfigStore,
  applyPreset,
  builtinPresets,
  definePreset,
  getPreset,
  listPresets,
  registerPreset,
} from "@/config/index.js";
export type {
  AppConfig,
  AuthType,
  CacheType,
  ConfigAccessor,
  ConfigChangeListener,
  ConfigContext,
  ConfigKey,
  ConfigSourceMetadata,
  ConfigStoreReader,
  CreateConfigContextOptions,
  FieldDef,
  LoadConfigOptions,
  LogLevel,
  PreparedRuntimeConfig,
  ProxyPreset,
} from "@/config/index.js";

/**
 * 账号表 / 名单的**读取面**（数据层：读文件 + 形状校验 + 热加载观察，**零请求期判定**）。
 * 出现在这里是给「自定义插件想复用同一份文件格式」的人：`loadUserPolicy` 读某人的个人名单、
 * `loadUserQuota` 读某人的字节配额、`loadAuthUsers` 读整张账号表。判定语义归
 * `AccessControl` / `TrafficAccount` 两个端口，不在这里。
 */
export {
  createJsonFileEventHandler,
  loadAuthUsers,
  loadUserPolicy,
  loadUserQuota,
  readAuthUsers,
  readAuthUsersAsync,
  validateAcl,
  validateAuthUsers,
} from "@/config/index.js";
export type { UserPolicy, UserPolicyList } from "@/config/index.js";

// ---------------------------------------------------------------------------
// 事件总线（契约 + 作用域工厂）
// ---------------------------------------------------------------------------

export { EventHub, createRuntimeScope, createConnectionScope, createRequestScope } from "@/core/events/index.js";
export type {
  AppEventMap,
  EventContext,
  EventEnvelope,
  EventListener,
  EventName,
  EventSubscription,
  EventHubOptions,
  EventScope,
} from "@/core/events/index.js";

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

export { createNoopLogger, createConsoleLogger, createLogger } from "@/utils/logger/index.js";
export type { Logger, LoggerImpl, LoggerOptions, LogFields } from "@/utils/logger/index.js";

export type { TlsKeyCert } from "@/utils/tls/index.js";

// ---------------------------------------------------------------------------
// 代理核心
// ---------------------------------------------------------------------------

export { createProxy } from "@/core/server/factory.js";
export type {
  ProxyCore,
  ProxyOptions,
  ProxyProtocol,
  ProxyStats,
  Lifecycle,
  LifecycleState,
  ProxyForwardKind,
  PipeEvent,
  PipeEventType,
  PipeEventSink,
  /** core 归一后的**非 optional** 服务包（三项全必填）；与 `RuntimeServices` 的差别见类型注释 */
  CoreServices,
} from "@/core/types/proxy.js";

/**
 * 端口的**依赖承载体**（`config`/`logger`/`events` 三件套的只读接口，**全必填、无缺省**）。
 * 几乎每个下面的工厂第一个形参就是它，故必须能从包入口 import —— 否则调用方写不出接线代码。
 */
export type { CoreContext } from "@/core/context.js";

// ---------------------------------------------------------------------------
// 可插值端口 ①：身份（「你是谁」）
// ---------------------------------------------------------------------------

export type {
  IdentityProvider,
  IdentityOptions,
  IdentityContext,
  IdentityRequestLike,
  IdentityResult,
  /** 一条账号表条目（`IdentityOptions.accounts` 的元素类型；与 config 层那份**结构兼容**） */
  AuthAccount,
  /** 鉴权审计事件（`IdentityContext.onAuthEvent` 的载荷，经 `auth.decided` 上公共事件面） */
  ProxyAuthEvent,
} from "@/core/types/proxy.js";
export {
  /** 由显式选项造身份组件（不读配置） */
  createIdentity,
  /** 配置驱动门面（现读 `AUTH_*` + `users.json`，支持热加载）—— 内置默认实现 */
  createIdentityFromConfig,
  defaultJwtVerify,
  FileAccountIdentity,
  /** 令牌类身份组件的公共基类（自定义 HMAC / 云厂商签名时继承它） */
  TokenIdentityBase,
  noneIdentity,
  basicIdentity,
  uidIdentity,
  jwtIdentity,
} from "@/core/identity.js";
export type { AccountIdentityOptions, JwtIdentityOptions } from "@/core/identity.js";

// ---------------------------------------------------------------------------
// 可插值端口 ②：访问控制（入站对端 / 出站目标 / 路由判定）
// ---------------------------------------------------------------------------

export type {
  AccessControl,
  AccessDecision,
  AccessRouteDecision,
  AccessClientInput,
  AccessTargetInput,
  AccessRouteInput,
} from "@/core/types/proxy.js";
export {
  /** 内置实现：读 `acl.json` + `users.json` 的两层名单（现读，随文件热加载） */
  createFileAccessControl,
  /** 名单文件变更观察面（`config.file-*` 事件的转发口） */
  bindAclFileEvents,
  // 名单读取面一并出去，便于调用方「只 import 一处」就完成读 + 判。
  loadAcl,
  readAcl,
} from "@/core/access-control.js";
export type { AclConfig, AclList } from "@/core/access-control.js";

// ---------------------------------------------------------------------------
// 可插值端口 ③：每用户流量配额
// ---------------------------------------------------------------------------

export type {
  TrafficAccount,
  TrafficDirection,
  TrafficScope,
  TrafficVerdict,
  TrafficUsage,
  QuotaResolver,
  TrafficSink,
  TrafficLedgerController,
  TrafficLedgerError,
  RestoredLedger,
  RestoredUsage,
  QuotaWindow,
  TrafficWindowSource,
  JsonlTrafficLedgerOptions,
  LedgerEntry,
  FlushLoopHandle,
} from "@/core/traffic/index.js";
export {
  /** 内置实现：读 `users.json` 的 `quota`，按窗口 + 字节判定 */
  createMemoryTrafficAccount,
  /** 显式禁用档（不计量、不判定）—— 直构 core 而不注入时的语义明确答案 */
  inertTrafficAccount,
  MemoryTrafficAccount,
  /** 内置落盘账本（零成本档：没配任何非全 0 配额时不建目录、不开句柄、不起定时器） */
  JsonlTrafficLedger,
  /** 账本槽位归一（只认 `1..9999` 纯数字，其余按路径穿越面拒绝并回落 `"0"`） */
  normalizeSlot,
  DEFAULT_TRAFFIC_SLOT,
  DEFAULT_LEDGER_COMPACT_BYTES,
  /** 窗口键语义：`day`/`month` 两个日历窗，缺省归一到 `month`（归一在**消费侧**） */
  DEFAULT_QUOTA_WINDOW,
  quotaWindow,
  windowKey,
} from "@/core/traffic/index.js";

// ---------------------------------------------------------------------------
// 可插值端口 ④：上游接入（`ConnectorSource` = 装配期定死的「直连 / 走上游」两档）
// ---------------------------------------------------------------------------

export type {
  ConnectorSource,
  UpstreamConnector,
  OpenContext,
  OpenedUpstream,
  UpstreamKind,
} from "@/core/forward/upstream/connector/index.js";
export {
  /** 内置实现：按 `upstreamProtocol` 建一张连接器表；未登记协议**请求期 fail-closed 抛错** */
  createConnectorSource,
  DirectConnector,
  HttpConnectConnector,
  Socks4Connector,
  Socks5Connector,
} from "@/core/forward/upstream/connector/index.js";

// ---------------------------------------------------------------------------
// 进程级 API（拥有进程的那一侧，与上面的库门面正交）
// ---------------------------------------------------------------------------

/** 进程级入口：会安装信号/守卫/cluster。仅 CLI 或「本进程由我接管」的宿主使用。 */
export { ProxyServer, runServer, cliPreset, cliProcessPolicy, managedProcessPolicy } from "@/server/index.js";
export type {
  RunServerOptions,
  ProxyServerOptions,
  /**
   * 进程策略端口（信号 / 守卫 / banner / 强制退出）。**只长在 server 侧**：`runtime → server`
   * 是被禁的依赖方向，库门面因此永远拿不到一把上膛的 `process.exit`。
   */
  ProcessPolicy,
  /** 信号宿主：装信号那一侧真正需要的四样（不是「把 server 递出去」） */
  SignalHost,
  /** `StartupPreset` 的进程侧扩展（库那一侧刻意不含 `process` 字段） */
  ProcessStartupPreset,
} from "@/server/index.js";
