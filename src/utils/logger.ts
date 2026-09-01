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

import fs from "node:fs";
import path from "node:path";
import { get } from "../config/store.js";
import type { LogLevel } from "../config/store.js";

export type { LogLevel } from "../config/store.js";

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

/** 缓存解析后的日志文件路径，按小时失效 */
let cachedRawPath: string | undefined;
let cachedResolvedFile: string | undefined;
let cachedHour: number = -1;

/** 当前 UTC ISO 时间戳 */
function now(): string {
  return new Date().toISOString();
}

/** 目标等级是否达到当前等级（达到才输出） */
function shouldPrint(current: LogLevel, target: LogLevel): boolean {
  return LEVEL_ORDER[target] >= LEVEL_ORDER[current];
}

/** 生效等级：优先 store 配置，其次环境变量，缺省 info */
function getCurrentLevel(): LogLevel {
  const v = get("logLevel");
  if (v && LEVEL_ORDER[v] !== undefined) return v;
  const env = (process.env.LOG_LEVEL ?? process.env.LOGLEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVEL_ORDER[env] !== undefined ? env : "info";
}

/** 持久化文件路径：优先 store 配置，其次环境变量 */
function getLogFile(): string | undefined {
  const v = get("logFile");
  if (v) return v;
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
  // base 为目录（log/logs）或已含扩展名的文件
  if (base.endsWith("/") || base.endsWith("\\") || base === "log" || base === "logs" || !path.extname(base)) {
    return path.join(base, name);
  }
  // 若传入的是文件路径，则按同目录每小时一文件：log/app.log -> log/2026-08-31-10.log
  return path.join(path.dirname(base), name);
}

/** 将原始路径解析为当前小时的实际落盘文件 */
function resolveLogFile(raw: string): string {
  return toHourlyFile(raw);
}

/**
 * 日志器构造选项 - 全部可选，缺省时等级/持久化文件从全局配置读取
 */
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

/**
 * 日志器实例 - 进程级统一日志出口
 * 职责：按等级过滤输出、tty 着色、可选文件持久化（按小时轮转）
 * 通过 child(prefix) 派生带前缀的子 logger，继承等级与持久化目标
 */
export class Logger {
  private prefix: string;
  private forcedLevel?: LogLevel;
  private color: boolean;
  private file?: string;

  /**
   * @param opts - 前缀、强制等级、着色开关、持久化文件
   */
  constructor(opts: LoggerOptions = {}) {
    this.prefix = opts.prefix ?? "[proxy]";
    this.forcedLevel = opts.level;
    const envForce = process.env.FORCE_COLOR;
    // concurrently 管道时 isTTY=false，需尊重 FORCE_COLOR=1 强制着色
    this.color = opts.color ?? (envForce !== undefined ? envForce !== "0" : !!process.stdout.isTTY);
    this.file = opts.file;
  }

  /** 生效等级：优先强制等级，否则读取全局配置 */
  private level(): LogLevel {
    return this.forcedLevel ?? getCurrentLevel();
  }

  /**
   * 惰性求值：当首个参数为函数时，视为惰性日志，仅在本等级开启时才求值，
   * 避免被过滤的日志（如 JSON.stringify 大对象）产生无谓开销
   */
  private resolveLazy(args: unknown[]): unknown[] {
    if (typeof args[0] === "function") {
      return [(args[0] as () => unknown)(), ...args.slice(1)];
    }
    return args;
  }

  /** 组装输出数组：时间戳 + 等级 + 前缀 + 内容，着色仅用于终端，落盘走 plain 去色 */
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

  /** 异步持久化到文件（按小时轮转），失败静默忽略，不阻塞事件循环 */
  private persist(level: LogLevel, args: unknown[]): void {
    const raw = this.file ?? getLogFile();
    if (!raw) return;
    const currentHour = new Date().getHours();
    if (cachedRawPath !== raw || cachedHour !== currentHour) {
      cachedRawPath = raw;
      cachedResolvedFile = resolveLogFile(raw);
      cachedHour = currentHour;
    }
    const file = cachedResolvedFile!;
    // 异步落盘，不阻塞事件循环
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch {}
    fs.promises.appendFile(file, this.plain(level, args), "utf8").catch(() => {});
  }

  /** debug 级日志，等级未开启时直接丢弃（首参为函数时惰性求值） */
  debug(...args: unknown[]): void {
    if (!shouldPrint(this.level(), "debug")) return;
    const finalArgs = this.resolveLazy(args);
    console.debug(...this.format("debug", finalArgs));
    this.persist("debug", finalArgs);
  }

  /** info 级日志，记录重要业务流程（首参为函数时惰性求值） */
  info(...args: unknown[]): void {
    if (!shouldPrint(this.level(), "info")) return;
    const finalArgs = this.resolveLazy(args);
    console.info(...this.format("info", finalArgs));
    this.persist("info", finalArgs);
  }

  /** warn 级日志，警告信息需关注（首参为函数时惰性求值） */
  warn(...args: unknown[]): void {
    if (!shouldPrint(this.level(), "warn")) return;
    const finalArgs = this.resolveLazy(args);
    console.warn(...this.format("warn", finalArgs));
    this.persist("warn", finalArgs);
  }

  /** error 级日志，错误信息需处理（首参为函数时惰性求值） */
  error(...args: unknown[]): void {
    if (!shouldPrint(this.level(), "error")) return;
    const finalArgs = this.resolveLazy(args);
    console.error(...this.format("error", finalArgs));
    this.persist("error", finalArgs);
  }

  /** 子 logger，继承等级与持久化目标 */
  child(prefix: string): Logger {
    return new Logger({ prefix: `${this.prefix}:${prefix}`, level: this.forcedLevel, color: this.color, file: this.file });
  }

  /** 运行时切换强制等级，覆盖全局配置 */
  setLevel(level: LogLevel): void {
    this.forcedLevel = level;
  }

  /** 运行时指定持久化文件（优先级高于全局 LOG_FILE） */
  setFile(file: string | undefined): void {
    this.file = file;
    cachedRawPath = undefined;
    cachedResolvedFile = undefined;
    cachedHour = -1;
  }
}

/** 全局单例，默认前缀 [proxy] */
export const logger = new Logger();

/** 快捷创建带前缀的子 logger */
export function getLogger(prefix: string): Logger {
  return logger.child(prefix);
}

export default logger;
