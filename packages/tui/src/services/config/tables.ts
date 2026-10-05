/**
 * @fileoverview 七张表的 DDL 与逐行读写；⚠️ schema 版本**只有** `PRAGMA user_version` 一处，`meta` 存的是台账状态（`selected`）而不是版本
 */

import type { SidebarEntry, SessionRecord } from "@/store/index.js";
import type { LogEntry } from "@/lib/log/index.js";
import type { LedgerDb } from "./db.js";
import {
  DEFAULT_REASONING_EFFORT,
  type ModelRecord,
  type ProviderRecord,
  type Target,
} from "./types.js";

/** 本包写出来的 schema 版本（0 = 还没建过表；⚠️ 本仓零兼容，版本对不上就是「这份库不是本包写的」） */
// ⚠️ **「这一版库里有哪几样事实」就是本文件的 DDL 与那几张列清单**，而这个数是那份事实唯一的对外声明
// 而形状怎么落到这一版不归这里：`db.ts:ensureSchema` 的升级步按**形状**判，不按版本号
export const SCHEMA_VERSION = 5;

/** `targets` 表的列（⚠️ 就是 {@link Target} 的字段，`baseUrl` / `timeoutMs` 按 SQL 惯例写成 snake_case） */
export const TARGET_COLUMNS = ["id", "name", "base_url", "token", "timeout_ms"] as const;

/** `providers` 表的列（就是 {@link ProviderRecord} 的字段，snake_case） */
export const PROVIDER_COLUMNS = ["id", "name", "base_url", "api", "api_key"] as const;

/** `provider_models` 表的列（复合主键 `(provider_id, model_id)`，⚠️ `model_id` **可含 `/`**） */
export const PROVIDER_MODEL_COLUMNS = ["provider_id", "model_id", "label", "pinned"] as const;

/** `sessions` 表的列：会话**自己**不带「在不在侧边栏上」那一位，也不带输出桶 */
export const SESSION_COLUMNS = [
  "id",
  "name",
  "created_at",
  "updated_at",
  "model_ref",
  "reasoning",
] as const;

/** 建表语句（⚠️ 全部 `IF NOT EXISTS`：打开一个已存在的库必须是零写入） */
// ⚠️ `reasoning` 的缺省**从常量取**：DDL 与读写两面各写一遍 `"medium"` 就是三份会各自漂的真相源
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
CREATE TABLE IF NOT EXISTS providers (
  id       TEXT NOT NULL PRIMARY KEY,
  name     TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api      TEXT NOT NULL,
  api_key  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_models (
  provider_id TEXT    NOT NULL,
  model_id    TEXT    NOT NULL,
  label       TEXT    NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, model_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    NOT NULL PRIMARY KEY,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  model_ref  TEXT,
  reasoning  TEXT    NOT NULL DEFAULT '${DEFAULT_REASONING_EFFORT}'
);
CREATE TABLE IF NOT EXISTS sidebar_sessions (
  session_id TEXT    NOT NULL PRIMARY KEY,
  at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  turns      TEXT    NOT NULL,
  PRIMARY KEY (session_id, seq)
);
`;

/** v3 → v4 的那一步：去掉 `sessions.visible`（判据是「这一列还在吗」而不是版本号，理由见 `db.ts:ensureSchema`） */
export const DROP_SESSION_VISIBLE = "ALTER TABLE sessions DROP COLUMN visible";

/** v4 → v5 的那一步之一：给 `sessions` 补 `model_ref`（判据同样是「这一列还在吗」，可空 = 没选） */
export const ADD_SESSION_MODEL_REF = "ALTER TABLE sessions ADD COLUMN model_ref TEXT";

/** v4 → v5 的那一步之二：给 `sessions` 补 `reasoning`（⚠️ 缺省与非空成对，否则老库的行插不进新值） */
export const ADD_SESSION_REASONING =
  `ALTER TABLE sessions ADD COLUMN reasoning TEXT NOT NULL DEFAULT '${DEFAULT_REASONING_EFFORT}'`;

/** `meta` 的列（⚠️ 它与下面几张表同列进 `db.ts` 的验列清单） */
export const META_COLUMNS = ["key", "value"] as const;

/** `sidebar_sessions` 表的列（⚠️ **没有外键**：级联删由应用层在一个事务里显式做，见 `./provider.ts:removeProvider`） */
export const SIDEBAR_COLUMNS = ["session_id", "at"] as const;

/** `messages` 表的列（一格 `LogEntry` 一行，`turns` 是那一格序列化后的 JSON） */
export const MESSAGE_COLUMNS = ["session_id", "seq", "at", "turns"] as const;

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

/** 落盘的提供商清单（⚠️ 顺序恒等于 `rowid` = 插入序；`apiKey` 与 `targets.token` 同级） */
export function readProviderRows(db: LedgerDb): readonly Record<string, unknown>[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT ${PROVIDER_COLUMNS.join(", ")} FROM providers ORDER BY rowid`,
    )
    .map((row) => ({
      id: row["id"],
      name: row["name"],
      baseUrl: row["base_url"],
      api: row["api"],
      apiKey: row["api_key"],
    }));
}

