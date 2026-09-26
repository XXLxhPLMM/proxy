/**
 * CLI 入口 - 唯一的宿主环境采集与进程启动边界。
 *
 * import 本模块不会加载配置；仅 `require.main === module` 时读取一份 process
 * 环境/argv 快照，显式交给异步 `loadConfig()`，再把返回的 ConfigContext 与
 * `cliPreset()`（库默认件 + CLI 进程策略）传给 `runServer()`。库调用方不会经过这里。
 *
 * **本文件只做四件事**：快照宿主来源 → 加载配置 → 建 logger 并转交加载告警 → 起进程。
 * 「CLI 是什么」由 `cliPreset()` 回答（它就是「库默认件 + 拥有这个进程」），本文件不再逐项
 * 描述进程级细节——那些住在 `src/server/process.ts` 的 `ProcessPolicy` 实现里。
 */

import { defaultEnvFileNames, loadConfig, type ConfigContext } from "@/config/index.js";
import { TRAFFIC_SLOT_ENV, normalizeSlot } from "@/core/traffic/index.js";
import { cliPreset, runServer } from "@/server/index.js";
import { createConsoleLogger, createLogger, type Logger, type LoggerImpl } from "@/utils/logger/index.js";

async function main(onLoaded: (context: ConfigContext, logger: LoggerImpl) => void): Promise<void> {
  // 第一次 await 前快照所有宿主来源，避免异步加载期间被宿主代码改写。
  const env = { ...process.env };
  const argv = process.argv.slice(2);
  const cwd = process.cwd();

  const context = await loadConfig({
    env,
    envFiles: defaultEnvFileNames(env.NODE_ENV),
    argv,
    cwd,
  });
  const logger = createLogger({ config: context.accessor });
  for (const warning of context.warnings) {
    logger.warn(warning);
  }
  onLoaded(context, logger);
  // 配额账本槽位：**从上面那份 env 快照里取**，不新读 process.env。
  // cluster master 在 fork 时把它注入子进程环境，于是每个 worker 拿到一个稳定序号，
  // core/runtime 全程零 process.env 读取（槽位会被拼进账本文件名，不能靠猜）。
  //
  // `assembly: cliPreset()` = 「CLI 就是库预设的一次组装」：协议 / 服务替身 / 上游连接器
  // 全部走库默认件，预设里唯一的非空位是 `process`（= `cliProcessPolicy`），也就是
  // 「这个进程归 CLI 管」这一条声明。
  await runServer(context, {
    logger,
    noColor: Boolean(env.NO_COLOR),
    trafficWorkerSlot: normalizeSlot(env[TRAFFIC_SLOT_ENV]),
    assembly: cliPreset(),
  });
}

if (require.main === module) {
  let context: ConfigContext | undefined;
  let activeLogger: Logger = createConsoleLogger({ level: "error" });

  void main((loadedContext, logger) => {
    context = loadedContext;
    activeLogger = logger;
  }).catch((err: unknown) => {
    const e = err as NodeJS.ErrnoException & { port?: number };
    if (e?.code === "EADDRINUSE") {
      const port = e.port ?? context?.store.get("port");
      activeLogger.error(`proxy 启动失败: 端口 ${port ?? "unknown"} 已被占用 (EADDRINUSE)`);
      activeLogger.error(
        `解决: netstat -ano | findstr :${port ?? "PORT"} -> taskkill //PID <pid> //F`,
      );
      if (port !== undefined) {
        activeLogger.error(`换端口: pnpm start -- --port ${port + 1}`);
      }
    } else {
      activeLogger.error("proxy 启动失败:", err);
    }
    void Promise.resolve(activeLogger.flush?.()).finally(() => process.exit(1));
  });
}
