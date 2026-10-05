/**
 * @fileoverview 本机库的驱动与**打开时机**：`node:sqlite` builtin + 一个按路径记账的单例句柄；模块 import 期一个字节都不碰磁盘
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { LedgerError } from "./validate.js";
import { DDL, META_COLUMNS, MESSAGE_COLUMNS, SCHEMA_VERSION, SESSION_COLUMNS, SIDEBAR_COLUMNS, TARGET_COLUMNS } from "./tables.js";
import { ADD_PROVIDER_META, DROP_SESSION_VISIBLE } from "./tables.js";

/** 绑进 SQL 的值域（⚠️ 闭合的：绑定是本层**唯一**的「不把值拼进 SQL 文本」保证） */
export type SqlValue = string | number | null;

/** 账本只认这五个方法，不认 `node:sqlite` 的任何形状（表结构归 `./tables.js`） */
export interface LedgerDb {
  run(sql: string, params?: readonly SqlValue[]): void;
  get<T extends object>(sql: string, params?: readonly SqlValue[]): T | undefined;
  all<T extends object>(sql: string, params?: readonly SqlValue[]): readonly T[];
  exec(sql: string): void;
  close(): void;
}

/** `node:sqlite` 里本层要用到的那一个构造器（**结构声明**：不 import 那个模块，于是加载时机由 {@link builtin} 说了算） */
type DatabaseConstructor = new (file: string) => DatabaseSync;

/** 权限位：目录只给属主、库文件只给属主读写（POSIX） */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** 当前打开的那一个（`null` = 还没开过）；⚠️ 按路径记账：换一个路径就是换一份数据，旧句柄必须先收 */
let opened: { readonly file: string; readonly db: LedgerDb } | null = null;

/** 能收紧就收紧，收紧不了不拦人 */
// ⚠️ **失败一律吞掉**：权限位会被 mount 选项、容器卷、别人的目录挡住，而挡住的是「加固」不是「功能」。
function harden(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // 加固失败不拦人：理由见本函数说明
  }
}

function reject(message: string): never {
  throw new LedgerError("unreadable", message);
}

/** 把驱动异常包成 {@link LedgerError} */
// ⚠️ **转述 `message` 是安全的**：SQLite 的失败文案只点表名与列名，从不回显被绑定的值
function rejectDriver(what: string, file: string, err: unknown): never {
  reject(`${what}（${file}）：${err instanceof Error ? err.message : String(err)}`);
}

/** 摊成普通对象（`node:sqlite` 给的是 `[Object: null prototype]`，不摊平的话冻结与比较的语义跟着原型走） */
function plain<T extends object>(row: T | undefined): T | undefined {
  if (row === undefined || row === null) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) out[key] = (row as Record<string, unknown>)[key];
  return out as T;
}

/** `node:sqlite` 的加载器；⚠️ **必须在调用点现取**：静态 import 会在 import 期加载它，那条 `ExperimentalWarning` 就赶在 `@/services/warnings.js` 的过滤器装好之前逃到 stderr 上 */
function builtin(): { DatabaseSync: DatabaseConstructor } {
  return createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: DatabaseConstructor };
}

