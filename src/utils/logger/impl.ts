/**
 * @fileoverview 完整日志实现（console + JSONL 双通道）
 * @module utils/logger/impl
 * @description
 * `LoggerImpl` 是本项目的正式 logger 实现，也是 CLI 的构造入口
 * （`createLogger({ config })`）。它**只做编排**：分流 console/file 两条通道、
 * 渲染控制台文本、拼装 JSONL 行；文本净化与参数拆分在 `sanitize.ts`，
 * 落盘 IO 与在途登记在 `jsonl.ts`，等级表在 `port.ts`。
 *
 * 职责：
 * - `emit` 按 console/file 两道**独立**门限分流（`debug/info/warn/error`）
 * - 绕过门限的旁路：`file` / `both` / `notice` / `infoSync` / `raw`
 * - 派生与覆写：`child` / `setLevel` / `setFileLevel` / `setFile`
 * - 等级与落盘基址现读绑定的 `ConfigAccessor`（不缓存配置快照）
 *
 * 不负责：
 * - 不持有任何全局配置、不导出默认实例；每个 logger 必须显式创建或显式注入
 * - 不自己碰文件系统（落盘一律走 `jsonl.ts`）
 */

import type { ConfigAccessor } from "@/config/index.js";
import { COLOR, ORDER, type Logger, type LogLevel } from "./port.js";
import { renderFields, sanitizeLogText, splitFields, stringifyValue } from "./sanitize.js";
import { flushPendingWrites, persistLine } from "./jsonl.js";

/** 控制台等级：显式 level 优先，其次绑定实例的配置，最后固定 error。 */
function resolveLevel(config: ConfigAccessor | undefined): LogLevel {
  const value = config?.get("logLevel");
  return value && ORDER[value] !== undefined ? value : "error";
}

/** 落盘等级：显式 fileLevel 优先，其次绑定实例的配置，最后固定 info。 */
function resolveFileLevel(config: ConfigAccessor | undefined): LogLevel {
  const value = config?.get("logFileLevel");
  return value && ORDER[value] !== undefined ? value : "info";
}

/** 落盘路径只来自显式 file 或绑定实例的配置；缺省即不落盘。 */
function resolveLogFile(config: ConfigAccessor | undefined): string | undefined {
  const value = config?.get("logFile");
  return typeof value === "string" && value !== "" ? value : undefined;
}

export interface LoggerOptions {
  /** 日志前缀，默认 [proxy]；child 会拼接为父:子 */
  prefix?: string;
  /** 绑定到本 logger 的配置访问器；每次输出现读，不缓存配置快照。 */
  config?: ConfigAccessor;
  /** 强制控制台等级，覆盖绑定配置（测试/子模块定级用）。 */
  level?: LogLevel;
  /** 强制落盘等级，覆盖绑定配置（测试/子模块定级用）。 */
  fileLevel?: LogLevel;
  /** 是否着色，默认按 stdout.isTTY 探测（文件/管道下自动关闭）。 */
  color?: boolean;
  /** 强制落盘基址；未给时读取绑定配置的 logFile，仍未给则不落盘。 */
  file?: string;
}

export class LoggerImpl implements Logger {
  private prefix: string;
  private config?: ConfigAccessor;
  private forcedLevel?: LogLevel;
  private forcedFileLevel?: LogLevel;
  private color: boolean;
  private fileBase?: string;

  constructor(opts: LoggerOptions = {}) {
    // 默认值来源：prefix 取 [proxy] 保可读性，color 按 isTTY 探测防重定向乱码
    this.prefix = opts.prefix ?? "[proxy]";
    this.config = opts.config;
    this.forcedLevel = opts.level;
    this.forcedFileLevel = opts.fileLevel;
    this.color = opts.color ?? !!process.stdout.isTTY;
    this.fileBase = opts.file;
  }

  private level(): LogLevel {
    return this.forcedLevel ?? resolveLevel(this.config);
  }

  private fileLevel(): LogLevel {
    return this.forcedFileLevel ?? resolveFileLevel(this.config);
  }

  private enabled(target: LogLevel, level: LogLevel): boolean {
    return ORDER[target] >= ORDER[level];
  }

  // fmt 供控制台：彩色等级 + 时间 + 前缀 + msg；fields 以 ` k=v` 追加（人读友好）
  // 只净化 string 参数：Error 等对象原样交给 console，保留原生堆栈可读性
  private fmt(level: LogLevel, args: unknown[], fields?: Record<string, unknown>): unknown[] {
    const colorCode = COLOR[level as Exclude<LogLevel, "silent">];
    const lvl = this.color ? `${colorCode}${level.toUpperCase()}\x1b[0m` : level.toUpperCase();
    const ts = new Date().toISOString();
    const out: unknown[] = [
      `${ts} ${lvl} ${this.prefix}`,
      ...args.map((a) => (typeof a === "string" ? sanitizeLogText(a) : a)),
    ];
    const rendered = renderFields(fields);
    if (rendered !== "") {
      out.push(rendered);
    }
    return out;
  }

  // plain 供落盘：单行 JSONL 对象；保留键 ts/level/pid/prefix/msg 覆盖同名字段（合并顺序即优先级）
  private plain(level: LogLevel, args: unknown[], fields?: Record<string, unknown>): string {
    // 非字段参数经 stringifyValue 后空格 join；再整体 sanitizeLogText 作纵深防御（控制字符恒被转义）
    const msg = sanitizeLogText(args.map((a) => stringifyValue(a)).join(" "));
    const line: Record<string, unknown> = {
      ...(fields ?? {}),
      ts: new Date().toISOString(),
      level,
      pid: process.pid,
      prefix: this.prefix,
      msg,
    };
    return `${JSON.stringify(line)}\n`;
  }

