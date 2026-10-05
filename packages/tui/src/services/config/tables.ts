/**
 * @fileoverview 五张表的 DDL 与逐行读写；⚠️ schema 版本**只有** `PRAGMA user_version` 一处，`meta` 存的是台账状态（`selected` / `provider.baseUrl` / `provider.model` / `provider.apiKey`）而不是版本
 */

import type { SidebarEntry, SessionRecord } from "@/store/index.js";
import type { LogEntry } from "@/lib/log/index.js";
import type { LedgerDb } from "./db.js";
import type { Target } from "./types.js";

/** 本包写出来的 schema 版本（0 = 还没建过表；⚠️ 本仓零兼容，版本对不上就是「这份库不是本包写的」） */
// ⚠️ **「这一版库里有哪几样事实」就是本文件的 DDL 与那几张列清单**，而这个数是那份事实唯一的对外声明
// 而形状怎么落到这一版不归这里：`db.ts:ensureSchema` 的升级步按**形状**判，不按版本号
export const SCHEMA_VERSION = 4;

/** `targets` 表的列（⚠️ 就是 {@link Target} 的字段，`baseUrl` / `timeoutMs` 按 SQL 惯例写成 snake_case） */
export const TARGET_COLUMNS = ["id", "name", "base_url", "token", "timeout_ms"] as const;

/** `sessions` 表的列：会话**自己**不带「在不在侧边栏上」那一位 */
export const SESSION_COLUMNS = ["id", "name", "created_at", "updated_at"] as const;

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

/** v2 → v3 的那一步：**空 SQL** —— provider 的三样东西落在**早就存在**的 `meta` 键值表里 */
// ⚠️ 版本仍然要升：`user_version` 是「这一版库里有哪几样事实」的**唯一**记录处，
// 而不升的话 v2 库走一次空 SQL 就**再也升不上来了**（补不出东西，而版本号不会自己动）
export const ADD_PROVIDER_META = "";

/** v3 → v4 的那一步：去掉 `sessions.visible`（判据是「这一列还在吗」而不是版本号，理由见 `db.ts:ensureSchema`） */
export const DROP_SESSION_VISIBLE = "ALTER TABLE sessions DROP COLUMN visible";

/** `meta` 的列（⚠️ 它与下面四张表同列进 `db.ts` 的验列清单） */
export const META_COLUMNS = ["key", "value"] as const;

/** `sidebar_sessions` 表的列（⚠️ **没有外键**：级联删由应用层在一个事务里显式做，见 `store.ts:removeSession`） */
export const SIDEBAR_COLUMNS = ["session_id", "at"] as const;

/** `messages` 表的列（一格 `LogEntry` 一行，`turns` 是那一格序列化后的 JSON） */
export const MESSAGE_COLUMNS = ["session_id", "seq", "at", "turns"] as const;

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