/** 整份提供商清单换掉（⚠️ **先全删再按数组序插回去**：那是唯一让「清单顺序 = 数组序」成立的办法） */
export function writeProviderRows(db: LedgerDb, providers: readonly ProviderRecord[]): void {
  db.run("DELETE FROM providers");
  for (const one of providers) {
    db.run("INSERT INTO providers(id, name, base_url, api, api_key) VALUES(?, ?, ?, ?, ?)", [
      one.id,
      one.name,
      one.baseUrl,
      one.api,
      one.apiKey,
    ]);
  }
}

/** 改一个已存在的提供商（新增与编辑**同一个入口**：那条形差别在 `id` 上，而 `providers` 表的行由它定） */
export function upsertProviderRow(db: LedgerDb, record: ProviderRecord): void {
  db.run(
    "INSERT INTO providers(id, name, base_url, api, api_key) VALUES(?, ?, ?, ?, ?)" +
      " ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url," +
      " api = excluded.api, api_key = excluded.api_key",
    [record.id, record.name, record.baseUrl, record.api, record.apiKey],
  );
}

/** 删 `providers` 那一行（⚠️ **只**删这一行：级联的那张表由 `./provider.ts` 在**同一个事务**里点名删） */
export function deleteProviderRow(db: LedgerDb, id: string): void {
  db.run("DELETE FROM providers WHERE id = ?", [id]);
}

