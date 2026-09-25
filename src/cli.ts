/**
 * CLI 入口 - 唯一的宿主环境采集与进程启动边界。
 *
 * import 本模块不会加载配置；仅 `require.main === module` 时读取一份 process
 * 环境/argv 快照，显式交给异步 `loadConfig()`，再把返回的 ConfigContext 传给
 * `runServer()`。库调用方不会经过这里。
 */

import type { ConfigContext } from "./config/accessor.js";
import { defaultEnvFileNames } from "./config/config-helpers.js";
import { loadConfig } from "./config/load.js";
import { runServer } from "./server/index.js";
import {
  createConsoleLogger,
  createLogger,
  type Logger,
  type LoggerImpl,
} from "./utils/logger.js";

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
  await runServer(context, logger, Boolean(env.NO_COLOR));
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
