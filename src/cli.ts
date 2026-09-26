/**
 * CLI 入口 - 进程级副作用的唯一承载者
 * 职责（刻意只有这四件，其余一律不在本文件）：
 * - 读全部外部来源（env 文件 / 终端 env / CLI argv）得到**本进程唯一**的 `ConfigScope`
 * - 登记进程级 scope，供「天然属于进程而非某个实例」的日志走 `getLogger()` 门面
 * - 按角色分流：cluster master 走 supervisor，单进程/worker 走库的多实例句柄
 * - 进程编排收尾：`require.main` 启动闸门、启动失败的分类提示（EADDRINUSE）与退出
 *
 * **本文件不装配代理内核**：插件图（协议注册表 / 传输策略 / 鉴权 / ACL / 路由）由
 * `src/instance.ts` 收敛，master 分支只借用它的两个 Provider 工厂。这是「CLI 是
 * 组合根的一部分、不是第二个组合根」的落点——此前本文件自己 `new ProxyServer()`，
 * 于是 CLI 与库各有一套装配逻辑，库路径修好了 CLI 还可能错。
 *
 * 构建：esbuild 以本文件为 entryPoints 打包出 dist/app.js 与 dist/app-v22.js（Node >=22.6）。
 * 库入口（src/index.ts）保持纯导出、零副作用。
 */

import { initConfig } from "./config/load.js";
import { createConfigScope, type ConfigScope } from "./config/scope.js";
import type { ProxyLifecycleErrorCode } from "./core/types/proxy.js";
import {
  createInstanceConfigProvider,
  createInstanceLoggerProvider,
  createProxyInstance,
} from "./instance.js";
import { runAsMaster, shouldRunAsMaster } from "./server/cluster.js";
import { createInstanceLogger, setProcessScope } from "./utils/log/logger.js";

/** 单进程/worker 的实例标识（纯诊断用，不参与任何判定）。 */
const PROCESS_INSTANCE_NAME = "proxy";
/** 进程级日志前缀：CLI 自己的提示行用它，与实例内部模块的 child 前缀区分。 */
const PROCESS_LOG_PREFIX = "[proxy]";
const PROXY_START_CANCELLED_CODE = "ERR_PROXY_START_CANCELLED" satisfies ProxyLifecycleErrorCode;

/** 从 unknown 异常中安全读取字符串错误码；仅用于 CLI 的窄分类。 */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  try {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 按进程角色启动代理
 *
 * master 与单进程/worker 走两条完全不同的路径，这是**唯一的**分叉点：
 * - master（`clusterWorkers > 1` 且本进程不是 worker）：**不装配协议内核**，只把同一份
 *   进程配置与日志器交给 cluster 编排层（fork / IPC / 跨层 grace 预算）。
 * - 单进程/worker：建一个库实例句柄、申请进程信号、启动。信号必须在 `start()` 之前
 *   申请——`stop()` 收口会摘掉 listener，而 `start()` 只在已被申请时才重挂。
 */
async function startByRole(scope: ConfigScope): Promise<void> {
  if (shouldRunAsMaster(scope.get("clusterWorkers"))) {
    setProcessScope(scope);
    await runAsMaster({
      allowProcessExit: true,
      config: createInstanceConfigProvider(scope),
      logger: createInstanceLoggerProvider(scope, PROCESS_INSTANCE_NAME),
    });
    return;
  }

  const instance = createProxyInstance({
    name: PROCESS_INSTANCE_NAME,
    config: scope.getAll(),
    // CLI 是唯一显式授权 server-owned 退出路径的宿主；库消费方默认 false。
    allowProcessExit: true,
  });
  // 登记**实例自己的** scope：单进程下全进程只有这一份配置，
  // 进程门面日志与实例日志因此共用同一套 LOG_LEVEL/LOG_FILE。
  setProcessScope(instance.config.scope);
  instance.attachSignals();
  await instance.start();
}

/**
 * 启动失败的最后一次记录与退出
 *
 * 走日志模块的**同一个 sink**（不做 `console.*` 旁路）：`process.exit` 会截断在途
 * appendFile，「为什么退 1」那一行落不了盘的话，排查的人只能对着裸堆栈猜。
 * `initConfig` 失败时进程级 scope 尚未登记、实例也不存在，此时用 defaults 播种的
 * 空作用域造一个**临时**日志器（落盘基址仍走 `LOG_FILE` env 回退），只为让失败可见。
 */
function reportStartupFailure(error: unknown, scope: ConfigScope | undefined): void {
  const code = getErrorCode(error);
  if (code === PROXY_START_CANCELLED_CODE) {
    // signal/cluster shutdown owner 已接管这一代 start；让它完成 exit(0) 或 hard-exit。
    // CLI 不重复记录启动失败，也不 flush/exit，避免覆盖 owner 的退出语义。
    return;
  }

  const log = createInstanceLogger(scope ?? createConfigScope(), { prefix: PROCESS_LOG_PREFIX });
  const asErrno = error as NodeJS.ErrnoException & { port?: number };
  if (code === "EADDRINUSE") {
    // 端口取**本进程已加载的配置**（无参全局 `get()` 已随配置单例一起删除）；
    // 配置没加载出来时退回异常自带的 port。
    const port = scope?.get("port") ?? asErrno.port;
    const next = Number(port) + 1;
    log.error(`proxy 启动失败: 端口 ${String(port)} 已被占用 (EADDRINUSE)`);
    log.error(`解决: netstat -ano | findstr :${String(port)} -> taskkill //PID <pid> //F`);
    log.error(`换端口: pnpm start -- --port ${next}`);
  } else {
    log.error("proxy 启动失败:", error);
  }
  // 显式退出会截断在途 appendFile：等齐上面几行 error 再退。
  void log.flush().finally(() => process.exit(1));
}

/** 进程入口：读到 scope → 按角色启动；启动期任何失败都在这里收口。 */
async function main(): Promise<void> {
  // 配置加载失败时既没有 scope 也没有实例，只能把 scope 留空让失败路径自建日志器。
  let scope: ConfigScope | undefined;
  try {
    scope = initConfig({ argv: process.argv.slice(2) });
    await startByRole(scope);
  } catch (error) {
    reportStartupFailure(error, scope);
  }
}

if (require.main === module) {
  void main();
}
