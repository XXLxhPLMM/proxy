/**
 * @fileoverview 运行期建表：基线 DDL 的 `IF NOT EXISTS` 镜像 + 开库时的列校验
 * @module services/db/sqlite/init
 * @description
 * 首次开库（或库里缺表）时把三张表建出来；对已存在的表一个字节不写（幂等）。
 *
 * ⚠️ **DDL 是 `drizzle/sqlite/<基线>/migration.sql` 的镜像**（那份由 drizzle-kit 生成，是迁移真值）：
 * 改 schema 必须先重出基线，再把 DDL 同步到这里。防漂的第二道闸是 {@link ensureSchema} 的列校验 ——
 * 列集合从 `schemas/*.ts` 现取（`getColumns`），镜像漂了（或同名表是别人建的）开库当场就报，
 * 而不是等第一次查询才炸。
 *
 * 基线之后的**增量**迁移（ALTER 已有表）还没有机制，见 `./client.ts` 文件头。
 */

import { getColumns, getTableName, sql } from "drizzle-orm";
import type { Db } from "../dialect.js";
import { messageParts, messages, sessions } from "./schemas/index.js";

/** 建表语句（与迁移基线逐列一致）；⚠️ **只许** `IF NOT EXISTS` 形态：`attachResource` 每次开库都会跑 */
const SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "sessions" (
    "id" text PRIMARY KEY,
    "title" text NOT NULL,
    "model_id" text,
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
];

/** 每张表应有的列（从 schemas 现取，不手抄；JS 键 → 库内列名由 `column.name` 给） */
const EXPECTED_COLUMNS: ReadonlyMap<string, readonly string[]> = new Map(
  [sessions, messages, messageParts].map((table) => [
    getTableName(table),
    Object.values(getColumns(table)).map((column) => column.name),
  ]),
);

/**
 * 备好 schema：应用 DDL（幂等）并校验三张表的列
 * @throws 表少列即抛：同名表是别人建的、或 DDL 镜像与 `schemas/` 漂了。⚠️ **多列放行**（将来加列时旧库仍能开）
 */
export function ensureSchema(db: Db): void {
  for (const ddl of SCHEMA_DDL) db.run(ddl);

  for (const [tableName, wanted] of EXPECTED_COLUMNS) {
    const rows = db.all<{ name: string }>(sql`select name from pragma_table_info(${tableName})`);
    const actual = new Set(rows.map((row) => row.name));
    const missing = wanted.filter((name) => !actual.has(name));
    if (missing.length > 0) {
      throw new Error(
        `本地库 ${tableName} 表少列：${missing.join("、")}（这个文件不是本包建的，或建表 DDL 与 schemas/ 漂了）`,
      );
    }
  }
}
