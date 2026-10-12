/**
 * @fileoverview 把「drizzle 声明」翻译成「SQL 语句」：列定义、补列、建表、建索引
 * @module db/sqlite/upgrade/ddl
 * @description
 * 这一层只认 `schemas/` 里的表对象，产出该发给驱动的语句字符串；不碰库、不管顺序（顺序是 `./sync.ts` 的事）。
 * ⚠️ **凡是拼不出来的形状一律当场抛**，不生成半截 SQL 让驱动报天书：表达式索引、带 `WHERE` 的部分索引、
 *   非字面量的默认值、带外键 / CHECK / UNIQUE 约束的表。
 * ⚠️ **标识符不走 drizzle 的 `sql` 模板**：模板会把插进去的名字也参数化成 `?`（表名是标识符，不是值），
 *   所以这一层自己拼引号（名字都来自本包 `schemas/`，不是外部输入；引号仍翻倍以防手滑）。
 */

import { getTableName } from "drizzle-orm";
import { getTableConfig, SQLiteColumn, type IndexConfig } from "drizzle-orm/sqlite-core";
import { TABLES } from "./diff.js";

/** 标识符加引号（名字来自本包 `schemas/`，不是外部输入；引号仍翻倍以防手滑） */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 该列的 SQL 默认值字面量；`undefined` = 这条 DDL 里没有 `DEFAULT`
 *
 * ⚠️ 「没有默认值」和「有默认值」一样常见：列上没写 `.default()` 时 `column.default` 就是 `undefined`，
 * 那时必须早退，不能落到下面的「不是常量」那一支。
 */
export function defaultLiteral(column: SQLiteColumn): string | undefined {
  if (column.defaultFn !== undefined) return undefined; // `$defaultFn` 是 JS 侧默认值，DDL 里本来就没有
  const value = column.default;
  if (value === undefined) return undefined;
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  throw new Error(
    `列 ${column.name} 的默认值不是常量，拼不出 DDL（只有文本 / 数字 / 布尔 / null 能拼）`,
  );
}

/** 一列在 `CREATE TABLE` / `ADD COLUMN` 里的那串定义 */
export function columnDefinition(column: SQLiteColumn): string {
  const parts = [ident(column.name), column.getSQLType()];
  const literal = defaultLiteral(column);
  if (literal !== undefined) parts.push(`DEFAULT ${literal}`);
  if (column.primary) parts.push("PRIMARY KEY");
  if (column.notNull) parts.push("NOT NULL");
  return parts.join(" ");
}

/** ⚠️ 主键列当场拒（SQLite 不许 `ADD COLUMN` 加主键，改主键只能重建表 —— 别让驱动报天书） */
export function addColumnSql(table: string, column: SQLiteColumn): string {
  if (column.primary) {
    throw new Error(`列 ${column.name} 是主键列，SQLite 不许用 ADD COLUMN 补（改主键要重建表）`);
  }
  return `ALTER TABLE ${ident(table)} ADD COLUMN ${columnDefinition(column)}`;
}

/**
 * 按 schemas 声明的形状拼一张**新表**的 `CREATE TABLE`（重建表那一档用）
 * @param declaredName - 声明里的表名（据此取列与约束）
 * @param newName - 建出来的表叫什么；重建时传临时表名
 * @throws 表上挂着外键 / CHECK / UNIQUE 约束即抛：这份 DDL 复现不了它们，宁可不重建
 */
export function createTableSql(declaredName: string, newName: string = declaredName): string {
  const table = TABLES.find((one) => getTableName(one) === declaredName);
  if (table === undefined) throw new Error(`表 ${declaredName} 不在本包管的五张表里`);
  const config = getTableConfig(table);
  if (config.foreignKeys.length > 0 || config.checks.length > 0 || config.uniqueConstraints.length > 0) {
    throw new Error(`表 ${declaredName} 上有外键 / CHECK / UNIQUE 约束，重建表这份 DDL 复现不了，请手工迁移`);
  }
  const lines = config.columns.map(columnDefinition);
  for (const primary of config.primaryKeys) {
    const columns = primary.columns.map((column) => ident(column.name)).join(", ");
    lines.push(`CONSTRAINT ${ident(primary.getName())} PRIMARY KEY(${columns})`);
  }
  return `CREATE TABLE ${ident(newName)} (${lines.join(", ")})`;
}

/** 一条索引的建索引语句；⚠️ 表达式索引与部分索引拼不出来（渲染它们要拖一整套 SQL 方言），当场拒 */
export function createIndexSql(table: string, config: IndexConfig): string {
  if (config.where !== undefined) {
    throw new Error(`索引 ${config.name} 带 WHERE 条件，拼不出来（本模块只认「列清单」形状的索引）`);
  }
  const columns = config.columns.map((column) => {
    if (!(column instanceof SQLiteColumn)) {
      throw new Error(`索引 ${config.name} 里有表达式列，拼不出来（本模块只认「列清单」形状的索引）`);
    }
    return ident(column.name);
  });
  return `CREATE ${config.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${ident(config.name)} ON ${ident(table)} (${columns.join(", ")})`;
}
