/**
 * 日志编排 - 门限判定、双通道落地与在途写入跟踪
 *
 * 四个文件的职责切分是硬边界：**本文件只做编排**（门限、控制台通道、JSONL 通道、
 * child 派生、在途写入跟踪），`level.ts` 只取值与算文件名，`text.ts` 只做纯文本
 * 净化/渲染，`events.ts` 只放稳定事件码。新增日志能力按这四类落位。
 *
 * **等级与落盘基址不再有模块级真相源**：`Logger` 构造时必须拿到它所属实例的
 * `ConfigScope`（`LoggerOptions.scope`，必填），两道门限与落盘路径每调用现取。
 * 同进程跑两个实例时，A 实例调 debug 不会把 B 也调成 debug——此前
 * `export const logger = new Logger()` 让全进程共享一份等级与落盘路径，
 * 多实例在这条路上是不可能的。该模块级单例已删除，不留别名。
 *
 * 两种合法构造路径：
 * - **实例级**：`createInstanceLogger(scope, …)` —— 库/组合根为每个实例各建一个。
 * - **进程级单点**：`setProcessScope(scope)` + `getLogger(prefix)` —— 只服务
 *   「天然属于进程而非某个实例」的日志（CLI 启动摘要、cluster master、协议层
 *   派生前缀）。它是一个**显式登记**的 scope，不是隐式默认 scope：未登记就调用
 *   `getLogger()` 直接抛错，因为静默回退到一份默认配置会让多实例的启动期日志
 *   全部串到同一份 LOG_LEVEL/LOG_FILE 上。
 */

import fs from "node:fs";
import path from "node:path";
import { COLOR, currentFileLevel, currentLevel, enabledAt, logFile, toHourlyFile } from "./level.js";
import { renderFieldValue, renderValue, sanitizeLogText, splitFields } from "./text.js";
import type { LogLevel } from "./level.js";
import type { ConfigScope } from "@/config/scope.js";

export type { LogLevel } from "./level.js";

export interface LoggerOptions {
  /**
   * 必填：本 Logger 所属实例的配置作用域。
   *
   * 门限（`logLevel`/`logFileLevel`）与落盘基址（`logFile`）全部现取自它，
   * 不允许构造后再改归属——Logger 一旦造出来就只属于那个实例。
   */
  scope: ConfigScope;
  /** 日志前缀，默认 [proxy]；child 会拼接为父:子 */
  prefix?: string;
  /** 强制控制台等级，覆盖 scope 的三级回退（子模块定级用） */
  level?: LogLevel;
  /** 强制落盘等级，覆盖 scope 的三级回退（子模块定级用） */
  fileLevel?: LogLevel;
  /** 是否着色，默认按 stdout.isTTY 探测（文件/管道下自动关闭） */
  color?: boolean;
}

export class Logger {
  private readonly scope: ConfigScope;
  private readonly prefix: string;
  private readonly forcedLevel?: LogLevel;
  private readonly forcedFileLevel?: LogLevel;
  private readonly color: boolean;
  /**
   * 本实例的在途落盘集合。根 Logger 构造时新建，**child 与父共享同一份**
   * （否则父 `flush()` 等不到子日志器的审计行，显式退出路径会在 `process.exit`
   * 处截断 `[auth]`/`[route]` 这类行）；但**跨实例绝不共享**——实例 A 的
   * `flush()` 不再等待实例 B 的写入。
   */
  private inflight: Set<Promise<void>>;

  constructor(opts: LoggerOptions) {
    // 默认值来源：prefix 取 [proxy] 保可读性，color 按 isTTY 探测防重定向乱码
    this.scope = opts.scope;
    this.prefix = opts.prefix ?? "[proxy]";
    this.forcedLevel = opts.level;
    this.forcedFileLevel = opts.fileLevel;
    this.color = opts.color ?? !!process.stdout.isTTY;
    this.inflight = new Set();
  }

  private level(): LogLevel {
    return this.forcedLevel ?? currentLevel(this.scope);
  }

