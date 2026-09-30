/**
 * 库入口：纯导出、零 import 期副作用。
 *
 * `import "@b-hole/proxy"` **不做任何事**：不读 env / argv / 配置文件、不写 `process.env`、
 * 不注册 `process` 监听、不建 server、不写日志文件、不 fork cluster。`server/process-guards`
 * 与 `server/log/config-log` **必须保持惰性动态 import 形态**（守卫安装与配置快照打印都是显式动作）：
 * 静态 import 会把守卫装进 import 期。
 *
 * 收录判据：「要写一个自定义插件的人，必须能 import 到它吗？」
 *
 * **不留兼容层**：本项目零兼容——已删除的符号名不再导出，也不提供别名。包入口没有进程级的
 * 配置状态读写面。机器可读护栏在 `tests/library/entry.test.ts`。
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
 * **数据源门面**（三份：账号表 / 访问控制名单 / 配额账本）——**先于代理门面导出**。
 *
 * 出现在包入口是因为它们**不依赖代理**：这三份东西「数据从哪来」，判定归
 * `AccessControl` / `UsageAccount` 两个代理侧端口。所以库调用方可以只 import 这一段、
 * **完全不启动代理**就跑自己的数据源（插一个驱动、读一份名单、记一本账）。
 *
 * 三个 `register*` 就是「用自己的实现替换内置驱动」的入口：驱动名是**开放集合**
 * （`DataSourceDriver = string`），合法性由注册表这个运行时事实判定，**未注册即抛错并列出
 * 全部已注册项**，绝不静默回落到内置档。⚠️ **必须先注册、再建 runtime**——注册是模块级
 * 可变状态，装配那一刻解析不到就是抛错。
 *
 * 内置驱动之外还转出实现器与工具，是为了让「自定义驱动」有可复用的起点：继承 json 档
 * 改一处 IO、或拿 `validateAuthUsers` 保住同一份形状判据，都不需要重新实现校验。
 */
export {
  // 驱动名词汇表 + 注册表本体
  BUILTIN_ACL_DRIVERS,
  BUILTIN_ACCOUNT_DRIVERS,
  BUILTIN_USAGE_DRIVERS,
  createSourceRegistry,
  DataSourceDriver,
  unknownDriverError,
  // 三份数据源的注册入口（**自定义驱动的官方入口**）
  registerAccountSource,
  registerAclSource,
  registerUsageSource,
  listAccountSourceDrivers,
  listAclSourceDrivers,
  listUsageSourceDrivers,
  hasUsageSource,
  resolveAccountSource,
  resolveAclSource,
  resolveUsageSource,
  // 内置实现器与校验（自定义驱动的可复用起点）
  ACCOUNTS_DB_NAME,
  EMPTY_ACL,
  JsonAccountSource,
  JsonAclSource,
  JsonlUsageSource,
  SqliteAccountSource,
  SqliteUsageSource,
  validateAcl,
  validateAuthUsers,
  // 读取面（**零请求期判定**）
  loadAuthUsers,
  loadUserPolicy,
  loadUserQuota,
  readAuthUsers,
  readAuthUsersAsync,
} from "@/datasource/index.js";
export type {
  AccountListOptions,
  AccountLocator,
  AccountSource,
  AccountSourceFactory,
  AclConfig,
  AclList,
  AclReadOptions,
  AclSource,
  AclSourceFactory,
  AclLocator,
  AuthAccount,
  JsonlUsageSourceOptions,
  UsageEntry,
  QuotaResolver,
  QuotaWindow,
  QuotaWindowSource,
  ReadAuthUsersOptions,
  SourceFactory,
  SourceRegistry,
  SqliteUsageSourceOptions,
  UsageAccount,
  UsageDirection,
  UsageMirror,
  UsageQuota,
  UsageSink,
  UsageSnapshot,
  UsageSource,
  UsageSourceController,
  UsageSourceError,
  UsageSourceFactory,
  UsageSourceSpec,
  UsageVerdict,
  UserPolicy,
  UserPolicyList,
  UserQuota,
  WindowUsage,
  FlushLoopHandle,
} from "@/datasource/index.js";

