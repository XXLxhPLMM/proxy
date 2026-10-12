/**
 * @fileoverview 运行期备库：空库的 `CREATE TABLE IF NOT EXISTS` 镜像 + 结构同步（`./upgrade.ts`）
 * @module db/sqlite/init
 * @description
 * 首次开库（或库里缺表）时把五张表建出来；对已存在的表一个字节不写（幂等）。之后交给结构同步
 * （补列、补索引、删列、重建表）。
 *
 * ⚠️ **DDL 镜像的是「一个空库该有的表」**（= `drizzle/sqlite/` 下基线加全部增量迁移攒出来的终态，那些
 * `migration.sql` 由 drizzle-kit 生成、是迁移真值）：改 schema 必须先 `pnpm exec drizzle-kit generate`。
 * ⚠️ **镜像里只有表，没有索引**：索引归 {@link syncSchema}（从 `schemas/` 现推，空库老库同一条路），
 * 免得索引名在这份镜像里再写一遍。
 *
 * ⚠️ **运行期不应用 `drizzle/sqlite/` 里的 SQL**（`drizzle.config.ts` 只负责生成）：那是「变更是什么」的
 * 留档。真正让老机器自己长好的是 {@link syncSchema}，它从 `schemas/` 现推；只有重命名、改名这类它分不清
 * 的变更才需要人照着留档里的 SQL 手工处理。
 */

import type { Db } from "../dialect.js";
import { syncSchema, type SchemaSyncResult } from "./upgrade/index.js";

/** 建表语句（与迁移终态逐列一致）；⚠️ **只许** `IF NOT EXISTS` 形态：`attachResource` 每次开库都会跑 */
const SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "sessions" (
    "id" text PRIMARY KEY,
    "title" text NOT NULL,
    "model_id" text,
    "status" text,
    "is_active" integer DEFAULT 1 NOT NULL,
    "created_at" integer NOT NULL,
    "updated_at" integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "messages" (
    "session_id" text NOT NULL,
    "seq" integer NOT NULL,
    "id" text NOT NULL,
    "role" text NOT NULL,
    "model_id" text,
    "created_at" integer NOT NULL,
    CONSTRAINT "messages_pk" PRIMARY KEY("session_id", "seq")
  )`,
  `CREATE TABLE IF NOT EXISTS "message_parts" (
    "session_id" text NOT NULL,
    "seq" integer NOT NULL,
    "idx" integer NOT NULL,
    "kind" text NOT NULL,
    "text" text,
    "tool_call_id" text,
    "tool_name" text,
    "payload" text,
    "is_error" integer,
    CONSTRAINT "message_parts_pk" PRIMARY KEY("session_id", "seq", "idx")
  )`,
  `CREATE TABLE IF NOT EXISTS "providers" (
    "id" text PRIMARY KEY,
    "name" text NOT NULL,
    "base_url" text NOT NULL,
    "key" text NOT NULL,
    "created_at" integer NOT NULL,
    "updated_at" integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "models" (
    "provider_id" text NOT NULL,
    "id" text NOT NULL,
    "display_name" text NOT NULL,
    "sdk" text NOT NULL,
    "created_at" integer NOT NULL,
    CONSTRAINT "models_pk" PRIMARY KEY("id", "provider_id")
  )`,
];
/**
 * 备好 schema：先给**空库**建表（幂等的 DDL 镜像），再把已有表同步成 `schemas/` 声明的样子
 * @returns 同步的账（差异 + 做了什么），由调用方决定怎么报
 * @throws 表不存在、或某条 DDL 被 SQLite 拒绝即抛（见 `upgrade.ts`）
 */
export function ensureSchema(db: Db): SchemaSyncResult {
  for (const ddl of SCHEMA_DDL) db.run(ddl);
  return syncSchema(db);
}
