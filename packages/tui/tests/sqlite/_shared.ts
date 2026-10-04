/**
 * 本目录各档共用的量具：临时库工厂 + 一个**不认识本包**的原始句柄 + 临时目录的清理
 *
 * ⚠️ 收件门槛是「**两个以上档真用到**」，不是「看起来通用」：`tempDir` / `tempDb` / `withRaw` /
 * `pick` 都被 `driver` 与 `rows` 两档用着，而 `closeLedgerDb()` **刻意不进来** ——
 * 它是那个模块级句柄的开关，而 hook 是**逐档注册**的（理由见本目录 `AGENTS.md`「单例」一节）。
 *
 * ⚠️ `rawHandle` 用 `createRequire(import.meta.url)("node:sqlite")` **在调用点现取**：验pragma 与
 * schema 版本必须从**外面**量，而本包自己的接口（`dbPath` / `readProvider`）正是被测的那一份 ——
 * 用它去量就是自证。这个句柄不认识 `LedgerError`、也不认识那两条 pragma。
 *
 * @module tests/sqlite
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 本档开过库的临时目录（`removeCreated()` 逐档 drain 它） */
export const created: string[] = [];

export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swain-tui-db-"));
  created.push(dir);
  return dir;
}

/** 临时目录里的库文件路径（父目录还不存在） */
export function tempDb(): string {
  return path.join(tempDir(), "nested", "tui.db");
}

/** 一个**不认识本包**的原始句柄：验 pragma 与 schema 版本必须从外面量，用本包自己的接口就是自证 */
function rawHandle(file: string): RawDb {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (file: string) => RawDb;
  };
  return new DatabaseSync(file);
}

export interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown; all(): unknown[] };
  close(): void;
}

export function withRaw<T>(file: string, work: (db: RawDb) => T): T {
  const db = rawHandle(file);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

/** `node:sqlite` 的行是 `[Object: null prototype]`，取键要走 `JSON.parse(JSON.stringify(...))` 那条路以外的方式 */
export function pick(row: unknown): unknown {
  const record = row as Record<string, unknown> | undefined;
  if (record === undefined) return undefined;
  const keys = Object.keys(record);
  return keys.length === 1 ? record[keys[0]!] : record;
}

/** 删掉本档开过的那些临时目录（⚠️ 必须**在**收掉库句柄之后调：句柄开着时 Windows 上删不掉） */
export function removeCreated(): void {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}