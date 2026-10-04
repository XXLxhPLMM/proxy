/**
 * @fileoverview 三张表的 DDL 与逐行读写；⚠️ schema 版本**只有** `PRAGMA user_version` 一处，`meta` 存的是台账状态（`selected`）而不是版本
 */

import type { SessionRecord } from "@/store/index.js";
import type { LedgerDb } from "./db.js";
import type { Target } from "./types.js";

/** 本包写出来的 schema 版本（0 = 还没建过表；⚠️ 本仓零兼容，版本对不上就是「这份库不是本包写的」） */
// ⚠️ **v3 加的是 `meta` 里的三个键，而 DDL 一个字节都没改** —— 故这一版的 `ADD_*` 是**空转**
// （见 {@link ADD_PROVIDER_META}）。仍要升版本：`user_version` 是「这一版库里有哪几样事实」的**唯一**记录处
// 而不升的话 v2 库走一次「补列」就再也升不上来了（补不出东西，而版本号不会自己动）
export const SCHEMA_VERSION = 3;

/** `targets` 表的列（⚠️ 就是 {@link Target} 的字段，`baseUrl` / `timeoutMs` 按 SQL 惯例写成 snake_case） */
export const TARGET_COLUMNS = ["id", "name", "base_url", "token", "timeout_ms"] as const;

/** `sessions` 表的列（⚠️ `visible` 是 v2 补上去的那一列：整型因为 SQLite 没有布尔） */
export const SESSION_COLUMNS = ["id", "name", "created_at", "updated_at", "visible"] as const;

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
  updated_at INTEGER NOT NULL,
  visible    INTEGER NOT NULL DEFAULT 1
);
`;

/** v1 → v2 的那一步：给 `sessions` 补 `visible` 一列（判据是「这一列在不在」而不是版本号） */
// ⚠️ `IF NOT EXISTS` 对已存在的表一个字节都不写，于是 v1 的库建完表仍然只有四列
// ⚠️ 按「列在不在」判则幂等，且不依赖那份 `user_version` 的可信度
export const ADD_SESSION_VISIBLE = "ALTER TABLE sessions ADD COLUMN visible INTEGER NOT NULL DEFAULT 1";

/**
 * v2 → v3 的那一步：**空 SQL**
 * @description provider 的三样东西落在**早就存在**的 `meta` 键值表里 ⇒ **没有任何 DDL 要改**
 */
export const ADD_PROVIDER_META = "";

/** `meta` 的列（⚠️ 它与 {@link TARGET_COLUMNS} / {@link SESSION_COLUMNS} 同列进 `db.ts` 的验列清单） */
export const META_COLUMNS = ["key", "value"] as const;

/** `meta` 里放 `selected` 的那一个键（⚠️ **行不存在 = 一个都没选**，故不需要给 `null` 造哨兵值） */
const META_SELECTED = "selected";

/** provider 那三样东西在 `meta` 里的键（⚠️ **带前缀**，而 `meta` 是全局的键值表：不带前缀迟早与别的键撞） */
const META_PROVIDER_BASE = "provider.baseUrl";
const META_PROVIDER_MODEL = "provider.model";
const META_PROVIDER_KEY = "provider.apiKey";

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
      "SELECT id, name, created_at, updated_at, visible FROM sessions ORDER BY rowid",
    )
    .map((row) => ({
      id: String(row["id"]),
      name: String(row["name"]),
      createdAt: Number(row["created_at"]),
      updatedAt: Number(row["updated_at"]),
      // ⚠️ **只有 0 与 1 是约定**：别把它读成「非零即真」之外的语义（那是别人的库）
      visible: Number(row["visible"]) !== 0,
    }));
}

/** 新增一个会话（⚠️ 撞 `id` 时这条 `INSERT` 撞主键约束并抛出去：**新增与改名是两个入口**，合成一个 UPSERT 就分不清「重复的那个」是哪一个） */
export function insertSessionRow(db: LedgerDb, record: SessionRecord): void {
  db.run(
    "INSERT INTO sessions(id, name, created_at, updated_at, visible) VALUES(?, ?, ?, ?, ?)",
    [record.id, record.name, record.createdAt, record.updatedAt, record.visible ? 1 : 0],
  );
}

/** 改名（⚠️ **不带 `created_at`**：它是「这个会话有多老」的唯一定义，改名不该把它挪到今天） */
export function renameSessionRow(db: LedgerDb, id: string, name: string, at: number): void {
  db.run("UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?", [name, at, id]);
}

/** 显隐（⚠️ **不带 `updated_at`**：「藏起来」不是「又动了一次」，而 `updated_at` 答的是「最后一次新增或改名」） */
export function setVisibleSessionRow(db: LedgerDb, id: string, visible: boolean): void {
  db.run("UPDATE sessions SET visible = ? WHERE id = ?", [visible ? 1 : 0, id]);
}

/** 删一个会话（删一个不存在的 `id` 是一次成功的 no-op，与台账删除面同一条纪律） */
export function deleteSessionRow(db: LedgerDb, id: string): void {
  db.run("DELETE FROM sessions WHERE id = ?", [id]);
}

/** 落盘的模型 provider（⚠️ 三列恒是**字符串或 `null`**；`apiKey` 与 `targets.token` 同级） */
export interface ProviderRow {
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly apiKey: string | null;
}

function readMeta(db: LedgerDb, key: string): string | null {
  const row = db.get<Record<string, unknown>>("SELECT value FROM meta WHERE key = ?", [key]);
  return row === undefined ? null : String(row["value"]);
}

/** provider 那三行（⚠️ **三行各自独立**：改地址不该顺手改掉凭据，而 `UPSERT` 逐行做正是为此） */
export function readProviderRow(db: LedgerDb): ProviderRow {
  return {
    baseUrl: readMeta(db, META_PROVIDER_BASE),
    model: readMeta(db, META_PROVIDER_MODEL),
    apiKey: readMeta(db, META_PROVIDER_KEY),
  };
}

/** 写一个 provider 字段（`null` = 删掉那一行 —— 「没配」与「配了个空串」在本层是同一件事） */
export function writeProviderField(db: LedgerDb, field: "baseUrl" | "model" | "apiKey", value: string | null): void {
  const key =
    field === "baseUrl" ? META_PROVIDER_BASE : field === "model" ? META_PROVIDER_MODEL : META_PROVIDER_KEY;
  if (value === null) {
    db.run("DELETE FROM meta WHERE key = ?", [key]);
    return;
  }
  db.run(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}