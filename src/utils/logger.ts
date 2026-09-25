import fs from "node:fs";
import path from "node:path";
import { get } from "@/config/store.js";
import type { LogLevel } from "@/config/store.js";
import { RE_LOG_CONTROL_CHARS } from "@/utils/constants.js";

export type { LogLevel } from "@/config/store.js";

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

// 在途落盘集合：模块级、全实例共享（含 child 与其他 prefix），flush() 据此等齐所有 appendFile
const pendingWrites = new Set<Promise<void>>();

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

/**
 * Error 渲染为可读单行文本（落盘 msg 与控制台字段共用）
 * @description Error 的 message/stack 是非枚举属性，JSON.stringify 只会得到 `{}`——
 * 转发层 502 的成因（ECONNREFUSED/TLS 校验失败）会因此丢失。这里特判渲染为
 * `name: message [code=...] [stack 首帧]`，经 sanitizeLogText 净化保证单行。
 * 控制台 msg 通道不经过此函数：Error 原样交给 console，保持原生堆栈可读。
 * @param e - 待渲染的 Error（含自定义 name/code）
 * @returns 净化后的单行文本
 * @example renderErrorText(Object.assign(new Error("boom"), { code: "ECONNREFUSED" }))
 */
function renderErrorText(e: Error): string {
  try {
    const parts: string[] = [`${e.name || "Error"}: ${e.message}`];
    const code = (e as { code?: unknown }).code;
    if (code !== undefined && code !== null) {
      parts.push(`code=${String(code)}`);
    }
    // stack 首帧（`at ...`）：定位抛点；首行通常是 `name: message`，与上方重复故跳过
    const frame = e.stack?.split("\n").find((line) => line.trim().startsWith("at "));
    if (frame) {
      parts.push(frame.trim());
    }
    return sanitizeLogText(parts.join(" "));
  } catch {
    // 病态 Error 子类（抛错的 getter 等）：退化为 String，绝不外抛
    try {
      return sanitizeLogText(String(e));
    } catch {
      return "[unserializable]";
    }
  }
}

/**
 * plain object 判定（严格）
 * @description 仅接受「纯净对象字面量」：原型为 `Object.prototype` 或 `null`。
 * 天然排除 Error / Array / Buffer / Date / Map / 类实例——它们仍按 stringify() 规则进 msg。
 * 这条判定是「最后一个参数是否视作结构化 fields」的唯一依据。
 * @param v - 待判定值
 * @returns 是 plain object 时返回 true，并收窄为 `Record<string, unknown>`
 * @example isPlainObject({ a: 1 }) // => true
 * @example isPlainObject(new Error("x")) // => false
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  );
}

/**
 * 拆出结构化字段：`args` 末位若为 plain object 则视为 fields，不再参与 msg 拼接
 * @description 仅识别**最后一个**参数，前面的 plain object 仍按普通参数进 msg。
 * @param args - 原始参数数组
 * @returns `args`（剔除 fields 后的 msg 参数）与可选 `fields`
 */
function splitFields(args: unknown[]): { args: unknown[]; fields?: Record<string, unknown> } {
  const last = args.length > 0 ? args[args.length - 1] : undefined;
  if (isPlainObject(last)) {
    return { args: args.slice(0, -1), fields: last };
  }
  return { args };
}

/**
 * 控制台渲染单个字段值
 * @description string 净化后原样；number/boolean 直接 String；undefined/null 返回 undefined
 * 表示「跳过该键」；Error 渲染为可读单行文本（renderErrorText）；其余（嵌套对象/数组等）
 * JSON.stringify，失败回退 String，绝不抛。
 * @param v - 字段值
 * @returns 可读文本，或 undefined 表示不打印该键
 */
function renderFieldValue(v: unknown): string | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v === "string") {
    return sanitizeLogText(v);
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (v instanceof Error) {
    return renderErrorText(v);
  }
  try {
    const s = JSON.stringify(v);
    // 函数/Symbol 的 JSON.stringify 返回 undefined（非抛错），同样回退 String
    if (s !== undefined) {
      return s;
    }
  } catch {
    // 循环引用 / BigInt 等抛错：落入下方 String 回退
  }
  try {
    return String(v);
  } catch {
    return "[unserializable]";
  }
}

/** 将结构化字段渲染为控制台 logger 使用的 `k=v` 文本。 */
function renderPortableFields(fields?: LogFields): string {
  if (fields === undefined) {
    return "";
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const rendered = renderFieldValue(value);
    if (rendered !== undefined) {
      parts.push(`${key}=${rendered}`);
    }
  }
  return parts.join(" ");
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
// 落盘为 JSONL（每行一个 JSON 对象），扩展名随之改为 .jsonl
function toHourlyFile(base: string): string {
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

export class LoggerImpl implements Logger {
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
    return ORDER[target] >= ORDER[level];
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

  // 序列化单个参数：字符串原样，Error 渲染为可读单行文本，其余尽力 JSON 化；循环引用/BigInt/Symbol/函数等一律不抛
  private stringify(a: unknown): string {
    if (typeof a === "string") {
      return sanitizeLogText(a);
    }
    if (a instanceof Error) {
      return renderErrorText(a);
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

  // plain 供落盘：单行 JSONL 对象；保留键 ts/level/pid/prefix/msg 覆盖同名字段（合并顺序即优先级）
  private plain(level: LogLevel, args: unknown[], fields?: Record<string, unknown>): string {
    // 非字段参数经 stringify 后空格 join；再整体 sanitizeLogText 作纵深防御（控制字符恒被转义）
    const msg = sanitizeLogText(args.map((a) => this.stringify(a)).join(" "));
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
  child(prefix: string): LoggerImpl {
    return new LoggerImpl({
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

/** 零副作用日志：库默认用，什么都不做、什么都不落盘、不读 config。 */
export function createNoopLogger(): Logger {
  return {
    debug(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
    flush(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** 将控制台 logger 的非字段参数转成单行文本，尽量沿用全局 logger 的净化规则。 */
function formatPortableArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") {
        return sanitizeLogText(arg);
      }
      return renderFieldValue(arg) ?? String(arg);
    })
    .join(" ");
}

/** 控制台 logger：只使用传入 level，不读取全局配置、不落盘。 */
export function createConsoleLogger(options: { level?: LogLevel } = {}): Logger {
  const threshold = ORDER[options.level ?? "error"] ?? ORDER.error;
  const write = (level: Exclude<LogLevel, "silent">, args: unknown[]): void => {
    if (ORDER[level] < threshold) {
      return;
    }
    const { args: rest, fields } = splitFields(args);
    const parts = [new Date().toISOString(), level.toUpperCase(), formatPortableArgs(rest)];
    const renderedFields = renderPortableFields(fields);
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

export const logger = new LoggerImpl();

/** CLI/现有调用方使用的全局 logger 的最小端口视图。 */
export const globalLogger: Logger = logger;

// 快捷派生：等价 logger.child，协议模块入口用（如 getLogger("https")）
export function getLogger(prefix: string): LoggerImpl {
  return logger.child(prefix);
}

// 保留历史值导出：new Logger(...) / Logger.prototype 继续可用；类型位置使用上方最小 Logger 接口。
export const Logger: typeof LoggerImpl = LoggerImpl;

export default logger;
