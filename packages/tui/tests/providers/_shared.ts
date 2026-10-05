/**
 * 本目录各档共用的量具：临时库工厂 + 一个**不认识本包**的原始句柄 + 临时目录的清理
 *
 * ⚠️ 与 `tests/sqlite/_shared.ts` **刻意各存一份**：那个夹具是「那个库的性质」那一簇的量具，
 * 而本目录验的是 provider 清单与模型清单的成败语义 —— 两簇各自的 `afterEach` 各收各的临时目录。
 *
 * ⚠️ `rawHandle` 用 `createRequire(import.meta.url)("node:sqlite")` **在调用点现取**：列清单与落盘字节
 * 必须从**外面**量，而本包自己的接口（`readProviders` / `readProviderModels`）正是被测的那一份。
 *
 * @module tests/providers
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 本目录开过库的临时目录（`removeCreated()` 逐档 drain 它） */
export const created: string[] = [];

export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swain-tui-providers-"));
  created.push(dir);
  return dir;
}

/** 临时目录里的库文件路径（父目录还不存在） */
export function tempDb(): string {
  return path.join(tempDir(), "nested", "tui.db");
}

export interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(): unknown[];
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

/** 一个**不认识本包**的原始句柄：用本包自己的接口去量就是自证 */
function rawHandle(file: string): RawDb {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (file: string) => RawDb;
  };
  return new DatabaseSync(file);
}

export function withRaw<T>(file: string, work: (db: RawDb) => T): T {
  const db = rawHandle(file);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

/** 从**外面**把一张表整张倒出来（WAL 下数据可能整段还在 `-wal` 里，故不用逐字节） */
export function rawRows(file: string, table: string): readonly Record<string, unknown>[] {
  return withRaw(file, (db) =>
    (db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]).map((row) => ({
      ...row,
    })),
  );
}

/** 一张表现有的列名（⚠️ 同样从**外面**量） */
export function rawColumns(file: string, table: string): readonly string[] {
  return withRaw(file, (db) =>
    (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );
}

/** 库里那几张表的名字（`sqlite_master`，⚠️ 不含 `sqlite_*` 内部表） */
export function rawTables(file: string): readonly string[] {
  return withRaw(file, (db) =>
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name),
  );
}

/** `PRAGMA user_version`（⚠️ **从外面**量，不读实现里那个常量） */
export function rawUserVersion(file: string): unknown {
  return withRaw(file, (db) => {
    const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    const keys = Object.keys(row);
    return keys.length === 1 ? row[keys[0]!] : row;
  });
}

/** 删掉本目录开过的那些临时目录（⚠️ 必须**在**收掉库句柄之后调：句柄开着时 Windows 上删不掉） */
export function removeCreated(): void {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}