/** 某个提供商的模型清单（⚠️ 顺序恒等于 `rowid` = 插入序） */
export function readProviderModelRows(
  db: LedgerDb,
  providerId: string,
): readonly Record<string, unknown>[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT ${PROVIDER_MODEL_COLUMNS.join(", ")} FROM provider_models WHERE provider_id = ? ORDER BY rowid`,
      [providerId],
    )
    .map((row) => ({
      providerId: row["provider_id"],
      modelId: row["model_id"],
      label: row["label"],
      // ⚠️ 盘上是 INTEGER 而判据接受 `0/1` 与 `true/false` 两种，于是这里**原样透传**不转布尔
      pinned: row["pinned"],
    }));
}

/** 某个提供商的整份模型清单换掉（⚠️ 先删那一份再按数组序插回去，顺序才等于 `rowid`） */
export function writeProviderModelRows(
  db: LedgerDb,
  providerId: string,
  models: readonly ModelRecord[],
): void {
  deleteProviderModelRows(db, providerId);
  for (const one of models) {
    db.run(
      "INSERT INTO provider_models(provider_id, model_id, label, pinned) VALUES(?, ?, ?, ?)",
      [providerId, one.modelId, one.label, one.pinned ? 1 : 0],
    );
  }
}

/** 删掉某个提供商的全部模型行（级联删的那一半：⚠️ 与 `providers` 那一行必须同时生效） */
export function deleteProviderModelRows(db: LedgerDb, providerId: string): void {
  db.run("DELETE FROM provider_models WHERE provider_id = ?", [providerId]);
}

/** 删一个模型（删一个不在清单上的 `(provider, model)` 是**成功的一次 no-op**） */
export function deleteProviderModelRow(db: LedgerDb, providerId: string, modelId: string): void {
  db.run("DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?", [providerId, modelId]);
}

/** 落盘的会话清单（⚠️ 按 `rowid` = 插入序读回**全部**，而「侧边栏上有哪些」是 `sidebar_sessions` 那一问） */
export function readSessionRows(db: LedgerDb): readonly SessionRecord[] {
  return db
    .all<Record<string, unknown>>("SELECT id, name, created_at, updated_at FROM sessions ORDER BY rowid")
    .map((row) => ({
      id: String(row["id"]),
      name: String(row["name"]),
      createdAt: Number(row["created_at"]),
      updatedAt: Number(row["updated_at"]),
    }));
}

/** 新增一个会话（⚠️ 撞 `id` 时这条 `INSERT` 撞主键约束并抛出去：**新增与改名是两个入口**，合成一个 UPSERT 就分不清「重复的那个」是哪一个） */
// ⚠️ 模型那两列**不**在这条 INSERT 里：它们的缺省住在 DDL 的列上（老库升级补出来的那一列同样带）
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

/** 一个会话选的模型与推理强度（⚠️ **单独一查**：那两列不住在会话的身份定义里，故读回来的是另一个形状） */
// ⚠️ 值**原样透传**（不收窄）：收窄是 `./validate.js` 的活，它报错时要点得出那一列的名字
export function readSessionModelRow(db: LedgerDb, id: string): Record<string, unknown> | undefined {
  const row = db.get<Record<string, unknown>>("SELECT model_ref, reasoning FROM sessions WHERE id = ?", [
    id,
  ]);
  return row === undefined ? undefined : { modelRef: row["model_ref"], reasoning: row["reasoning"] };
}

/** 换掉一个会话选的模型与推理强度（⚠️ 改一个不存在的 `id` 是**成功的一次 no-op**，与 `renameSessionRow` 同族） */
export function writeSessionModelRow(
  db: LedgerDb,
  id: string,
  modelRef: string | null,
  reasoning: string,
): void {
  db.run("UPDATE sessions SET model_ref = ?, reasoning = ? WHERE id = ?", [modelRef, reasoning, id]);
}

/** 删 `sessions` 那一行（⚠️ 它**只**删这一行：级联的那三张表由 `store.ts` 在**同一个事务**里逐张点名删） */
export function deleteSessionRow(db: LedgerDb, id: string): void {
  db.run("DELETE FROM sessions WHERE id = ?", [id]);
}

/** 落盘的侧边栏清单（⚠️ 顺序恒等于 `rowid` = **激活**顺序，而不是会话建成的顺序） */
export function readSidebarRows(db: LedgerDb): readonly SidebarEntry[] {
  return db
    .all<Record<string, unknown>>("SELECT session_id, at FROM sidebar_sessions ORDER BY rowid")
    .map((row) => ({ sessionId: String(row["session_id"]), at: Number(row["at"]) }));
}

/** 把一个会话激活进侧边栏（⚠️ **再激活一次是一次 no-op 而不是报错**；⚠️ `WHERE EXISTS` 是**前置条件**：清单不许指向不存在的会话；⚠️ **不碰 `sessions`**） */
export function insertSidebarRow(db: LedgerDb, sessionId: string, at: number): void {
  db.run(
    "INSERT INTO sidebar_sessions(session_id, at) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?) ON CONFLICT(session_id) DO NOTHING",
    [sessionId, at, sessionId],
  );
}

/** 把一个会话从侧边栏摘下来（摘一个不在清单上的 `id` 是一次成功的 no-op） */
export function deleteSidebarRow(db: LedgerDb, sessionId: string): void {
  db.run("DELETE FROM sidebar_sessions WHERE session_id = ?", [sessionId]);
}

/** 一格对话 → 一行（⚠️ `seq` 恒等于 {@link LogEntry.id}，故它与环形缓冲丢不丢历史无关） */
export function insertMessageRow(db: LedgerDb, sessionId: string, entry: LogEntry, turns: string): void {
  db.run("INSERT INTO messages(session_id, seq, at, turns) VALUES(?, ?, ?, ?)", [
    sessionId,
    entry.id,
    entry.at,
    turns,
  ]);
}

/** 一个会话的全部对话（⚠️ 按 `seq` **升序**：落盘的顺序与读回来的顺序必须同一个） */
export function readMessageRows(db: LedgerDb, sessionId: string): readonly Record<string, unknown>[] {
  return db.all<Record<string, unknown>>(
    "SELECT session_id, seq, at, turns FROM messages WHERE session_id = ? ORDER BY seq",
    [sessionId],
  );
}

/** 环形缓冲丢掉最老的那些之后按一个下界收口（`seq < belowSeq` 的行整条删掉，不留半条） */
export function deleteMessagesBelow(db: LedgerDb, sessionId: string, belowSeq: number): void {
  db.run("DELETE FROM messages WHERE session_id = ? AND seq < ?", [sessionId, belowSeq]);
}

/** 清掉一个会话的全部对话（结果区被清空，盘上那一份也该空） */
export function deleteAllMessages(db: LedgerDb, sessionId: string): void {
  db.run("DELETE FROM messages WHERE session_id = ?", [sessionId]);
}