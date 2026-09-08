import fs from "node:fs";
import path from "node:path";
import { get } from "@/config/store.js";
import type { LogLevel } from "@/config/store.js";

export type { LogLevel } from "@/config/store.js";

const ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};
const COLOR: Record<Exclude<LogLevel, "silent">, string> = {
  debug: "\x1b[36m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

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

function logFile(): string | undefined {
  return get("logFile") ?? process.env.LOG_FILE ?? undefined;
}

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
  prefix?: string;
  level?: LogLevel;
  color?: boolean;
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
    this.color = opts.color ?? !!process.stdout.isTTY;
    this.file = opts.file;
  }

  private level(): LogLevel {
    return this.forcedLevel ?? currentLevel();
  }

  private enabled(target: LogLevel): boolean {
    return ORDER[target] >= ORDER[this.level()];
  }

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

  infoSync(...a: unknown[]): void {
    if (this.enabled("info")) {
      process.stdout.write(this.fmt("info", a).join(" ") + "\n");
    }
  }

  raw(...a: unknown[]): void {
    console.log(...a);
  }

  async flush(): Promise<void> {
    // no-op, kept for interface compatibility
  }

  child(prefix: string): Logger {
    return new Logger({
      prefix: `${this.prefix}:${prefix}`,
      level: this.forcedLevel,
      color: this.color,
      file: this.file,
    });
  }

  setLevel(l: LogLevel): void {
    this.forcedLevel = l;
  }

  setFile(f: string | undefined): void {
    this.file = f;
  }
}

export const logger = new Logger();

export function getLogger(prefix: string): Logger {
  return logger.child(prefix);
}

export default logger;
