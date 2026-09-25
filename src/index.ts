/**
 * 库入口：纯导出、零 import 期副作用。
 *
 * 推荐库用法：`import { createProxyRuntime } from "@b-hole/proxy"`。
 * `createProxyRuntime()` 只接受显式配置/依赖，不读取 env、argv 或配置文件，
 * 也不会注册 process 监听、启动 cluster 或退出宿主进程。
 *
 * 配置状态没有进程级单例：调用方显式创建 `ConfigStore`，或 `await loadConfig(...)`
 * 得到包含 store/accessor/source metadata 的 `ConfigContext`，再注入 runtime/server。
 *
 * `ProxyServer` / `runServer` 仍为进程级 CLI 入口：它们只接收已加载的 context，
 * 并安装信号/守卫或启用 cluster；库调用方应优先使用 `createProxyRuntime()`。
 */

export { createProxyRuntime } from "./runtime/index.js";
export type {
  ProxyRuntime,
  ProxyRuntimeOptions,
  RuntimeServices,
  RuntimeWarning,
} from "./runtime/index.js";

export { ConfigStore, defaults } from "./config/store.js";
export { configAccessorFromStore, createConfigContext } from "./config/accessor.js";
export type {
  ConfigAccessor,
  ConfigContext,
  ConfigSourceMetadata,
} from "./config/accessor.js";

// loadConfig 只在显式调用时按传入来源异步读取；import 本身零配置副作用。
export { loadConfig } from "./config/load.js";

export type { AppConfig, ConfigKey, LogLevel, AuthType, CacheType } from "./config/store.js";
export type { LoadConfigOptions } from "./config/load.js";

export {
  EventHub,
  createRuntimeScope,
  createConnectionScope,
  createRequestScope,
} from "./core/events/index.js";
export type {
  AppEventMap,
  EventContext,
  EventEnvelope,
  EventListener,
  EventName,
  EventSubscription,
  EventHubOptions,
  EventScope,
} from "./core/events/index.js";

export { createNoopLogger, createConsoleLogger, createLogger } from "./utils/logger.js";
export type { Logger, LoggerImpl, LoggerOptions, LogFields } from "./utils/logger.js";

export { createProxy } from "./core/server/factory.js";
export type {
  ProxyCore,
  ProxyOptions,
  ProxyProtocol,
  ProxyStats,
  LifecycleState,
  AuthProvider,
  AuthResult,
} from "./core/types/proxy.js";
export type { TlsKeyCert } from "./utils/cert.js";

/** 进程级 CLI 入口：会安装信号/守卫/cluster，仅供 CLI 使用。 */
export { ProxyServer, runServer } from "./server/index.js";

export {
  definePreset,
  applyPreset,
  registerPreset,
  getPreset,
  listPresets,
  builtinPresets,
} from "./config/preset.js";
export type { ProxyPreset } from "./config/preset.js";
