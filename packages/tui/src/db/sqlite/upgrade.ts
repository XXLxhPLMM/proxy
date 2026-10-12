/**
 * @fileoverview 老库升级：开库时按 `schemas/` 现推的形状给已有表补列（`ALTER TABLE … ADD COLUMN`）与补索引
 * （`CREATE INDEX IF NOT EXISTS`）；补不上即抛，比 `schemas/` 多出来的列只告警
 * @module db/sqlite/upgrade
 * @description
 * `init.ts` 的建表镜像只管**空库**（`CREATE TABLE IF NOT EXISTS` 对已存在的表一个字节不写），所以老机器上
 * 那个少两列的 `sessions`、那个还没有索引的表，还得有人补 —— 就是这里。列集合（`getColumns`）与索引清单
 * （`getTableConfig(...).indexes`）都从 `schemas/*.ts` 现取，不手抄：**索引名只有这一个出处**，
 * 空库老库走的是同一段代码。
 *
 * ⚠️ **只加不改**：`ADD COLUMN` 表达不了重命名、删列与数据回填。补不上（SQLite 拒绝，或补完那列还在缺）
 * 一律抛错并说清出路（手工迁移 / 删库重建），不静默放行。
 * ⚠️ **不包事务**：每条 ALTER / CREATE INDEX 都幂等，中途失败时已改的留在库里，下次开库接着补剩下的
 * （收敛）；包事务反而要多绕「事务回调里拿不到这句柄」那一路。
 * ⚠️ **不留迁移记录**：补了什么只在当次开库往 stderr 打一行；git 里每个迁移目录的 `migration.sql`
 * 才是「这次变更是什么」的记录（见 `init.ts` 文件头）。
 */

import { getColumns, getTableName, sql } from "drizzle-orm";
import { SQLiteColumn, getTableConfig, type IndexConfig } from "drizzle-orm/sqlite-core";
import type { Db } from "../dialect.js";
import { messageParts, messages, models, providers, sessions } from "./schemas/index.js";

/** 本包管着的五张表（列与索引都从它们现推） */
const TABLES = [sessions, messages, messageParts, models, providers] as const;

/** 每张表应有的列（从 schemas 现取，不手抄；JS 键 → 库内列名由 `column.name` 给） */
const EXPECTED_COLUMNS: ReadonlyMap<string, readonly SQLiteColumn[]> = new Map(
  TABLES.map((table) => [getTableName(table), Object.values(getColumns(table))]),
);

/** 每张表应有的索引（从表配置现取；今天只有 `sessions` 有） */
const EXPECTED_INDEXES: ReadonlyMap<string, readonly IndexConfig[]> = new Map(
  TABLES.map((table) => [getTableName(table), getTableConfig(table).indexes.map((one) => one.config)]),
);

