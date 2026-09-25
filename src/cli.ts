/**
 * CLI 入口 - 承载全部副作用与进程启动
 * 职责：
 * - 启动流程显式初始化配置，再按角色进入 master supervisor 或 Cordis runtime
 * - 作为脚本直接执行时（require.main === module），单进程/worker 走 Cordis runtime，cluster master 走 supervisor
 * - generation 取消由 signal/cluster shutdown owner 接管，CLI 不重复记录或退出
 * - EADDRINUSE 单独处理：给出占用排查命令与换端口建议，避免用户面对裸堆栈
 *
 * 构建：esbuild 以本文件为 entryPoints 打包出 dist/app.js 与 dist/app-v22.js（Node >=22.6），
 * `node dist/app.js` 的启动语义与拆分前完全一致。
 * 库入口（src/index.ts）保持纯导出，本文件是唯一的副作用承载者。
 */

import { get } from "./index.js";
import type { ProxyLifecycleErrorCode } from "./index.js";
import { ProxyServer } from "./server/index.js";
import { runAsMaster, shouldRunAsMaster } from "./server/cluster.js";
import { startRuntime } from "./runtime/bootstrap.js";
import { createConfigService } from "./runtime/config-service.js";
import { createErrorService } from "./runtime/error-service.js";
import { createLoggerService } from "./runtime/logger-service.js";
import { createPresetService } from "./runtime/preset-service.js";
import { createProxyService } from "./runtime/proxy-service.js";
import { logger } from "./utils/logger.js";

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

async function start(): Promise<void> {
  const config = createConfigService();
  await config.load();

  if (shouldRunAsMaster()) {
    await runAsMaster({ allowProcessExit: true });
    return;
  }

  await startRuntime(createProxyService(new ProxyServer({ allowProcessExit: true })), {
    config,
    preset: createPresetService(config),
    logger: createLoggerService(),
    error: createErrorService(),
  });
}

if (require.main === module) {
  start().catch((err: unknown) => {
    const code = getErrorCode(err);
    if (code === PROXY_START_CANCELLED_CODE) {
      // signal/cluster shutdown owner 已接管这一代 start；让它完成 exit(0) 或 hard-exit。
      // CLI 不重复记录启动失败，也不 flush/exit，避免覆盖 owner 的退出语义。
      return;
    }

    // EADDRINUSE 单独处理：给出占用排查命令与换端口建议，避免用户面对裸堆栈
    const e = err as NodeJS.ErrnoException & { port?: number };
    if (code === "EADDRINUSE") {
      const p = e.port ?? get("port");
      const next = Number(p) + 1;
      logger.error(`proxy 启动失败: 端口 ${p} 已被占用 (EADDRINUSE)`);
      logger.error(`解决: netstat -ano | findstr :${p} -> taskkill //PID <pid> //F`);
      logger.error(`换端口: pnpm start -- --port ${next}`);
    } else {
      logger.error("proxy 启动失败:", err);
    }
    // 显式退出会截断在途 appendFile：等齐上面几行 error 再退
    void logger.flush().finally(() => process.exit(1));
  });
}
