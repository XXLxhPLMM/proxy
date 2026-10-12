/**
 * @fileoverview 运行期建表：空库的 `CREATE TABLE IF NOT EXISTS` 镜像（补列与索引归 `./upgrade.ts`）
 * @module db/sqlite/init
 * @description
 * 首次开库（或库里缺表）时把五张表建出来；对已存在的表一个字节不写（幂等）。
 *
 * ⚠️ **DDL 镜像的是「一个空库该有的表」**（= `drizzle/sqlite/` 下基线加全部增量迁移攒出来的终态，那些
 * `migration.sql` 由 drizzle-kit 生成、是迁移真值）：改 schema 必须先 `pnpm exec drizzle-kit generate`。
 * ⚠️ **镜像里只有表，没有索引**：索引与「补列」都归 {@link upgradeSchema}（从 `schemas/` 现推，空库老库
 * 同一条路），免得索引名在这份镜像里再写一遍。
 *
 * ⚠️ 所以开库的最后一步是 {@link upgradeSchema}：老机器上少列的表由它 `ALTER TABLE … ADD COLUMN` 补上、
 * 缺的索引由它 `CREATE INDEX IF NOT EXISTS` 建上，补不上才抛（它只加不改：改主键 / 重命名 / 删列 /
 * 数据回填都得手工）。
 */

import type { Db } from "../dialect.js";
import { upgradeSchema } from "./upgrade.js";

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
 * 备好 schema：应用 DDL（幂等，只管空库），再交给 {@link upgradeSchemaColumns} 处理老库
 * @throws 老库少列而补不上即抛（见 `upgrade.ts`）
 */
export function ensureSchema(db: Db): void {
  for (const ddl of SCHEMA_DDL) db.run(ddl);
  upgradeSchema(db);
}