/**
 * 配置 → 数据源接线的翻译层（**`ConfigAccessor` 只活在这一段**）。
 * 出现在这里是给库调用方准备接线用：数据源层的工厂吃平值闭包，而配置是 `ConfigAccessor`，
 * 这两者之间必须有且只有一个翻译点——否则每个消费方都要自己写一遍「从 config 取驱动名与路径」。
 */
export { accountLocatorFor, accountLocatorFrom, aclLocatorFor, aclLocatorFrom } from "@/config/index.js";
export { createJsonFileEventHandler } from "@/config/index.js";



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
  /** core 归一后的服务包：identity / access / traffic **三项全必填** + 一个**可选**的出站改写策略位
   *  （`outboundHeaders`，`undefined` = 不改写）；与 `RuntimeServices` 的差别见类型注释 */
  CoreServices,
  /** core 归一后的选项（除 `outboundHeaders` 外全必填——那个字段的归一值合法地是 `undefined`） */
  NormalizedProxyOptions,
  /** 出站改写回调拿到的这次调用的上下文（`channel` 判 http/upgrade 两通道，`toProxy` 判对端是代理还是源站） */
  OutboundHeaderContext,
  /** 出站报文改写策略：headers 进、headers 出，`undefined` = 不改写 */
  OutboundHeaderRewriter,
} from "@/core/types/proxy.js";

/**
 * 端口的**依赖承载体**（`config`/`logger`/`events` 三件套的只读接口，**全必填、无缺省**）。
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
  ErrorClassifier,
  ErrorClass,
  ClassifiedError,
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


// ---------------------------------------------------------------------------
// 可插值端口 ③：每用户流量配额
// ---------------------------------------------------------------------------

export { createUsageMirror, inertUsageAccount, mirrorLagBoundMs } from "@/datasource/index.js";
export {
  /** 账本文件名（构造期纯计算，不碰磁盘） */
  usageDbFileName,
  USAGE_DB_NAME,
  JSONL_USAGE_FILE_NAME,
  sharedUsageFileName,
  DEFAULT_USAGE_COMPACT_BYTES,
  parseUsageEntries,
  summarizeCurrent,
  compactEntries,
  clampFlushIntervalMs,
  startFlushLoop,
  /** 窗口键语义：`day`/`month` 两个日历窗，缺省归一到 `month`（归一在**消费侧**） */
  DEFAULT_QUOTA_WINDOW,
  quotaWindow,
  windowKey,
} from "@/datasource/index.js";

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
// 可插值端口 ⑤：错误分类（「这是什么错」→ 类别 / 建议状态码 / 安全消息）
// ---------------------------------------------------------------------------

export {
  /** 错误分类端口的**默认实现单例**（真值表：timeout/504、Node 网络错误码 → upstream/502、
   *  协议错误 → protocol/502、未知 → internal/502 且 `expected:false`）——想「只换一处」就显式写全
   *  两个方法，别从它派生对象（那会连 `classifyClient` 一起换掉） */
  DEFAULT_ERROR_CLASSIFIER,
  /** 终态边界：分类 + 发 `request.failed` / `request.rejected` / `runtime.error`。
   *  **它不写协议应答**，客户端状态码由协议层自己决定（故本端口对可见状态码零影响） */
  ErrorBoundary,
} from "@/core/error-boundary.js";

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
   * 是被禁的依赖方向。
   */
  ProcessPolicy,
  /** 信号宿主：装信号那一侧真正需要的四样（不是「把 server 递出去」） */
  SignalHost,
  /** `StartupPreset` 的进程侧扩展（库那一侧刻意不含 `process` 字段） */
  ProcessStartupPreset,
} from "@/server/index.js";
