/**
 * 库入口 - 纯导出，零副作用
 *
 * **库优先原则**：本文件是库消费方（不 spawn CLI、直接 `import`）的唯一入口。
 * 消费方拿到的是 {@link createProxyInstance} 返回的实例句柄，同进程可创建任意多个，
 * 实例之间的配置、日志、鉴权、ACL、路由、连接集合**全部隔离**。
 *
 * 这里**没有** `get()` / `getAll()` / `set()` 这类进程级配置读写入口——那正是导致
 * 「同进程跑不了第二个实例」的全局单例。配置只能经实例句柄的 `config.scope` 访问，
 * 于是「读到别人的配置」在类型层面就不可表达。
 *
 * 副作用边界（与 CLI 严格分离）：
 * - 本文件**不读** `process.env`、不做配置校验、不绑定信号、不 `process.exit`、不起服务
 * - 读 env/CLI/preset 的完整加载链在 `createProxyInstanceFromEnv()`，由消费方显式调用
 * - 进程编排（signal / cluster / 退出兜底）在 `src/cli.ts`，属 CLI 边界
 *
 * 可替换性**不靠插件容器**：{@link InstancePlugins} 就是组合根的覆盖点，各能力域的
 * 契约（`*Provider` 接口 + 不可变注册表）与默认实现装配住在 `src/plugins/contracts.ts`
 * 与 `src/plugins/`。本库因此是**零 ESM 依赖**的 CommonJS（基线 Node >=22.6，
 * `require(ESM)` 需要 >=22.12）。
 * 需要进程级托管（cluster fork、信号绑定、退出兜底）请 spawn CLI；库侧等价物就是
 * {@link ProxyInstance} 句柄本身——它的每个方法都是实例级的，不绑定任何全局状态。
 *
 * @example
 * ```ts
 * import { createProxyInstance } from "@b-hole/proxy";
 *
 * const instance = createProxyInstance({
 *   name: "edge",
 *   config: { port: 8080, proxyProtocol: "socks5", authType: "basic" },
 * });
 * await instance.start();
 * // ...应用自己的生命周期管理...
 * await instance.stop();
 * ```
 */

export {
  createProxyInstance,
  createProxyInstanceFromEnv,
  type ProxyInstance,
  type ProxyInstanceOptions,
  type ProxyInstanceFromEnvOptions,
  type InstancePlugins,
} from "./instance.js";

// --- 配置：库消费方需要能自管 scope（自定义加载、跨实例派生默认值）---
export { createConfigScope, type ConfigScope } from "./config/scope.js";
export {
  initConfig as initializeConfig,
  prepareRuntimeConfig,
  type InitConfigOptions,
} from "./config/load.js";
export type { AppConfig, ConfigKey, AuthType, LogLevel, CacheType } from "./config/types.js";

// --- 插件契约：实现自定义能力必须能 import 这些接口 ---
export {
  createPluginRegistry,
  type PluginRegistry,
  type ConfigProvider,
  type ConfigReloadResult,
  type LoggerProvider,
  type AuthProvider,
  type AuthKind,
  type AuthFactoryOptions,
  type AuthProviderFactory,
  type AccessControlProvider,
  type RoutingProvider,
  type ForwarderProvider,
  type ProtocolProvider,
  type ProtocolDeps,
  type ClusterProvider,
  type ClusterRole,
  type InstanceRequest,
  type ResolvedInstance,
} from "./plugins/contracts.js";

// --- 默认插件装配：想复用内置实现而不自己写插件时用 ---
export { createRoutingProvider } from "./plugins/routing-provider.js";
export { createAuthProviderRegistry } from "./plugins/auth-providers.js";
export { createForwarderRegistry } from "./plugins/forwarders.js";
export { createProtocolRegistry } from "./core/server/protocols.js";

// --- 转发计划契约：自定义传输策略必须能 import ---
export type {
  ForwardPlan,
  ForwardInbound,
  ForwardTransport,
  ForwardPayload,
  ForwardTarget,
  UpstreamEndpoint,
  RoutingInput,
  RoutingOutcome,
  RoutingRejection,
  ForwarderContext,
  ForwardFact,
  ProtocolResponder,
} from "./core/types/plan.js";

// --- 内核类型：句柄透出的 `core` 用得上 ---
export type {
  ProxyCore,
  ProxyProtocol,
  ProxyOptions,
  ProxyStats,
  LifecycleState,
  ProxyLifecycleErrorCode,
  AuthContext,
  AuthResult,
  AuthAccount,
  ProxyAuthEvent,
} from "./core/types/proxy.js";

export { NoneAuthProvider } from "./core/auth.js";
