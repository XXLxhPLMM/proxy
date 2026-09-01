import { logger } from "./logger.js";

/**
 * 进程级容错：捕获未处理异常/rejection/warning，仅日志不退出
 * @param label 日志前缀，用于区分 server/client 场景，如 "client"
 */
export function setupProcessGuards(label?: string): void {
  if ((globalThis as unknown as { __proxyGuardsInstalled?: boolean }).__proxyGuardsInstalled) return;
  (globalThis as unknown as { __proxyGuardsInstalled: boolean }).__proxyGuardsInstalled = true;

  const prefix = label ? `[${label} ` : "[";
  process.on("uncaughtException", (err) => {
    logger.error(`${prefix}uncaughtException] ${label ? "" : "代理进程"}捕获未处理异常，继续运行:`, err);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error(`${prefix}unhandledRejection] ${label ? "" : "代理进程"}捕获未处理拒绝，继续运行:`, reason);
  });
  process.on("warning", (warning) => {
    logger.warn(`${prefix}warning]`, warning.name, warning.message);
  });
}
