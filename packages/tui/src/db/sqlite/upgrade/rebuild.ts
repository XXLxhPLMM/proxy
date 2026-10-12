/**
 * @fileoverview 重建表：SQLite 改不了列的类型 / NOT NULL 时的唯一出路 —— 建新表、搬数据、丢旧表、改名
 * @module db/sqlite/upgrade/rebuild
 */

import { getColumns, getTableName } from "drizzle-orm";
import type { Db } from "../../dialect.js";
import { actualColumns, TABLES } from "./diff.js";
import { createTableSql, defaultLiteral, ident } from "./ddl.js";

/** 临时表的名字后缀（与声明的表名不会撞） */
const REBUILD_SUFFIX = "__rebuild";

/**
 * 重建一张表：按新形状建临时表 → 搬两边共有的列 → 丢旧表 → 改名
 * @returns 给人话的一段说明（搬过去的列；有多余的列被顺带丢弃时点名）
 *
 * ⚠️ 必须在事务里跑：`db.transaction` 把 `BEGIN/COMMIT` 交给驱动，中途失败整段回滚，库里不留半张表。
 * ⚠️ 旧表上的索引随旧表一起没了（SQLite 的索引属于表），调用方（`./sync.ts`）随后按声明重建。
 * ⚠️ **只搬声明里的列**：库里多出来的列在这一步就跟着旧表一起没了（这也是删列那一档要在事后核一遍的原因）。
 * ⚠️ **搬的时候要给「收紧成 NOT NULL 的列」兜底**：默认值只在 INSERT 不写这一列时才生效，
 *   `INSERT … SELECT` 是逐值写的 —— 源列里的 `NULL` 会被原样搬进 NOT NULL 列，当场炸。所以这类列用
 *   `coalesce(列, 默认值)` 搬；**没有默认值的 NOT NULL 列**填不了，动手前先查一遍并说清是哪一列有多少 NULL。
 */
export function rebuildTable(db: Db, table: string): string {
  const temporary = `${table}${REBUILD_SUFFIX}`;
  const declared = TABLES.find((one) => getTableName(one) === table)!;
  const inTable = actualColumns(db, table);
  const moving = Object.values(getColumns(declared)).filter((column) => inTable.has(column.name));
  if (moving.length === 0) throw new Error(`表 ${table} 一列都没有，重建它等于建空表，停下`);

  // 填不了的先说清楚，别等 INSERT 炸出一句天书
  for (const column of moving.filter((c) => c.notNull && defaultLiteral(c) === undefined)) {
    const row = db.all<{ n: number }>(`select count(*) as n from ${ident(table)} where ${ident(column.name)} is null`);
    const nulls = row[0]?.n ?? 0;
    if (nulls > 0) {
      throw new Error(
        `表 ${table} 的列 ${column.name} 要收紧成 NOT NULL，但里面有 ${nulls} 个 NULL 且这一列没有默认值可填：` +
          "请先手工把 NULL 换成具体值（或给这一列加默认值），再重跑",
      );
    }
  }

  const targets = moving.map((column) => ident(column.name)).join(", ");
  const sources = moving
    .map((column) => {
      const literal = column.notNull ? defaultLiteral(column) : undefined;
      return literal === undefined ? ident(column.name) : `coalesce(${ident(column.name)}, ${literal})`;
    })
    .join(", ");

  db.transaction((tx) => {
    tx.run(createTableSql(table, temporary));
    tx.run(`INSERT INTO ${ident(temporary)} (${targets}) SELECT ${sources} FROM ${ident(table)}`);
    tx.run(`DROP TABLE ${ident(table)}`);
    tx.run(`ALTER TABLE ${ident(temporary)} RENAME TO ${ident(table)}`);
  });

  const dropped = [...inTable.keys()].filter((name) => !moving.some((column) => column.name === name));
  const note = moving.map((column) => column.name).join("、");
  return dropped.length === 0 ? note : `${note}（多余的列随重建一并丢弃：${dropped.join("、")}）`;
}
