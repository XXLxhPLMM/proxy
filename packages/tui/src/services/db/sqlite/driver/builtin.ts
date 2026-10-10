/**
 * @fileoverview 内置档驱动：Node 22.13+ 的 `node:sqlite`
 * @description
 * ⚠️ **require 必须惰性**：`import ... from "node:sqlite"` 是静态 import，打包产物里会留在
 * 顶层，旧 Node（16/18/20 上模块不存在，22.5–22.12 上要 `--experimental-sqlite`）一加载就炸，
 * 连换降级档的机会都没有。故走 `createRequire` 在调用点现取，取不到退化成可 catch 的异常。
 *
 * ⚠️ **close 要幂等**：`DatabaseSync#close()` 第二次调用抛 `ERR_INVALID_STATE`，而停机路径
 * 上可能关两次；两档 close 必须同行为，故这里自己记「关过没有」。
 */

import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { SqliteClient, SqliteStatement } from "./types.js";

/** 内置档的模块形状（结构声明，绝不静态 import 那个模块） */
function loadBuiltin(): { DatabaseSync: new (path: string) => DatabaseSync } {
  return createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => DatabaseSync;
  };
}

/** 当前运行时能不能拿到内置档（require 探一次，不缓存） */
export function canUseBuiltin(): boolean {
  try {
    loadBuiltin();
    return true;
  } catch {
    return false;
  }
}

/** 开内置档客户端（WAL + 外键；close 幂等——理由见文件头） */
export function openBuiltinClient(path: string): SqliteClient {
  const { DatabaseSync } = loadBuiltin();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  let closed = false;
  return {
    prepare: (sql) => db.prepare(sql) as unknown as SqliteStatement,
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
