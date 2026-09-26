/**
 * CLI 入口 - 唯一的宿主环境采集与进程启动边界。
 *
 * import 本模块不会加载配置；仅 `require.main === module` 时读取一份 process
 * 环境/argv 快照，显式交给异步 `loadConfig()`，再把返回的 ConfigContext 传给
 * `runServer()`。库调用方不会经过这里。
 */

import { defaultEnvFileNames, loadConfig, type ConfigContext } from "@/config/index.js";
import { TRAFFIC_SLOT_ENV, normalizeSlot } from "@/core/traffic/index.js";
import { runServer } from "@/server/index.js";
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
  // 配额账本槽位（Phase 5b-2）：**从上面那份 env 快照里取**，不新读 process.env。
  // cluster master 在 fork 时把它注入子进程环境，于是每个 worker 拿到一个稳定序号，
  // core/runtime 全程零 process.env 读取（槽位会被拼进账本文件名，不能靠猜）。
  await runServer(context, logger, Boolean(env.NO_COLOR), normalizeSlot(env[TRAFFIC_SLOT_ENV]));
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
