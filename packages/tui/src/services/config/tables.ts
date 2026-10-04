/**
 * @fileoverview 三张表的 DDL 与逐行读写；⚠️ schema 版本**只有** `PRAGMA user_version` 一处，`meta` 存的是台账状态（`selected`）而不是版本
 */

import type { SessionRecord } from "@/store/index.js";
import type { LedgerDb } from "./db.js";
import type { Target } from "./types.js";

/** 本包写出来的 schema 版本（0 = 还没建过表；⚠️ 本仓零兼容，版本对不上就是「这份库不是本包写的」） */
export const SCHEMA_VERSION = 1;

/** `targets` 表的列（⚠️ 就是 {@link Target} 的字段，`baseUrl` / `timeoutMs` 按 SQL 惯例写成 snake_case） */
export const TARGET_COLUMNS = ["id", "name", "base_url", "token", "timeout_ms"] as const;

/** 建表语句（⚠️ 全部 `IF NOT EXISTS`：打开一个已存在的库必须是零写入） */
export const DDL = `
CREATE TABLE IF NOT EXISTS targets (
  id         TEXT    NOT NULL PRIMARY KEY,
  name       TEXT    NOT NULL,
  base_url   TEXT    NOT NULL,
  token      TEXT    NOT NULL,
  timeout_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    NOT NULL PRIMARY KEY,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** `meta` 里放 `selected` 的那一个键（⚠️ **行不存在 = 一个都没选**，故不需要给 `null` 造哨兵值） */
const META_SELECTED = "selected";

/** 一行的字段名换成台账上的名字，⚠️ **值一律原样透传**（不收窄）：收窄是 `./validate.js` 的活，它报错时要点得出台账上的字段名 */
function asTargetShape(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row["id"],
    name: row["name"],
    baseUrl: row["base_url"],
    token: row["token"],
    timeoutMs: row["timeout_ms"],
  };
}

/** 磁盘上的端点清单（⚠️ 顺序恒等于 `rowid` = 插入序，故 `Target[]` 的顺序是保得住的） */
export function readTargets(db: LedgerDb): readonly Record<string, unknown>[] {
  return db
    .all<Record<string, unknown>>(`SELECT ${TARGET_COLUMNS.join(", ")} FROM targets ORDER BY rowid`)
    .map((row) => asTargetShape(row));
}

/** 整份清单换掉（⚠️ **先全删再按数组序插回去**，而不是逐行 UPSERT：那是唯一让「清单顺序 = `Target[]` 顺序」成立的办法） */
export function writeTargets(db: LedgerDb, targets: readonly Target[]): void {
  db.run("DELETE FROM targets");
  for (const one of targets) {
    db.run("INSERT INTO targets(id, name, base_url, token, timeout_ms) VALUES(?, ?, ?, ?, ?)", [
      one.id,
      one.name,
      one.baseUrl,
      one.token,
      one.timeoutMs,
    ]);
  }
}

/** 上次选中的端点 `id`（`null` = 一个都没选；⚠️ 值原样透传，理由同 {@link asTargetShape}） */
export function readSelected(db: LedgerDb): unknown {
  const row = db.get<Record<string, unknown>>("SELECT value FROM meta WHERE key = ?", [
    META_SELECTED,
  ]);
  return row?.["value"] ?? null;
}

/** 换掉上次选中的那一个 */
export function writeSelected(db: LedgerDb, id: string | null): void {
  if (id === null) {
    db.run("DELETE FROM meta WHERE key = ?", [META_SELECTED]);
    return;
  }
  db.run(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [META_SELECTED, id],
  );
}

/** 落盘的会话清单（⚠️ **不含输出桶**：那是内存里的环形缓冲，`LOG_KEEP` 条渲染行不该进数据库） */
export function readSessionRows(db: LedgerDb): readonly SessionRecord[] {
  return db
    .all<Record<string, unknown>>(
      "SELECT id, name, created_at, updated_at FROM sessions ORDER BY rowid",
    )
    .map((row) => ({
      id: String(row["id"]),
      name: String(row["name"]),
      createdAt: Number(row["created_at"]),
      updatedAt: Number(row["updated_at"]),
    }));
}

/** 新增一个会话（⚠️ 撞 `id` 时这条 `INSERT` 撞主键约束并抛出去：**新增与改名是两个入口**，合成一个 UPSERT 就分不清「重复的那个」是哪一个） */
export function insertSessionRow(db: LedgerDb, record: SessionRecord): void {
  db.run("INSERT INTO sessions(id, name, created_at, updated_at) VALUES(?, ?, ?, ?)", [
    record.id,
    record.name,
    record.createdAt,
    record.updatedAt,
  ]);
}

/** 改名（⚠️ **不带 `created_at`**：它是「这个会话有多老」的唯一定义，改名不该把它挪到今天） */
export function renameSessionRow(db: LedgerDb, id: string, name: string, at: number): void {
  db.run("UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?", [name, at, id]);
}

/** 删一个会话（删一个不存在的 `id` 是一次成功的 no-op，与台账删除面同一条纪律） */
export function deleteSessionRow(db: LedgerDb, id: string): void {
  db.run("DELETE FROM sessions WHERE id = ?", [id]);
}