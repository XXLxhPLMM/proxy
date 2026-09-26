import type { Plugin } from "cordis";
import type { ErrorFieldValue } from "./error-service.js";
import { ERROR_OBSERVED_EVENT, type ErrorLevel } from "./events.js";
import type { LoggerService } from "./logger-service.js";

function writeRuntimeError(
  log: ReturnType<LoggerService["child"]>,
  level: ErrorLevel,
  fields: Readonly<Record<string, ErrorFieldValue>>,
): void {
  switch (level) {
    case "debug":
      log.debug("[runtime-error]", fields);
      return;
    case "info":
      log.info("[runtime-error]", fields);
      return;
    case "warn":
      log.warn("[runtime-error]", fields);
      return;
    case "error":
      log.error("[runtime-error]", fields);
      return;
  }
}

/**
 * 提供应用日志服务，并只记录 ownership 明确属于 runtime 的安全错误观察。
 * start 失败由 CLI 最终记录，stop 失败由 ProxyServer 最终记录；config/json-file
 * 继续走各自唯一 sink。这里不覆盖 ctx.logger，也不改变 LoggerService flush 语义。
 */
export function createLoggerPlugin(service: LoggerService): Plugin.Object<void> {
  return {
    name: "app-logger",
    apply(ctx) {
      const log = service.child("runtime");

      ctx.on(ERROR_OBSERVED_EVENT, (event) => {
        if (event.handling.logOwner !== "runtime") {
          return;
        }

        const fields = Object.create(null) as Record<string, ErrorFieldValue>;
        for (const [key, value] of Object.entries(event.error.fields)) {
          fields[key] = value;
        }
        // 固定字段后写，hint 不能覆盖事件身份、顺序或错误摘要。
        fields.sequence = event.sequence;
        fields.origin = event.origin.source;
        fields.operation = event.origin.operation;
        if (event.origin.source === "runtime/event-dispatch") {
          fields.event = event.origin.event;
        }
        fields.impact = event.impact;
        fields.propagation = event.handling.propagation;
        fields.name = event.error.name;
        fields.message = event.error.message;
        if (event.error.code !== undefined) {
          fields.code = event.error.code;
        }

        writeRuntimeError(log, event.handling.level, fields);
      });
    },
  };
}
