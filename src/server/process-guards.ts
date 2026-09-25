import type { Logger } from "@/utils/logger/index.js";

/**
 * 进程级容错：捕获未处理异常/rejection/warning，仅日志不退出（保活优先于 fail-fast，长连接代理忌因单请求崩全服）
 * @param logger 当前服务显式绑定的日志端口
 * @param label 日志前缀，用于区分 server/client 场景，如 "client"
 */
export function setupProcessGuards(logger: Logger, label?: string): void {
  // 幂等旗标：防重复注册致日志翻倍（cluster 多次调用/热重载场景）
  if ((globalThis as unknown as { __proxyGuardsInstalled?: boolean }).__proxyGuardsInstalled)
    return;
  (globalThis as unknown as { __proxyGuardsInstalled: boolean }).__proxyGuardsInstalled = true;

  // prefix 拼出 [client uncaughtException] 形态；无 label 时退化 [uncaughtException] 并补“代理进程”
  const prefix = label ? `[${label} ` : "[";
  process.on("uncaughtException", (err) => {
    logger.error(
      `${prefix}uncaughtException] ${label ? "" : "代理进程"}捕获未处理异常，继续运行:`,
      err,
    );
  });
  process.on("unhandledRejection", (reason) => {
    logger.error(
      `${prefix}unhandledRejection] ${label ? "" : "代理进程"}捕获未处理拒绝，继续运行:`,
      reason,
    );
  });
  process.on("warning", (warning) => {
    logger.warn(`${prefix}warning]`, warning.name, warning.message);
  });
}
