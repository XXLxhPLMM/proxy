/**
 * 配置 JSON 热加载事件 → 日志呈现。
 *
 * 本模块不持有全局 logger；调用方显式传入当前服务 logger，事件如何呈现由组合层决定。
 */

import type { Logger } from "@/utils/logger/index.js";
import type { JsonFileEvent } from "@/utils/json-file/index.js";

export type JsonFileEventLogger = Pick<Logger, "info" | "warn">;

/** 创建可传给 readJsonCached 的事件处理器。 */
export function createJsonFileEventHandler(
  logger: JsonFileEventLogger,
): (event: JsonFileEvent) => void {
  return (event) => {
    logJsonFileEvent(event, logger);
  };
}

/** 把状态迁移事件渲染到显式 logger。 */
export function logJsonFileEvent(event: JsonFileEvent, logger: JsonFileEventLogger): void {
  const fields: Record<string, unknown> = { pid: process.pid };
  if (event.mtimeMs !== undefined) {
    fields.mtimeMs = event.mtimeMs;
  }
  if (event.size !== undefined) {
    fields.size = event.size;
  }

  switch (event.type) {
    case "error":
      logger.warn(
        `[config] ${event.label} 读取失败: ${event.path}: ${event.error}（沿用上一份有效配置）`,
        fields,
      );
      break;
    case "missing":
      logger.warn(`[config] ${event.label} 文件消失: ${event.path}（回退空配置）`, fields);
      break;
    case "recovered":
      logger.info(`[config] ${event.label} 已恢复: ${event.path}`, fields);
      break;
    case "reloaded":
      logger.info(`[config] ${event.label} 已热加载: ${event.path}`, fields);
      break;
  }
}
