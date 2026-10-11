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
 * 迁移不在这里：运行期怎么应用 `drizzle/sqlite/<方言>/migration.sql` 还没定
 * （`drizzle.config.ts` 只负责生成）。
 */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
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
class SqliteDatabase extends SQLiteAsyncDatabase<"sync", NodeSQLiteRunResult, EmptyRelations> {
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

/**
 * 打开（必要时创建）本地库
 * @param path - 数据库文件路径；父目录不存在会按 0700 建出来
 * @param prefer - 显式指定驱动档（**只给两档对拍/测试**）：不传就按运行时探测。
 *   显式指定而该档不可用会**抛**，不静默换档——换档会让「测的是哪档」变成假绿
 */
export function openSqliteDb(path: string, prefer?: SqliteDriverKind): SqliteDb {
  prepareContainer(path);
  const kind = prefer ?? (canUseBuiltin() ? "builtin" : "wasm");
  const usable = kind === "builtin" ? canUseBuiltin() : canUseWasm();
  if (!usable) {
    throw new Error(`SQLite 驱动的 ${kind} 档在当前运行时 (${process.version}) 不可用`);
  }
  return construct(kind === "builtin" ? openBuiltinClient(path) : openWasmClient(path));
}

export function closeSqliteDb(db: SqliteDb): void {
  db.$client.close();
}
