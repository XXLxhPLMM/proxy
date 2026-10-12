/**
 * @fileoverview 本地库的开库层：选档（内置 / 降级）并把驱动组装成 drizzle 实例
 * @description
 * 两档驱动住在 `./driver/{builtin,wasm}.ts`：内置 `node:sqlite` 优先（判据是「能不能
 * require 到」而非版本号比较），拿不到退 `node-sqlite3-wasm`。
 *
 * ## 为什么不直接用 `drizzle-orm/node-sqlite` 的 `drizzle()`
 *
 * 它的 `driver.js` 顶层静态 `import ... from "node:sqlite"`：旧 Node 一加载就炸，连
 * 「换降级档」的机会都没有。所以这里照它 `driver.js` 的 `construct` 自己组装
 * （`NodeSQLiteSession` / `SQLiteAsyncDatabase` / `SQLiteDialect` 都从 drizzle 官方子路径
 * 导出）：两档共用同一个 Db 类，旧 Node 的模块图里零 `node:sqlite`。
 * ⚠️ 这段组装贴着 drizzle `1.0.0-rc.4` 的内部形状（本包对该依赖精确锁版），升 drizzle
 * 时回来对一眼。
 *
 * 迁移不在这里：运行期**不应用** `drizzle/sqlite/<方言>/migration.sql`（`drizzle.config.ts` 只负责生成），
 * 老库的加列由 `./upgrade.ts` 从 `schemas/` 现推 `ALTER TABLE` 解决。
 */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { NodeSQLiteSession, type NodeSQLiteRunResult } from "drizzle-orm/node-sqlite/session";
import type { EmptyRelations } from "drizzle-orm/relations";
import { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core/async/db";
import { SQLiteDialect } from "drizzle-orm/sqlite-core/dialect";
import { canUseBuiltin, openBuiltinClient } from "./driver/builtin.js";
import type { SqliteClient } from "./driver/types.js";
import { canUseWasm, openWasmClient } from "./driver/wasm.js";

/** 驱动档位：`builtin` = Node 22.13+ 内置，`wasm` = node-sqlite3-wasm 降级 */
export type SqliteDriverKind = "builtin" | "wasm";

/** 两档共用的 Db 类（等于 `NodeSQLiteDatabase`，但不由 driver.js 产出——见文件头） */
export class SqliteDatabase extends SQLiteAsyncDatabase<"sync", NodeSQLiteRunResult, EmptyRelations> {
  /** 由 `construct` 注入（与 drizzle 的 driver 同一约定），`closeSqliteDb` 靠它关连接 */
  declare $client: SqliteClient;
}

/** 两档驱动共用的库句柄（{@link openSqliteDb} 的返回） */
export type SqliteDb = SqliteDatabase;

/** 按 drizzle driver.js 的 `construct` 组装实例：本文件是它唯一能过旧 Node 的替身 */
function construct(client: SqliteClient): SqliteDb {
  const dialect = new SQLiteDialect();
  const relations: EmptyRelations = {};
  const session = new NodeSQLiteSession(client as unknown as DatabaseSync, dialect, relations);
  const db = new SqliteDatabase("sync", dialect, session, relations);
  db.$client = client;
  return db;
}

/** 备好库文件所在目录（0700）与文件本身（0600）；已存在则只收紧权限 */
function prepareContainer(path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) closeSync(openSync(path, "w", 0o600));
  chmodSync(dir, 0o700);
  chmodSync(path, 0o600);
}

/** SQLite 文件头字段：字节 0-15 是 magic「SQLite format 3\0」；字节 18-19（大端）是
 * 「文件格式写版本 / 读版本」——WAL 模式文件这两格都为 2，删除档（rollback journal）为 1 */
const SQLITE_MAGIC = "SQLite format 3\0";
const HEADER_FIELD_LEN = 16;
const WAL_VERSION_OFFSET = 18;

