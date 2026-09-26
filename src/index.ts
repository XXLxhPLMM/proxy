/**
 * 库入口 - 纯导出，无副作用
 * 作为库被 import 时，仅暴露 ProxyServer/runServer、配置初始化与读写 API，
 * 不读 env、不做配置校验、不启动服务。
 * 副作用（loader 初始化）与进程启动（require.main 分支）均已搬至 src/cli.ts；
 * CLI 的单进程/worker 编排留在 CLI 边界，库兼容入口只保留 ProxyServer/runServer。
 *
 * 配置 loader 不再在模块导入时自动执行；库用户可在 `set()` 前显式调用
 * `initializeConfig()`，CLI 和 `runServer()` 入口则负责在启动前初始化。
 *
 * 进程所有权：`new ProxyServer()` / `runServer()` 默认 `allowProcessExit=false`，
 * 不会在 rollback/stop hard-exit 或 signal 路径调用 `process.exit`；CLI 显式传
 * `{ allowProcessExit: true }` 保留自身进程退出兜底。`runServer()` 在单进程/worker
 * 返回 `ProxyServer` 句柄，cluster master 分支返回 `null`。
 */

export { ProxyServer, runServer, type ProxyServerOptions } from "./server/index.js";
export type { ProxyLifecycleErrorCode } from "./core/types/proxy.js";
export { get, getAll, set } from "./config/store.js";
/** 显式初始化配置（不创建 runtime、不启动服务）。必须在程序化 set 前调用。 */
export { initConfig as initializeConfig } from "./config/load.js";