  private fileLevel(): LogLevel {
    return this.forcedFileLevel ?? currentFileLevel(this.scope);
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
      // 落盘基址只从本实例 scope 取（可被 LOG_FILE 兜底）：没有「覆盖基址」选项，
      // 覆盖它等于让一个日志器越出自己实例的文件，隔离就漏了。
      const raw = logFile(this.scope);
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
      this.inflight.add(write);
      void write.then(() => {
        this.inflight.delete(write);
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

  // 无条件输出专供 banner：不受等级门控，logger.raw 不落盘色码安全
  raw(...a: unknown[]): void {
    console.log(...a);
  }

  // 等齐本实例（含其全部 child）的在途落盘后返回；条目均已吞错，本方法不会 reject
  // process.exit 会截断在途 appendFile：显式退出路径须先 await，正常事件循环退出无需调用
  async flush(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  // 派生子日志器：**继承 scope**（子日志器与父属同一实例）、继承双通道等级/color
  // 并拼接 prefix（父:子形态）；在途集合也随父走（见 inflight 注释）
  child(prefix: string): Logger {
    const child = new Logger({
      scope: this.scope,
      prefix: `${this.prefix}:${prefix}`,
      level: this.forcedLevel,
      fileLevel: this.forcedFileLevel,
      color: this.color,
    });
    child.inflight = this.inflight;
    return child;
  }
  // 刻意不提供 setLevel/setFileLevel/setFile：等级与落盘基址的真相源是所属
  // 实例 scope 的 LOG_LEVEL / LOG_FILE_LEVEL / LOG_FILE，运行时覆写这条能力线
  // 零调用方（child() 只把本实例的 forcedLevel/forcedFileLevel 原样透传，
  // 不构成外部写入者）。要改等级走配置层，别在 Logger 上开后门。
}

/**
 * 实例工厂：返回一个**属于该 scope** 的 Logger。
 *
 * 库调用方与多实例组合根的唯一推荐入口：每个实例各建一个，等级与落盘路径随实例
 * 走，实例之间互不影响。
 *
 * @param scope - 本 Logger 归属的实例配置作用域
 * @param options - `prefix` 缺省为 `[proxy]`（与 Logger 构造一致）；`color` 缺省按 isTTY 探测
 */
export function createInstanceLogger(
  scope: ConfigScope,
  options?: { prefix?: string; color?: boolean },
): Logger {
  return new Logger({ scope, prefix: options?.prefix, color: options?.color });
}

/** 进程级 scope 槽位：只由启动入口经 `setProcessScope` 写入（`undefined` = 未登记）。 */
let processScope: ConfigScope | undefined;
/** 进程级门面：惰性构造（构造需要 scope），`getLogger` 的 child 都挂在它下面。 */
let processLogger: Logger | undefined;

/**
 * 登记进程级 scope，供「天然属于进程而非某个实例」的日志使用。
 *
 * 启动入口（CLI）在配置初始化拿到 scope 之后调用一次。**每个进程只允许设置一次**
 * ——重复设置意味着有两份「进程级」配置，日志会随机落在其中一份上，是装配 bug。
 *
 * @throws 已登记过（重复设置）
 */
export function setProcessScope(scope: ConfigScope): void {
  if (processScope !== undefined) {
    throw new Error("进程级日志作用域重复设置: setProcessScope 每个进程只允许调用一次");
  }
  processScope = scope;
}

/**
 * 取进程级门面（首次调用时惰性构造）。
 *
 * @throws 尚未 `setProcessScope`：这里**刻意不**回退到隐式默认 scope，
 *         否则多实例的启动期日志会全部串到一份共享的 LOG_LEVEL/LOG_FILE 上。
 */
function requireProcessLogger(): Logger {
  if (processLogger === undefined) {
    if (processScope === undefined) {
      throw new Error(
        "进程级日志未初始化: 请在启动入口先调用 setProcessScope(scope) 再使用 getLogger(prefix)",
      );
    }
    processLogger = new Logger({ scope: processScope });
  }
  return processLogger;
}

/**
 * 进程级快捷派生：等价 `requireProcessLogger().child(prefix)`，协议/进程层入口用
 * （如 `getLogger("https")`）。
 *
 * 首次调用时才解析进程级门面——**不要在模块加载期调用**（那时通常还没有进程级
 * scope）；需要与实例绑定的日志走 `createInstanceLogger(scope)`。
 *
 * @throws 未 `setProcessScope`（见 `requireProcessLogger`）
 */
export function getLogger(prefix: string): Logger {
  return requireProcessLogger().child(prefix);
}