/** 文件是 WAL 模式（journal_mode = WAL）的 SQLite 库吗？仅当两格都是 2 时判定 */
function isWalModeFile(path: string): boolean {
  try {
    const buf = readFileSync(path);
    return (
      buf.length >= WAL_VERSION_OFFSET + 2 &&
      buf.toString("utf8", 0, HEADER_FIELD_LEN) === SQLITE_MAGIC &&
      buf[WAL_VERSION_OFFSET] === 2 &&
      buf[WAL_VERSION_OFFSET + 1] === 2
    );
  } catch {
    return false;
  }
}

/** 是 node-sqlite3-wasm「打不开数据库文件」的底层错吗？（直抛或包在 .cause 里两种情况都认） */
function isWasmCantOpen(e: unknown): boolean {
  if (e instanceof Error) {
    if (e.message.includes("unable to open database file")) return true;
    if (e.cause instanceof Error && e.cause.message.includes("unable to open database file")) return true;
  }
  return false;
}

/**
 * 把 WAL 模式的不兼容库重命名备份，并给一句迁移说明（WASM 档打不开 WAL 模式文件）
 * @param report - 说明交给调用方去报（`db/` 层不认识 cordis，见文件头）；不传就**丢弃**——⚠️ 这是动过用户
 *   文件的操作，宁可让调用方决定去哪儿显示，也不自己 `console`（eslint `no-console` 挡着）
 */
function recoverWalModeFile(path: string, report?: (message: string) => void): string {
  let counter = 1;
  let dest = `${path}.wal-journal-incompatible-bak`;
  while (existsSync(dest)) {
    dest = `${path}.wal-journal-incompatible-bak.${counter}`;
    counter++;
  }
  renameSync(path, dest);
  report?.(
    `本地库 ${path} 是 WAL 日志模式（journal_mode = WAL），由 Node 22.13+ 内置档创建。` +
      `当前运行环境的 WASM 降级档无法打开 WAL 模式文件，已把旧库备份到 ${dest} 并以兼容模式重建。` +
      "本工具单写者单线程不需要 WAL，后续所有版本都会创建兼容的删除档（journal_mode = DELETE）。",
  );
  return dest;
}

/**
 * 打开（必要时创建）本地库
 * @param path - 数据库文件路径；父目录不存在会按 0700 建出来
 * @param prefer - 显式指定驱动档（**只给两档对拍/测试**）：不传就按运行时探测。
 *   显式指定而该档不可用会**抛**，不静默换档——换档会让「测的是哪档」变成假绿
 * @param report - 过程中的告知（WAL 回滚那种「动过你的文件」的事）；不传即丢弃。⚠️ `db/` 层不认识 cordis，
 *   **报给谁由调用方决定**（插件那条链传 `ctx.logger.warn`），本层不自己往终端写
 *
 * ⚠️ **WAL 模式回滚**：`node-sqlite3-wasm`（Node < 22.13 的降级档）打不开 WAL 模式的库文件，
 *   一旦第 1 次开库失败、且文件被识别为 WAL 模式（header[18-19] == 2,2），就把旧库备份并
 *   以兼容模式重建（第 2 次尝试重开）；其他失败一律原样抛出。
 */
export function openSqliteDb(path: string, prefer?: SqliteDriverKind, report?: (message: string) => void): SqliteDb {
  const kind = prefer ?? (canUseBuiltin() ? "builtin" : "wasm");
  const usable = kind === "builtin" ? canUseBuiltin() : canUseWasm();
  if (!usable) {
    throw new Error(`SQLite 驱动的 ${kind} 档在当前运行时 (${process.version}) 不可用`);
  }
  for (let attempt = 0; attempt <= 1; attempt++) {
    prepareContainer(path);
    try {
      return construct(kind === "builtin" ? openBuiltinClient(path) : openWasmClient(path));
    } catch (e) {
      if (attempt === 0 && kind === "wasm" && isWasmCantOpen(e) && isWalModeFile(path)) {
        recoverWalModeFile(path, report);
        continue;
      }
      throw e;
    }
  }
  // 理论上走不到这里：第 1 次失败触发恢复后会重试，重试再失败会在上面抛出
  throw new Error("开库重试后仍然失败，请检查日志");
}

export function closeSqliteDb(db: SqliteDb): void {
  db.$client.close();
}
