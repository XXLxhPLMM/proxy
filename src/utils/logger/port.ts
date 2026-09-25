/**
 * @fileoverview 日志端口与共享等级表
 * @module utils/logger/port
 * @description
 * `logger/` 目录里**唯一的契约层**：库模式可注入的最小日志端口（`Logger`）、
 * 结构化字段集合（`LogFields`），以及两个实现共用的等级表（`ORDER` / `COLOR`）。
 *
 * 职责：
 * - 声明 `Logger` / `LogFields` / 透传 `LogLevel`
 * - 持有等级权重 `ORDER`（`impl.ts` 的门控与 `console.ts` 的阈值都用它）
 * - 持有终端色码 `COLOR`（只在 `impl.ts` 的控制台渲染里消费）
 *
 * 不负责：
 * - 文本净化与参数拆分（`sanitize.ts`）、落盘（`jsonl.ts`）、
 *   完整实现（`impl.ts`）、轻量控制台实现（`console.ts`）、空实现（`noop.ts`）
 * - 不读配置、不碰文件系统、不写任何输出
 */

/** 等级类型直接沿用配置层的定义，避免两处枚举漂移。 */
import type { LogLevel } from "@/config/index.js";

export type { LogLevel };

/** 可注入 logger 的结构化字段集合。 */
export interface LogFields {
  [k: string]: unknown;
}

/** 库模式可注入的最小日志端口：只约束调用能力，不暴露具体日志实现。 */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** 等齐在途落盘；无落盘的实现可直接 resolve。 */
  flush?(): Promise<void>;
}

/**
 * 等级权重：数值越大越严重；`silent=4` 关闭一切（`enabled` 恒 false）
 * @description `impl.ts` 的双通道门控与 `console.ts` 的显式阈值判定共用本表，
 * 门限比较一律走 `ORDER[a] >= ORDER[b]`，不允许在实现里内联数字。
 */
export const ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/**
 * 终端色码：仅终端用，`color=false` 时退化为纯文本，避免落盘/重定向被转义污染
 * @description `silent` 不在表内（永不上屏），故类型里 `Exclude` 掉。
 */
export const COLOR: Record<Exclude<LogLevel, "silent">, string> = {
  debug: "\x1b[36m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
