/**
 * @fileoverview 轻量控制台日志实现（第二个 `Logger` 实现）
 * @module utils/logger/console
 * @description
 * 库模式的「要输出、但不想落盘」场景：只按**显式传入**的 level 门控，
 * 不读 config/store/env、不落盘、不创建目录。四方法直接写进程流：
 * debug/info → stdout，warn/error → stderr。
 *
 * 职责：
 * - 提供第二个满足 `Logger` 端口的实现（`createConsoleLogger`）
 * - 复用 `sanitize.ts` 的净化/字段渲染，输出与 `LoggerImpl` 同款文本格式
 *
 * 不负责：
 * - 不读配置：省略 `level` 时固定 `error` 阈值（库默认不打扰调用方）
 * - 不落盘、不着色、不提供 `file/both/notice/infoSync/raw` 等 CLI 侧旁路
 */

import { ORDER, type Logger, type LogLevel } from "./port.js";
import { renderFields, splitFields, stringifyValue } from "./sanitize.js";

/** 控制台 logger：只使用传入 level，不读取全局配置、不落盘。 */
export function createConsoleLogger(options: { level?: LogLevel } = {}): Logger {
  const threshold = ORDER[options.level ?? "error"] ?? ORDER.error;
  const write = (level: Exclude<LogLevel, "silent">, args: unknown[]): void => {
    if (ORDER[level] < threshold) {
      return;
    }
    const { args: rest, fields } = splitFields(args);
    // 非字段参数走 stringifyValue：Error 也会被压成可读单行（与落盘 msg 同款净化）
    const parts = [new Date().toISOString(), level.toUpperCase(), rest.map((a) => stringifyValue(a)).join(" ")];
    const renderedFields = renderFields(fields);
    if (renderedFields !== "") {
      parts.push(renderedFields);
    }
    const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
    try {
      stream.write(`${parts.join(" ")}\n`);
    } catch {
      // 日志输出失败不应反向影响调用方
    }
  };

  return {
    debug(...args: unknown[]): void {
      write("debug", args);
    },
    info(...args: unknown[]): void {
      write("info", args);
    },
    warn(...args: unknown[]): void {
      write("warn", args);
    },
    error(...args: unknown[]): void {
      write("error", args);
    },
    flush(): Promise<void> {
      return Promise.resolve();
    },
  };
}