/** 把 `DatabaseSync` 收成本层那个端口（顺带在这里做 pragma —— 开库的每一个动作都在这一处发生） */
function portOf(db: DatabaseSync): LedgerDb {
  db.exec("PRAGMA journal_mode = WAL");
  // ⚠️ 今天还没有外键，于是这条 pragma 是**空转**；留着它是纪律：将来加表时「外键默认开着」不必再补一次
  db.exec("PRAGMA foreign_keys = ON");
  return {
    run: (sql, params) => {
      db.prepare(sql).run(...(params ?? []));
    },
    get: <T extends object>(sql: string, params?: readonly SqlValue[]): T | undefined =>
      plain(db.prepare(sql).get(...(params ?? [])) as T | undefined),
    all: <T extends object>(sql: string, params?: readonly SqlValue[]): readonly T[] =>
      (db.prepare(sql).all(...(params ?? [])) as T[]).map((row) => plain(row) as T),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

/** 一张表现有的列（⚠️ 表名**只由本文件的字面量给**：`tables.ts` 有五张表，故这里不接受入参） */
function columnsOf(db: LedgerDb, table: "targets" | "meta" | "sessions" | "sidebar_sessions" | "messages") {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name);
}

/** 建 schema、补上缺的列、并把版本推到 {@link SCHEMA_VERSION}；⚠️ `CREATE TABLE IF NOT EXISTS` 之后**还要验列**，否则别人建的同名表会被当成自己的用 */
function ensureSchema(db: LedgerDb): void {
  const version = readUserVersion(db);
  if (version > SCHEMA_VERSION) {
    reject(
      `台账 version 必须是数字 ${SCHEMA_VERSION}，实际是 ${version}（本包没有第二个版本，也没有迁移层）`,
    );
  }
  db.exec(DDL);
  // ⚠️ **升级步都在验列之前跑**：验列答的是「这一版要的那几列在不在」，而升级步答的是「上一版的形状怎么落到这一版」。
  // ⚠️ 判据一律是「**那个形状还在不在**」而不是版本号 —— `IF NOT EXISTS` 对已存在的表一个字节都不写，
  // 于是按版本号判既不幂等、又把正确性押在 `user_version` 的可信度上；按形状判则跑两遍得到同一个库。
  if (version < 3 && ADD_PROVIDER_META !== "") db.exec(ADD_PROVIDER_META);
  // ⚠️ v2 → v3 那一行是**空 SQL**（provider 落在早就有的 `meta` 上，见 `tables.ts:ADD_PROVIDER_META`）：
  // 空串让 `exec` 收到零条语句，库一个字节都不动
  if (columnsOf(db, "sessions").includes("visible")) db.exec(DROP_SESSION_VISIBLE);
  // ⚠️ 只查「少没少」：**多余列放行**（将来加列时旧库不必重建），少一列即拒（那一列就是点名不出来的字段）
  // ⚠️ **`meta` 也在清单里**：**别人建的同名表**会被 `IF NOT EXISTS` 当成自己的用下去，
  // 而 provider 的凭据就落在这张表里 —— 它的列不对时必须**当场拒**，而不是第一次写凭据时才炸
  for (const [table, wanted] of [
    ["targets", TARGET_COLUMNS],
    ["meta", META_COLUMNS],
    ["sessions", SESSION_COLUMNS],
    ["sidebar_sessions", SIDEBAR_COLUMNS],
    ["messages", MESSAGE_COLUMNS],
  ] as const) {
    const columns = columnsOf(db, table);
    if (!wanted.every((column) => columns.includes(column))) {
      reject(
        `台账 ${table} 表的列不对：实际是 ${columns.join("、") || "空表"}（期望 ${wanted.join("、")}）`,
      );
    }
  }
  if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
}

/** schema 版本（`PRAGMA user_version` 是**唯一**那一份，`./tables.js` 的 DDL 里不许再放第二处） */
function readUserVersion(db: LedgerDb): number {
  return db.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
}

/** 造一个句柄（⚠️ **先占位成一个 0600 的空文件再开库**，理由见 {@link connect}） */
function connect(file: string): LedgerDb {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  harden(dir, DIR_MODE);
  // ⚠️ SQLite 建出来的库文件是 0644（umask 决定），而 token 就落在里面；自己先占位成 0600，
  // SQLite 认它是空的新库，于是「明文 token 落进一个宽权限的文件」这个窗口根本不存在。
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "", "utf8");
    harden(file, FILE_MODE);
  }
  let raw: DatabaseSync;
  try {
    const { DatabaseSync: Database } = builtin();
    raw = new Database(file);
  } catch (err) {
    rejectDriver("本机库打不开", file, err);
  }
  let db: LedgerDb;
  try {
    db = portOf(raw);
  } catch (err) {
    raw.close();
    rejectDriver("本机库打不开", file, err);
  }
  try {
    ensureSchema(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** 打开（或复用）一个句柄；⚠️ 同一个路径只开一次，换路径先收旧的 */
export function openLedgerDb(file: string): LedgerDb {
  if (opened !== null && opened.file === file) return opened.db;
  closeLedgerDb();
  const db = connect(file);
  opened = { file, db };
  return db;
}

/** 收掉当前句柄（**幂等**：先清引用，于是第二次调用是空操作，而重复 `close()` 会抛） */
export function closeLedgerDb(): void {
  if (opened === null) return;
  const handle = opened;
  opened = null;
  handle.db.close();
}