/**
 * 控制台日志管理器 - 进程级统一出口，支持文件持久化
 * 职责：
 * - 统一格式：时间戳 + 等级 + 前缀 + 内容，避免散落的 console.log
 * - 等级过滤：按 logLevel 过滤，生产环境可调为 warn/error 降噪
 * - 双端友好：代理常驻进程，需保证日志不击穿进程且可被重定向收集
 * - 持久化：可选写入文件（LOG_FILE / logFile），按日或按大小轮转，由调用方或配置驱动
 * 设计：
 * - 单例：整个进程仅此一份，通过 getLogger/createLogger 获取
 * - 零依赖：仅基于 console + fs，不引入 winston/pino
 * - 与 config 解耦：读取时优先取 src/config/store 的 logLevel/logFile，否则回退环境变量
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const LEVEL_COLOR: Record<Exclude<LogLevel, "silent">, string> = {
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";
const GRAY = "\x1b[90m";

function now(): string {
  return new Date().toISOString();
}

function shouldPrint(current: LogLevel, target: LogLevel): boolean {
  return LEVEL_ORDER[target] >= LEVEL_ORDER[current];
}

function getCurrentLevel(): LogLevel {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const store = require("../config/store.js") as { get?: (k: string) => unknown };
    const v = store.get?.("logLevel") as string | undefined;
    if (v && LEVEL_ORDER[v as LogLevel] !== undefined) return v as LogLevel;
  } catch {}
  const env = (process.env.LOG_LEVEL ?? process.env.LOGLEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVEL_ORDER[env] !== undefined ? env : "info";
}

function getLogFile(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const store = require("../config/store.js") as { get?: (k: string) => unknown };
    const v = store.get?.("logFile") as string | undefined;
    if (v) return v;
  } catch {}
  return process.env.LOG_FILE ?? process.env.LOGFILE ?? process.env.LOG_PATH ?? undefined;
}

/** 按小时生成文件名：log/YYYY-MM-DD-HH.log */
function toHourlyFile(base: string): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const name = `${yyyy}-${mm}-${dd}-${hh}.log`;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  // base 为目录（log/logs）或已含扩展名的文件
  if (base.endsWith("/") || base.endsWith("\\") || base === "log" || base === "logs" || !path.extname(base)) {
    return path.join(base, name);
  }
  // 若传入的是文件路径，则按同目录每小时一文件：log/app.log -> log/2026-08-31-10.log
  return path.join(path.dirname(base), name);
}

function resolveLogFile(raw: string): string {
  return toHourlyFile(raw);
}

export interface LoggerOptions {
  /** 前缀，如 [proxy] / [HttpProxy]，便于 grep */
  prefix?: string;
  /** 强制等级，覆盖全局 */
  level?: LogLevel;
  /** 是否着色，默认 tty 时着色（文件输出自动去色） */
  color?: boolean;
  /** 持久化文件路径，覆盖全局 LOG_FILE */
  file?: string;
}

export class Logger {
  private prefix: string;
  private forcedLevel?: LogLevel;
  private color: boolean;
  private file?: string;

  constructor(opts: LoggerOptions = {}) {
    this.prefix = opts.prefix ?? "[proxy]";
    this.forcedLevel = opts.level;
    this.color = opts.color ?? process.stdout.isTTY;
    this.file = opts.file;
  }

  private level(): LogLevel {
    return this.forcedLevel ?? getCurrentLevel();
  }

  private format(level: LogLevel, args: unknown[]): unknown[] {
    const lvl = this.color ? `${LEVEL_COLOR[level as Exclude<LogLevel, "silent">]}${level.toUpperCase()}${RESET}` : level.toUpperCase();
    const ts = this.color ? `${GRAY}${now()}${RESET}` : now();
    return [`${ts} ${lvl} ${this.prefix}`, ...args];
  }

  /** 去色后的纯文本行，用于落盘 */
  private plain(level: LogLevel, args: unknown[]): string {
    const ts = now();
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    return `${ts} ${level.toUpperCase()} ${this.prefix} ${msg}\n`;
  }

  private persist(level: LogLevel, args: unknown[]): void {
    const raw = this.file ?? getLogFile();
    if (!raw) return;
    try {
      const file = resolveLogFile(raw);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require("node:path") as typeof import("node:path");
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, this.plain(level, args), "utf8");
    } catch {}
  }

  debug(...args: unknown[]): void {
    if (!shouldPrint(this.level(), "debug")) return;
    console.debug(...this.format("debug", args));
    this.persist("debug", args);
  }

  info(...args: unknown[]): void {
    if (!shouldPrint(this.level(), "info")) return;
    console.info(...this.format("info", args));
    this.persist("info", args);
  }

  warn(...args: unknown[]): void {
    if (!shouldPrint(this.level(), "warn")) return;
    console.warn(...this.format("warn", args));
    this.persist("warn", args);
  }

  error(...args: unknown[]): void {
    if (!shouldPrint(this.level(), "error")) return;
    console.error(...this.format("error", args));
    this.persist("error", args);
  }

  /** 子 logger，继承等级与持久化目标 */
  child(prefix: string): Logger {
    return new Logger({ prefix: `${this.prefix}:${prefix}`, level: this.forcedLevel, color: this.color, file: this.file });
  }

  setLevel(level: LogLevel): void {
    this.forcedLevel = level;
  }

  /** 运行时指定持久化文件（优先级高于全局 LOG_FILE） */
  setFile(file: string | undefined): void {
    this.file = file;
  }
}

/** 全局单例，默认前缀 [proxy] */
export const logger = new Logger();

/** 快捷创建带前缀的子 logger */
export function getLogger(prefix: string): Logger {
  return logger.child(prefix);
}

export default logger;
