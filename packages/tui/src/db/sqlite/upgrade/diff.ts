/**
 * @fileoverview 结构差异：把「库里现在的样子」与「`schemas/` 声明的样子」比一遍 —— 只读，一个字节都不写
 * @module db/sqlite/upgrade/diff
 * @description
 * 两边都是现取的：期望侧走 drizzle 表对象（`getColumns` / `getTableConfig`），实际侧走
 * `pragma_table_info` 与 `sqlite_master`。差集成三档，是 SQLite 自己能不能表达决定的：
 * - `missing` 列 / `missing` 索引 ⇒ `ADD COLUMN` / `CREATE INDEX` 就行（`./sync.ts` 的轻档）
 * - `extra` 列 / `extra` 索引 ⇒ `DROP COLUMN` / `DROP INDEX`（删列前得先拆掉依赖它的索引）
 * - `changed` 列（类型或 NOT NULL 变了）⇒ SQLite 没有 `ALTER COLUMN`，只能**重建表**（最重的一档）
 *
 * ⚠️ **`DEFAULT` 不参与判定**：库里 `pragma_table_info.dflt_value` 是 SQLite 自己记的字面文本
 * （`true` / `1` / `'idle'` 各随写法而异），与 drizzle 侧的值没有一一对应，拿它比只会天天误报；
 * 而改默认值本来也不需要动结构。
 * ⚠️ **「多一列」与「改了列名」在这里分不开**：机器只看见「多了 X、少了 Y」，把 Y 当成 X 的新名字就是猜。
 *   所以本模块不做任何推断，怎么处置留给 `./sync.ts`。
 */

import { getColumns, getTableName, sql } from "drizzle-orm";
import { getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "../../dialect.js";
import { messageParts, messages, mcps, models, providers, sessions } from "../schemas/index.js";

/** 本包管着的六张表；差异比对与结构同步都按这个次序走 */
export const TABLES = [sessions, messages, messageParts, models, providers, mcps] as const;

/** 一列的形状（只取结构上要紧的两样；`DEFAULT` 见文件头） */
export interface ColumnShape {
  /** SQL 类型（`text` / `integer` …；sqlite 大小写不敏感，比对时一律小写） */
  readonly type: string;
  readonly notNull: boolean;
}

/** 一列的差异 */
export interface ColumnDiff {
  readonly table: string;
  readonly name: string;
  /** `missing` = schemas 有、库里没有；`extra` = 库里有、schemas 没有；`changed` = 两边都有但形状不同 */
  readonly kind: "missing" | "extra" | "changed";
  /** 期望形状（`missing` / `changed` 才有） */
  readonly wanted?: ColumnShape;
  /** 库里的形状（`extra` / `changed` 才有） */
  readonly actual?: ColumnShape;
}

/** 一条索引的差异（sqlite 没有「改索引」，只能删了重建） */
export interface IndexDiff {
  readonly table: string;
  readonly name: string;
  readonly kind: "missing" | "extra";
}

/** 一次比对的全部差异 */
export interface SchemaDiff {
  readonly columns: readonly ColumnDiff[];
  readonly indexes: readonly IndexDiff[];
}

/** 库里某张表的实际列（表不存在时给空 Map）
 *
 * ⚠️ `notnull` 是 pragma 的列名，取它必须带引号（`select … , "notnull" …`）：不加引号 SQLite 报
 * `near "notnull": syntax error`。
 */
export function actualColumns(db: Db, table: string): ReadonlyMap<string, ColumnShape> {
  const rows = db.all<{ name: string; type: string; notnull: number }>(
    sql`select name, type, "notnull" from pragma_table_info(${table})`,
  );
  return new Map(rows.map((row) => [row.name, { type: row.type.toLowerCase(), notNull: row.notnull === 1 }]));
}

/** 库里某张表的实际索引名（⚠️ 含 UNIQUE / 主键自动带的 `sqlite_autoindex_*`，那些只多不少，比对时忽略） */
export function actualIndexes(db: Db, table: string): ReadonlySet<string> {
  const rows = db.all<{ name: string }>(
    sql`select name from sqlite_master where type = 'index' and tbl_name = ${table}`,
  );
  return new Set(rows.map((row) => row.name));
}

/** schemas 声明的列形状（`getSQLType()` + `notNull`） */
function wantedShape(column: SQLiteColumn): ColumnShape {
  return { type: column.getSQLType().toLowerCase(), notNull: column.notNull };
}

/**
 * 形状真的变了吗（类型变了，或 NOT NULL 变了）
 *
 * ⚠️ **主键列不比 `notNull`**：SQLite 的 `text PRIMARY KEY` 在 `pragma table_info` 里 `notnull` 报 **0**
 * （非 STRICT 表的历史行为），而声明侧是「是主键 ⇒ 隐含必填」。不豁免的话每张表的 `id` 都会被判成
 * 「形状变了」⇒ 每次开库都想重建全库。
 */
function shapeChanged(column: SQLiteColumn, actual: ColumnShape, wanted: ColumnShape): boolean {
  if (actual.type !== wanted.type) return true;
  return !column.primary && actual.notNull !== wanted.notNull;
}

/** 比一遍六张表：库里的现状 vs `schemas/` 的声明 */
export function diffSchema(db: Db): SchemaDiff {
  const columns: ColumnDiff[] = [];
  const indexes: IndexDiff[] = [];

  for (const table of TABLES) {
    const tableName = getTableName(table);
    const wanted = Object.values(getColumns(table));
    const actual = actualColumns(db, tableName);

    for (const column of wanted) {
      const shape = wantedShape(column);
      const have = actual.get(column.name);
      if (have === undefined) {
        columns.push({ table: tableName, name: column.name, kind: "missing", wanted: shape });
      } else if (shapeChanged(column, have, shape)) {
        columns.push({ table: tableName, name: column.name, kind: "changed", wanted: shape, actual: have });
      }
    }
    const wantedNames = new Set(wanted.map((column) => column.name));
    for (const [name, shape] of actual) {
      if (!wantedNames.has(name)) columns.push({ table: tableName, name, kind: "extra", actual: shape });
    }

    const actualIndexNames = actualIndexes(db, tableName);
    const declared = getTableConfig(table).indexes.map((one) => one.config);
    for (const config of declared) {
      if (!actualIndexNames.has(config.name)) {
        indexes.push({ table: tableName, name: config.name, kind: "missing" });
      }
    }
    const declaredNames = new Set(declared.map((config) => config.name));
    for (const name of actualIndexNames) {
      if (name.startsWith("sqlite_autoindex_")) continue; // UNIQUE / 主键自带的，不归本包管
      if (!declaredNames.has(name)) indexes.push({ table: tableName, name, kind: "extra" });
    }
  }

  return { columns, indexes };
}
