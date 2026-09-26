import fs from "node:fs";
import path from "node:path";
import { COLOR, currentFileLevel, currentLevel, enabledAt, logFile, toHourlyFile } from "./level.js";
import { renderFieldValue, renderValue, sanitizeLogText, splitFields } from "./text.js";
import type { LogLevel } from "./level.js";

export type { LogLevel } from "./level.js";

// 在途落盘集合：模块级、全实例共享（含 child 与其他 prefix），flush() 据此等齐所有 appendFile
const pendingWrites = new Set<Promise<void>>();

export interface LoggerOptions {
  /** 日志前缀，默认 [proxy]；child 会拼接为父:子 */
  prefix?: string;
  /** 强制控制台等级，覆盖 currentLevel 的三级回退（测试/子模块定级用） */
  level?: LogLevel;
  /** 强制落盘等级，覆盖 currentFileLevel 的三级回退（测试/子模块定级用） */
  fileLevel?: LogLevel;
  /** 是否着色，默认按 stdout.isTTY 探测（文件/管道下自动关闭） */
  color?: boolean;
  /** 落盘基址，覆盖 logFile()；缺省则跟随全局配置 */
  file?: string;
}

export class Logger {
  private prefix: string;
  private forcedLevel?: LogLevel;
  private forcedFileLevel?: LogLevel;
  private color: boolean;
  private fileBase?: string;

  constructor(opts: LoggerOptions = {}) {
    // 默认值来源：prefix 取 [proxy] 保可读性，color 按 isTTY 探测防重定向乱码
    this.prefix = opts.prefix ?? "[proxy]";
    this.forcedLevel = opts.level;
    this.forcedFileLevel = opts.fileLevel;
    this.color = opts.color ?? !!process.stdout.isTTY;
    this.fileBase = opts.file;
  }

  private level(): LogLevel {
    return this.forcedLevel ?? currentLevel();
  }

  private fileLevel(): LogLevel {
    return this.forcedFileLevel ?? currentFileLevel();
  }

  private enabled(target: LogLevel, level: LogLevel): boolean {
    return enabledAt(target, level);
  }

  // fmt 供控制台：彩色等级 + 时间 + 前缀 + msg；fields 以 ` k=v` 追加（人读友好）
  private fmt(level: LogLevel, args: unknown[], fields?: Record<string, unknown>): unknown[] {
    const colorCode = COLOR[level as Exclude<LogLevel, "silent">];
    const lvl = this.color ? `${colorCode}${level.toUpperCase()}\x1b[0m` : level.toUpperCase();
    const ts = new Date().toISOString();
    const out: unknown[] = [
      `${ts} ${lvl} ${this.prefix}`,
      ...args.map((a) => (typeof a === "string" ? sanitizeLogText(a) : a)),
    ];
    const rendered = this.renderFields(fields);
    if (rendered !== "") {
      out.push(rendered);
    }
    return out;
  }

  // 控制台字段渲染：跳过 undefined/null，其余 `k=v` 空格拼接；无可见字段时返回空串
  private renderFields(fields?: Record<string, unknown>): string {
    if (fields === undefined) {
      return "";
    }
    const parts: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      const rendered = renderFieldValue(v);
      if (rendered !== undefined) {
        parts.push(`${k}=${rendered}`);
      }
    }
    return parts.join(" ");
  }

  // plain 供落盘：单行 JSONL 对象；保留键 ts/level/pid/prefix/msg 覆盖同名字段（合并顺序即优先级）
  private plain(level: LogLevel, args: unknown[], fields?: Record<string, unknown>): string {
    // 非字段参数经 renderValue 后空格 join；再整体 sanitizeLogText 作纵深防御（控制字符恒被转义）
    const msg = sanitizeLogText(args.map((a) => renderValue(a)).join(" "));
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

  private persist(level: LogLevel, args: unknown[], fields?: Record<string, unknown>): void {
    // 静默吞错：日志故障不拖垮主流程（序列化/mkdir/append 失败均忽略）
    try {
      const raw = this.fileBase ?? logFile();
      if (!raw) {
        return;
      }
      const file = toHourlyFile(raw);
      try {
        const dir = path.dirname(file);
        if (!fs.existsSync(dir)) {
          // 0700：日志含审计行（鉴权失败、转发目标），目录不应对其他用户开放
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
      } catch {
        // ignore mkdir errors
      }
      const write = fs.promises
        .appendFile(file, this.plain(level, args, fields), { encoding: "utf8", mode: 0o600 })
        .catch(() => {
          // ignore persist errors
        });
      pendingWrites.add(write);
      void write.then(() => {
        pendingWrites.delete(write);
      });
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

  // 等齐在途落盘后返回（模块级集合共享，child/其他实例的写入也在内）；条目均已吞错，本方法不会 reject
  // process.exit 会截断在途 appendFile：显式退出路径须先 await，正常事件循环退出无需调用
  async flush(): Promise<void> {
    await Promise.allSettled([...pendingWrites]);
  }

  // 派生子日志器：继承双通道等级/color/file 并拼接 prefix（父:子形态）
  child(prefix: string): Logger {
    return new Logger({
      prefix: `${this.prefix}:${prefix}`,
      level: this.forcedLevel,
      fileLevel: this.forcedFileLevel,
      color: this.color,
      file: this.fileBase,
    });
  }

  // 运行时覆写：测试/动态调级用，不触及 store 全局配置
  setLevel(l: LogLevel): void {
    this.forcedLevel = l;
  }

  setFileLevel(l: LogLevel): void {
    this.forcedFileLevel = l;
  }

  // 运行时覆写落盘基址：undefined 即回退全局 logFile()
  setFile(f: string | undefined): void {
    this.fileBase = f;
  }
}

export const logger = new Logger();

// 快捷派生：等价 logger.child，协议模块入口用（如 getLogger("https")）
export function getLogger(prefix: string): Logger {
  return logger.child(prefix);
}

export default logger;