/** 报一行给用户看（补列补索引是动用户文件的事，不能静默）；与 `client.ts` 的库回滚提示同一前缀 */
function warn(line: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[proxy-tui] ${line}`);
}

/** 驱动错误的可读文案；drizzle 把它包进 `cause`，两处都拼上（与 `client.ts` 认 WASM 打开失败同一手） */
function failureText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return e.cause instanceof Error ? `${e.message}（驱动：${e.cause.message}）` : e.message;
}

/** 库里某张表现有的列名（表不存在时给空集） */
function columnNames(db: Db, table: string): Set<string> {
  const rows = db.all<{ name: string }>(sql`select name from pragma_table_info(${table})`);
  return new Set(rows.map((row) => row.name));
}

/** 库里某张表现有的索引名（⚠️ 含 UNIQUE 约束与主键自动带的 `sqlite_autoindex_*`，但那些只多不少，无害） */
function indexNames(db: Db, table: string): Set<string> {
  const rows = db.all<{ name: string }>(
    sql`select name from sqlite_master where type = 'index' and tbl_name = ${table}`,
  );
  return new Set(rows.map((row) => row.name));
}

/** 该列的 SQL 默认值字面量；`undefined` = 这条 DDL 里没有 `DEFAULT` */
function defaultLiteral(column: SQLiteColumn): string | undefined {
  if (column.defaultFn !== undefined) return undefined; // `$defaultFn` 是 JS 侧默认值，DDL 里本来就没有
  const value = column.default;
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  throw new Error(
    `列 ${column.name} 的默认值不是常量，拼不出 ADD COLUMN（只有文本 / 数字 / 布尔 / null 能拼）`,
  );
}

/** 一列的补列语句；⚠️ 主键列当场拒（SQLite 不许 ADD COLUMN 加主键，别让驱动报天书） */
function addColumnSql(table: string, column: SQLiteColumn): string {
  if (column.primary) {
    throw new Error(`列 ${column.name} 是主键列，SQLite 不许用 ADD COLUMN 补（改主键只能重建表）`);
  }
  const parts = [`"${column.name}"`, column.getSQLType()];
  const literal = defaultLiteral(column);
  if (literal !== undefined) parts.push(`DEFAULT ${literal}`);
  if (column.notNull) parts.push("NOT NULL");
  return `ALTER TABLE "${table}" ADD COLUMN ${parts.join(" ")}`;
}

/** 一条索引的建索引语句；⚠️ 表达式索引与部分索引拼不出来（渲染它们要拖一整套 SQL 方言），当场拒 */
function createIndexSql(table: string, config: IndexConfig): string {
  if (config.where !== undefined) {
    throw new Error(`索引 ${config.name} 带 WHERE 条件，拼不出来（本文件只认「列清单」形状的索引）`);
  }
  const columns = config.columns.map((column) => {
    if (!(column instanceof SQLiteColumn)) {
      throw new Error(`索引 ${config.name} 里有表达式列，拼不出来（本文件只认「列清单」形状的索引）`);
    }
    return `"${column.name}"`;
  });
  return `CREATE ${config.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${config.name}" ON "${table}" (${columns.join(", ")})`;
}

/**
 * 给已有表补上 `schemas/` 里有、库里没有的列与索引；`schemas/` 没有、库里有的列告警；补不上即抛
 * @throws 表不存在、建表镜像与 `schemas/` 漂了、或某列补不上（错误里点名表与列，并给出出路）
 */
export function upgradeSchema(db: Db): void {
  for (const [table, wanted] of EXPECTED_COLUMNS) {
    const actual = columnNames(db, table);
    if (actual.size === 0) {
      throw new Error(
        `本地库没有 ${table} 表：建表镜像（init.ts）与 schemas/ 漂了，或这个文件不是本包建的`,
      );
    }

    const added: string[] = [];
    for (const column of wanted) {
      if (actual.has(column.name)) continue;
      try {
        db.run(addColumnSql(table, column));
        added.push(column.name);
      } catch (e) {
        // 另一个 TUI 实例刚补过这一列：不是错，接着往下走
        if (!failureText(e).includes("duplicate column name")) {
          throw new Error(
            `给本地库 ${table} 表补列「${column.name}」失败：${failureText(e)}。` +
              "这种变更不是加列能表达的（改主键 / 加 UNIQUE / 给已有数据的表加必填列），请手工迁移或删库重建",
          );
        }
      }
    }
    if (added.length > 0) {
      warn(`已给本地库 ${table} 表补上 ${added.length} 列：${added.join("、")}`);
    }

    const wantedNames = new Set(wanted.map((column) => column.name));
    const extra = [...actual].filter((name) => !wantedNames.has(name));
    if (extra.length > 0) {
      warn(
        `本地库 ${table} 表里有 schemas/ 没有的列：${extra.join("、")}` +
          "（像是一次重命名或删列，补列修不了；确认无误可不管，若数据对不上请手工迁移或删库重建）",
      );
    }

    // 索引：IF NOT EXISTS 天然幂等，但仍先查一次只为「真的建了」时打一行（建索引不像补列那么轻）
    const actualIndexes = indexNames(db, table);
    const created: string[] = [];
    for (const config of EXPECTED_INDEXES.get(table) ?? []) {
      if (actualIndexes.has(config.name)) continue;
      db.run(createIndexSql(table, config));
      created.push(config.name);
    }
    if (created.length > 0) {
      warn(`已给本地库 ${table} 表建上 ${created.length} 条索引：${created.join("、")}`);
    }
  }
}
