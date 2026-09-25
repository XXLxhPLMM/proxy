/**
 * 库入口：纯导出、零 import 期副作用。
 *
 * 推荐库用法：`import { createProxyRuntime } from "@b-hole/proxy"`。
 * `createProxyRuntime()` 只接受显式配置/依赖，不读取 env、argv 或配置文件，
 * 也不会注册 process 监听、启动 cluster 或退出宿主进程。
 *
 * `get` / `getAll` / `set` 是保留的**全局单例 CLI 兼容 API**；库模式请使用
 * `ConfigStore` 或显式 `loadConfig()`，不要把宿主进程配置交给这组全局函数。
 *
 * `ProxyServer` / `runServer` 仍为进程级 CLI 入口：调用它们会安装信号/守卫、
 * 读取 CLI 配置并可能启用 cluster；它们不是库 runtime 的替代品。
 */

export { createProxyRuntime } from "./runtime/index.js";
export type {
  ProxyRuntime,
  ProxyRuntimeOptions,
  RuntimeServices,
  RuntimeWarning,
} from "./runtime/index.js";

export { ConfigStore, defaults } from "./config/store.js";

// 直引 ./config/load.js（零 import 期副作用）；**不要**改引 ./config/loader.js —— 那个文件
// 底部有 initConfig() 自执行，静态引入它会让 `import "@b-hole/proxy"` 读 .env 并污染 process.env
export { loadConfig } from "./config/load.js";

export type { AppConfig, ConfigKey, LogLevel, AuthType, CacheType } from "./config/store.js";
export type { LoadConfigOptions, LoadedConfig } from "./config/load.js";

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

export { createNoopLogger, createConsoleLogger } from "./utils/logger.js";
export type { Logger, LogFields } from "./utils/logger.js";

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
export { globalConfigAccessor, configAccessorFromStore } from "./core/config-access.js";
export type { ConfigAccessor } from "./core/config-access.js";

/** 进程级 CLI 入口：会安装信号/守卫/cluster，仅供 CLI 使用。 */
export { ProxyServer, runServer } from "./server/index.js";

// CLI 全局单例兼容 API；库模式请用 ConfigStore/loadConfig。
export { get, getAll, set } from "./config/store.js";
