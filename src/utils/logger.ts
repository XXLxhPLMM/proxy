import fs from "node:fs";
import path from "node:path";
import { get } from "@/config/store.js";
import type { LogLevel } from "@/config/store.js";
import { RE_LOG_CONTROL_CHARS } from "@/utils/constants.js";

export type { LogLevel } from "@/config/store.js";

// 等级权重：数值越大越严重；silent=4 关闭一切（enabled 恒 false）
const ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};
// 颜色码仅终端用：color=false 时退化为纯文本，避免落盘/重定向被转义污染
const COLOR: Record<Exclude<LogLevel, "silent">, string> = {
  debug: "\x1b[36m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

/**
 * 日志文本净化：把控制字符（C0 + DEL）转义为可见形式
 * @description 客户端可控字节（SOCKS 域名/USERID、Host 头、X-Forwarded-For、凭证）可能含 `\n`
 * （伪造整条日志、污染审计）或 ESC（终端转义注入）；落盘与控制台统一净化，保证单条日志恒为单行
 * @param s - 原始文本
 * @returns 转义后的单行文本
 * @example sanitizeLogText("a\nINFO fake") // => "a\\nINFO fake"
 */
function sanitizeLogText(s: string): string {
  return s.replace(RE_LOG_CONTROL_CHARS, (c) => {
    if (c === "\n") {
      return "\\n";
    }
    if (c === "\r") {
      return "\\r";
    }
    if (c === "\t") {
      return "\\t";
    }
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

// 控制台三级回退：store 配置 > 终端 env(LOG_LEVEL) > error；非法值逐级丢弃防误关日志
function currentLevel(): LogLevel {
  const v = get("logLevel");
  if (v && ORDER[v] !== undefined) {
    return v;
  }
  const e = (process.env.LOG_LEVEL ?? "error").toLowerCase() as LogLevel;
  if (ORDER[e] !== undefined) {
    return e;
  }
  return "error";
}

// 落盘三级回退：store 配置 > 终端 env(LOG_FILE_LEVEL) > info；与控制台完全独立
function currentFileLevel(): LogLevel {
  const v = get("logFileLevel");
  if (v && ORDER[v] !== undefined) {
    return v;
  }
  const e = (process.env.LOG_FILE_LEVEL ?? "info").toLowerCase() as LogLevel;
  if (ORDER[e] !== undefined) {
    return e;
  }
  return "info";
}

// 来源：store logFile 优先，LOG_FILE 回退；缺失返回 undefined 即不落盘
function logFile(): string | undefined {
  return get("logFile") ?? process.env.LOG_FILE ?? undefined;
}

// 小时轮转：目录/无扩展名则 join，带文件名只取 dirname；按小时切分防单文件膨胀
function toHourlyFile(base: string): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const name = `${year}-${month}-${day}-${hour}.log`;
  if (!path.extname(base) || base === "log" || base === "logs") {
    return path.join(base, name);
  }
  return path.join(path.dirname(base), name);
}

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
  private file?: string;

  constructor(opts: LoggerOptions = {}) {
    // 默认值来源：prefix 取 [proxy] 保可读性，color 按 isTTY 探测防重定向乱码
    this.prefix = opts.prefix ?? "[proxy]";
    this.forcedLevel = opts.level;
    this.forcedFileLevel = opts.fileLevel;
    this.color = opts.color ?? !!process.stdout.isTTY;
    this.file = opts.file;
  }

  private level(): LogLevel {
    return this.forcedLevel ?? currentLevel();
  }

  private fileLevel(): LogLevel {
    return this.forcedFileLevel ?? currentFileLevel();
  }

  private enabled(target: LogLevel, level: LogLevel): boolean {
    return ORDER[target] >= ORDER[level];
  }

  // fmt 供控制台：彩色等级 + 时间 + 前缀；plain 供文件：无色 + 非串 JSON 化保可读
  private fmt(level: LogLevel, args: unknown[]): unknown[] {
    const colorCode = COLOR[level as Exclude<LogLevel, "silent">];
    const lvl = this.color ? `${colorCode}${level.toUpperCase()}\x1b[0m` : level.toUpperCase();
    const ts = new Date().toISOString();
    return [
      `${ts} ${lvl} ${this.prefix}`,
      ...args.map((a) => (typeof a === "string" ? sanitizeLogText(a) : a)),
    ];
  }

  // 序列化单个参数：字符串原样，其余尽力 JSON 化；循环引用/BigInt/Symbol/函数等一律不抛
  private stringify(a: unknown): string {
    if (typeof a === "string") {
      return sanitizeLogText(a);
    }
    try {
      const s = JSON.stringify(a);
      // 函数/Symbol/undefined 的 JSON.stringify 返回 undefined，非抛错，同样回退到 String
      if (s !== undefined) {
        return s;
      }
    } catch {
      // 循环引用 / BigInt 等抛错：落入下方 String 回退
    }
    try {
      return String(a);
    } catch {
      // String(symbol) 之外的极端不可字符串化值：占位兜底，绝不外抛
      return "[unserializable]";
    }
  }

  private plain(level: LogLevel, args: unknown[]): string {
    const msg = args.map((a) => this.stringify(a)).join(" ");
    const ts = new Date().toISOString();
    const upper = level.toUpperCase();
    return `${ts} ${upper} ${this.prefix} ${msg}\n`;
  }

  private persist(level: LogLevel, args: unknown[]): void {
    // 静默吞错：日志故障不拖垮主流程（序列化/mkdir/append 失败均忽略）
    try {
      const raw = this.file ?? logFile();
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
      fs.promises
        .appendFile(file, this.plain(level, args), { encoding: "utf8", mode: 0o600 })
        .catch(() => {
          // ignore persist errors
        });
    } catch {
      // ignore any persist-time error (path/时间/序列化等)，保证 logger.* 永不抛
    }
  }

  // 双通道各过各闸：控制台走 write、落盘走 persist，任一通道静音不影响另一通道
  private emit(level: LogLevel, args: unknown[]): void {
    if (this.enabled(level, this.level())) {
      try {
        this.write(level, args);
      } catch {
        // 控制台写入异常（含不可字符串化参数）不阻断落盘通道
      }
    }
    if (this.enabled(level, this.fileLevel())) {
      this.persist(level, args);
    }
  }

  // 四分支映射：等级对齐 console 方法（等级已在外层过滤）
  private write(level: LogLevel, args: unknown[]): void {
    const o = this.fmt(level, args);
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

  // 绕过落盘专供启动期：同步写 stdout，保证配置快照在退出前可见；受控制台等级门控
  infoSync(...a: unknown[]): void {
    if (this.enabled("info", this.level())) {
      try {
        process.stdout.write(this.fmt("info", a).join(" ") + "\n");
      } catch {
        // 参数不可字符串化（如 Symbol）导致 join 抛错：吞掉，同步日志永不外抛
      }
    }
  }

  // 无条件输出专供 banner：不受等级门控，logger.raw 不落盘色码安全
  raw(...a: unknown[]): void {
    console.log(...a);
  }

  async flush(): Promise<void> {
    // no-op, kept for interface compatibility
  }

  // 派生子日志器：继承双通道等级/color/file 并拼接 prefix（父:子形态）
  child(prefix: string): Logger {
    return new Logger({
      prefix: `${this.prefix}:${prefix}`,
      level: this.forcedLevel,
      fileLevel: this.forcedFileLevel,
      color: this.color,
      file: this.file,
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
    this.file = f;
  }
}

export const logger = new Logger();

// 快捷派生：等价 logger.child，协议模块入口用（如 getLogger("https")）
export function getLogger(prefix: string): Logger {
  return logger.child(prefix);
}

export default logger;
