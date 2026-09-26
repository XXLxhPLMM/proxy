/**
 * 日志等级与落盘目标 - 两道门限的取值链与小时轮转文件名
 * 职责：
 * - `currentLevel` / `currentFileLevel`：实例配置 > 终端 env > 缺省的三级回退，每调用现取
 * - `logFile`：落盘基址（实例配置优先、`LOG_FILE` 回退），缺失即不落盘
 * - `toHourlyFile`：按小时切分的 JSONL 文件名
 * 约束：只依赖**调用方显式传入的 `ConfigScope` 实例配置**与 `process.env`；
 *       不读任何模块级单例（配置随实例走，同进程多实例互不可见）、不写盘、不渲染、不抛错。
 */

import path from "node:path";
import type { ConfigScope } from "@/config/scope.js";
import type { LogLevel } from "@/config/types.js";

export type { LogLevel } from "@/config/types.js";

/** 等级权重：数值越大越严重；silent=4 关闭一切（enabled 恒 false） */
const ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/** 颜色码仅终端用：color=false 时退化为纯文本，避免落盘/重定向被转义污染 */
export const COLOR: Record<Exclude<LogLevel, "silent">, string> = {
  debug: "\x1b[36m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

/** 目标等级是否达到阈值（`silent` 阈值 4 使一切 `enabled` 为 false） */
export function enabledAt(target: LogLevel, threshold: LogLevel): boolean {
  return ORDER[target] >= ORDER[threshold];
}

// 控制台三级回退：实例配置 > 终端 env(LOG_LEVEL) > error；非法值逐级丢弃防误关日志
export function currentLevel(scope: ConfigScope): LogLevel {
  const v = scope.get("logLevel");
  if (v && ORDER[v] !== undefined) {
    return v;
  }
  const e = (process.env.LOG_LEVEL ?? "error").toLowerCase() as LogLevel;
  if (ORDER[e] !== undefined) {
    return e;
  }
  return "error";
}

// 落盘三级回退：实例配置 > 终端 env(LOG_FILE_LEVEL) > info；与控制台完全独立
export function currentFileLevel(scope: ConfigScope): LogLevel {
  const v = scope.get("logFileLevel");
  if (v && ORDER[v] !== undefined) {
    return v;
  }
  const e = (process.env.LOG_FILE_LEVEL ?? "info").toLowerCase() as LogLevel;
  if (ORDER[e] !== undefined) {
    return e;
  }
  return "info";
}

// 来源：实例配置 logFile 优先，LOG_FILE 回退；缺失返回 undefined 即不落盘
export function logFile(scope: ConfigScope): string | undefined {
  return scope.get("logFile") ?? process.env.LOG_FILE ?? undefined;
}

/**
 * 小时轮转：目录/无扩展名则 join，带文件名只取 dirname；按小时切分防单文件膨胀
 * 落盘为 JSONL（每行一个 JSON 对象），扩展名随之改为 .jsonl
 */
export function toHourlyFile(base: string): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const name = `${year}-${month}-${day}-${hour}.jsonl`;
  if (!path.extname(base) || base === "log" || base === "logs") {
    return path.join(base, name);
  }
  return path.join(path.dirname(base), name);
}
