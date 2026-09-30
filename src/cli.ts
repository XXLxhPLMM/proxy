/**
 * CLI 入口 - 唯一的宿主环境采集与进程启动边界。
 *
 * import 本模块不会加载配置；仅 `require.main === module` 时读取一份 process
 * 环境/argv 快照，显式交给异步 `loadConfig()`，再把返回的 ConfigContext 与
 * `cliPreset()`（库默认件 + CLI 进程策略）传给 `runServer()`。库调用方不会经过这里。
 *
 * **本文件只做四件事**：快照宿主来源 → 加载配置 → 建 logger 并转交加载告警 → 起进程。
 * 「CLI 是什么」由 `cliPreset()` 回答（= 库默认件 + 拥有这个进程），进程级细节住在
 * `src/server/process.ts` 的 `ProcessPolicy` 实现里。
 */

import { defaultEnvFileNames, loadConfig, type ConfigContext } from "@/config/index.js";
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
  // 账本是所有进程共用的同一个 SQLite 文件，故**没有槽位可传**（旧形态的 `PROXY_WORKER_SLOT`
  // 连同 `worker-<slot>.jsonl` 分槽一并删除：分槽让配额判定从「账号级封禁」退化成
  // 「每进程一份封禁」，4 个 worker 就是 4 倍额度）。
  //
  // `assembly: cliPreset()` = 「CLI 就是库预设的一次组装」，预设里唯一的非空位是 `process`。
  await runServer(context, {
    logger,
    noColor: Boolean(env.NO_COLOR),
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
