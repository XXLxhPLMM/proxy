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
  TrafficVerdict,
  QuotaResolver,
  TrafficSink,
  TrafficLedgerController,
  /** 注入面用的**并集**形状（数据面 + 生命周期面）：换一份账本实现时按它实现，`TrafficSink` 单独
   *  不足以让注入生效——那份替身会 `open()` 会 `close()` 却一条记录都收不到 */
  TrafficLedger,
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
  /** 内置落盘账本（零成本档：没配任何非 0 的 `quota.bytes` 时不建目录、不开句柄、不起定时器） */
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
   * 是被禁的依赖方向。
   */
  ProcessPolicy,
  /** 信号宿主：装信号那一侧真正需要的四样（不是「把 server 递出去」） */
  SignalHost,
  /** `StartupPreset` 的进程侧扩展（库那一侧刻意不含 `process` 字段） */
  ProcessStartupPreset,
} from "@/server/index.js";
