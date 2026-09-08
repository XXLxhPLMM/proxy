import fs from "node:fs";
import path from "node:path";
import { get } from "@/config/store.js";
import type { LogLevel } from "@/config/store.js";

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

// 三级回退：store 配置 > 终端 env(LOG_LEVEL) > info；非法值逐级丢弃防误关日志
function currentLevel(): LogLevel {
  const v = get("logLevel");
  if (v && ORDER[v] !== undefined) {
    return v;
  }
  const e = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
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
  /** 强制等级，覆盖 currentLevel 的三级回退（测试/子模块定级用） */
  level?: LogLevel;
  /** 是否着色，默认按 stdout.isTTY 探测（文件/管道下自动关闭） */
  color?: boolean;
  /** 落盘基址，覆盖 logFile()；缺省则跟随全局配置 */
  file?: string;
}

export class Logger {
  private prefix: string;
  private forcedLevel?: LogLevel;
  private color: boolean;
  private file?: string;

  constructor(opts: LoggerOptions = {}) {
    // 默认值来源：prefix 取 [proxy] 保可读性，color 按 isTTY 探测防重定向乱码
    this.prefix = opts.prefix ?? "[proxy]";
    this.forcedLevel = opts.level;
    this.color = opts.color ?? !!process.stdout.isTTY;
    this.file = opts.file;
  }

  private level(): LogLevel {
    return this.forcedLevel ?? currentLevel();
  }

  private enabled(target: LogLevel): boolean {
    return ORDER[target] >= ORDER[this.level()];
  }

  // fmt 供控制台：彩色等级 + 时间 + 前缀；plain 供文件：无色 + 非串 JSON 化保可读
  private fmt(level: LogLevel, args: unknown[]): unknown[] {
    const colorCode = COLOR[level as Exclude<LogLevel, "silent">];
    const lvl = this.color ? `${colorCode}${level.toUpperCase()}\x1b[0m` : level.toUpperCase();
    const ts = new Date().toISOString();
    return [`${ts} ${lvl} ${this.prefix}`, ...args];
  }

  private plain(level: LogLevel, args: unknown[]): string {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    const ts = new Date().toISOString();
    const upper = level.toUpperCase();
    return `${ts} ${upper} ${this.prefix} ${msg}\n`;
  }

  private persist(level: LogLevel, args: unknown[]): void {
    // 静默吞错：日志故障不拖垮主流程（mkdir/append 失败均忽略）
    const raw = this.file ?? logFile();
    if (!raw) {
      return;
    }
    const file = toHourlyFile(raw);
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {
      // ignore mkdir errors
    }
    fs.promises.appendFile(file, this.plain(level, args), "utf8").catch(() => {
      // ignore persist errors
    });
  }

  // 四分支映射：等级对齐 console 方法，落盘统一走 persist（等级已在外层过滤）
  private out(level: LogLevel, args: unknown[]): void {
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
    this.persist(level, args);
  }

  debug(...a: unknown[]): void {
    if (this.enabled("debug")) {
      this.out("debug", a);
    }
  }

  info(...a: unknown[]): void {
    if (this.enabled("info")) {
      this.out("info", a);
    }
  }

  warn(...a: unknown[]): void {
    if (this.enabled("warn")) {
      this.out("warn", a);
    }
  }

  error(...a: unknown[]): void {
    if (this.enabled("error")) {
      this.out("error", a);
    }
  }

  // 绕过落盘专供启动期：同步写 stdout，保证配置快照在退出前可见
  infoSync(...a: unknown[]): void {
    if (this.enabled("info")) {
      process.stdout.write(this.fmt("info", a).join(" ") + "\n");
    }
  }

  // 无条件输出专供 banner：不受等级门控，logger.raw 不落盘色码安全
  raw(...a: unknown[]): void {
    console.log(...a);
  }

  async flush(): Promise<void> {
    // no-op, kept for interface compatibility
  }

  // 派生子日志器：继承 level/color/file 并拼接 prefix（父:子形态）
  child(prefix: string): Logger {
    return new Logger({
      prefix: `${this.prefix}:${prefix}`,
      level: this.forcedLevel,
      color: this.color,
      file: this.file,
    });
  }

  // 运行时覆写：测试/动态调级用，不触及 store 全局配置
  setLevel(l: LogLevel): void {
    this.forcedLevel = l;
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