  // 落盘编排：基址来自显式 file 或绑定配置，缺省即不落盘；IO 全部委托 jsonl.ts
  private persist(level: LogLevel, args: unknown[], fields?: Record<string, unknown>): void {
    // 静默吞错：日志故障不拖垮主流程（路径/序列化/mkdir/append 失败均忽略）
    try {
      const base = this.fileBase ?? resolveLogFile(this.config);
      if (!base) {
        return;
      }
      persistLine(base, this.plain(level, args, fields));
    } catch {
      // ignore any persist-time error (path/时间/序列化等)，保证 logger.* 永不抛
    }
  }

  // 双通道各过各闸：控制台走 write、落盘走 persist，任一通道静音不影响另一通道
  // 结构化识别只做一次，两条通道共用同一份 rest+fields
  private emit(level: LogLevel, args: unknown[]): void {
    const { args: rest, fields } = splitFields(args);
    if (this.enabled(level, this.level())) {
      try {
        this.write(level, rest, fields);
      } catch {
        // 控制台写入异常（含不可字符串化参数）不阻断落盘通道
      }
    }
    if (this.enabled(level, this.fileLevel())) {
      this.persist(level, rest, fields);
    }
  }

  // 四分支映射：等级对齐 console 方法（等级已在外层过滤）
  private write(level: LogLevel, args: unknown[], fields?: Record<string, unknown>): void {
    const o = this.fmt(level, args, fields);
    if (level === "debug") {
      console.debug(...o);
    } else if (level === "info") {
      console.info(...o);
    } else if (level === "warn") {
      console.warn(...o);
    } else if (level === "error") {
      console.error(...o);
    }
  }

  debug(...a: unknown[]): void {
    this.emit("debug", a);
  }

  info(...a: unknown[]): void {
    this.emit("info", a);
  }

  warn(...a: unknown[]): void {
    this.emit("warn", a);
  }

  error(...a: unknown[]): void {
    this.emit("error", a);
  }

  // 只入盘，不输出控制台。不受 fileLevel 控制，始终持久化（类似 raw 对控制台的保证）
  file(level: LogLevel, ...a: unknown[]): void {
    const { args: rest, fields } = splitFields(a);
    this.persist(level, rest, fields);
  }

  // 无条件双通道：控制台按 info/warn 同款渲染，落盘走同一 JSONL 管线；两道门全绕过
  both(level: LogLevel, ...a: unknown[]): void {
    const { args: rest, fields } = splitFields(a);
    try {
      this.write(level, rest, fields);
    } catch {
      // 控制台异常不阻断落盘
    }
    this.persist(level, rest, fields);
  }

  // 生命周期/配置通知：控制台绕过等级阈值（silent 硬关闭除外），落盘照走 fileLevel 门控
  // 与 both 的差别：通知只要求「操作者必须看见」，落盘策略仍归 LOG_FILE_LEVEL，不强行写盘
  notice(level: LogLevel, ...a: unknown[]): void {
    const { args: rest, fields } = splitFields(a);
    if (this.level() !== "silent") {
      try {
        this.write(level, rest, fields);
      } catch {
        // 控制台异常不阻断落盘
      }
    }
    if (this.enabled(level, this.fileLevel())) {
      this.persist(level, rest, fields);
    }
  }

  // 绕过落盘专供启动期：同步写 stdout，保证配置快照在退出前可见；受控制台等级门控
  // 无落盘通道，仅按新控制台渲染（含结构化字段）
  infoSync(...a: unknown[]): void {
    if (this.enabled("info", this.level())) {
      try {
        const { args, fields } = splitFields(a);
        process.stdout.write(this.fmt("info", args, fields).join(" ") + "\n");
      } catch {
        // 参数不可字符串化（如 Symbol）导致 join 抛错：吞掉，同步日志永不外抛
      }
    }
  }

  // 无条件输出专供 banner：不受等级门控，logger.raw 不落盘色码安全
  raw(...a: unknown[]): void {
    console.log(...a);
  }

  // 等齐在途落盘后返回（在途集合是 jsonl.ts 的模块级集合，child/其他实例的写入也在内）
  // process.exit 会截断在途 appendFile：显式退出路径须先 await，正常事件循环退出无需调用
  async flush(): Promise<void> {
    await flushPendingWrites();
  }

  // 派生子日志器：继承配置端口、双通道覆盖值/color/file 并拼接 prefix（父:子形态）
  child(prefix: string): LoggerImpl {
    return new LoggerImpl({
      prefix: `${this.prefix}:${prefix}`,
      config: this.config,
      level: this.forcedLevel,
      fileLevel: this.forcedFileLevel,
      color: this.color,
      file: this.fileBase,
    });
  }

  // 运行时覆写：测试/动态调级用，不改变其它 logger 实例
  setLevel(l: LogLevel): void {
    this.forcedLevel = l;
  }

  setFileLevel(l: LogLevel): void {
    this.forcedFileLevel = l;
  }

  // 运行时覆写落盘基址：undefined 即回退绑定配置的 logFile
  setFile(f: string | undefined): void {
    this.fileBase = f;
  }
}

/** 创建一个显式配置绑定的进程/服务 logger；不读取任何全局配置。 */
export function createLogger(options: LoggerOptions = {}): LoggerImpl {
  return new LoggerImpl(options);
}
