/**
 * @fileoverview 结构同步的编排：按 `./diff.ts` 给的差异把库改成 `schemas/` 声明的样子，并把账交回去
 * @module db/sqlite/upgrade/sync
 * @description
 * 一次 `syncSchema` 跑五步，档次由 SQLite 自己能不能表达决定（实测：两档驱动的 SQLite 都是 3.5x，
 * `DROP COLUMN` / `RENAME COLUMN` 都有；但没有 `ALTER COLUMN`）：
 *
 * 1. **补列**（`missing`）→ `ALTER TABLE … ADD COLUMN`
 * 2. **重建表**（`changed`：类型 / NOT NULL 变了）→ 一张表一次，见 `./rebuild.ts`
 * 3. **删索引**（`extra`）→ `DROP INDEX`（删列与重建表都要求先把依赖它的索引拆掉）
 * 4. **补索引**（`missing`）→ `CREATE INDEX IF NOT EXISTS`
 * 5. **删列**（`extra`）→ `DROP COLUMN`
 *
 * ⚠️ **步骤顺序不是随便排的**：重建表（第 2 步）会把旧表连同它的索引一起没掉，所以补索引只能排在它后面；
 *   而删列（第 5 步）前必须先拆掉依赖该列的索引。
 * ⚠️ **删列是自动的、没有开关**：schema 里少一列，下次开库那列的数据就没了。这是「同步」的本分，
 *   靠 `starter/plugins/schema.ts` 每次开库逐条打日志让人看得见（而不是靠拦着不做）。
 * ⚠️ **「多一列」与「改了列名」分不开**（见 `./diff.ts` 文件头）：本模块不猜，只按「多了就删」处理 ——
 *   所以**改列名要走重命名而不是删了再加**，否则数据会被这次同步抹掉。
 * ⚠️ **不包事务的只有轻档**：`ADD COLUMN` / `CREATE INDEX` 都幂等，中途失败下次开库接着补（收敛）；
 *   重建表那一档**必须**在事务里（搬数据 + 换名要一起成或一起败）。
 * ⚠️ **本模块不打印、不发事件**：只把结果交回调用方（事件与人话是 `starter/plugins/schema.ts` 的事）。
 */

import { getColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import type { Db } from "../../dialect.js";
import { addColumnSql, createIndexSql, ident } from "./ddl.js";
import { actualColumns, actualIndexes, diffSchema, TABLES, type SchemaDiff } from "./diff.js";
import { rebuildTable } from "./rebuild.js";

/** 同步做过的动作 */
export type SyncAction = "add-column" | "drop-column" | "add-index" | "drop-index" | "rebuild-table";

/** 一条已落地的变更 */
export interface AppliedChange {
  readonly action: SyncAction;
  readonly table: string;
  /** 列名或索引名；`rebuild-table` 时是被改形状的那几列（逗号分隔，一表一次） */
  readonly target: string;
  /** 人话补充（重建表时是搬过去的列；删列时是「数据不再保留」；其余留空） */
  readonly note?: string;
}

/** 一次同步的账：差异 + 做了什么 */
export interface SchemaSyncResult {
  readonly diff: SchemaDiff;
  readonly applied: readonly AppliedChange[];
}

/** 驱动错误的可读文案；drizzle 把它包进 `cause`，两处都拼上（与 `client.ts` 认 WASM 打开失败同一手） */
function failureText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return e.cause instanceof Error ? `${e.message}（驱动：${e.cause.message}）` : e.message;
}

/** 按表名取声明的列（表名不在本包管的五张表里即抛） */
function declaredColumns(table: string) {
  const declared = TABLES.find((one) => getTableName(one) === table);
  if (declared === undefined) throw new Error(`表 ${table} 不在本包管的五张表里`);
  return Object.values(getColumns(declared));
}

/**
 * 把库改成 `schemas/` 声明的样子（幂等：已是终态时什么都不做）
 * @returns 差异 + 做了什么（由调用方决定怎么报；本模块不打印也不发事件）
 * @throws 表不存在、或某条 DDL 被 SQLite 拒绝即抛（错误里点名表与对象，并说清出路）
 */
export function syncSchema(db: Db): SchemaSyncResult {
  const diff = diffSchema(db);
  const applied: AppliedChange[] = [];

  // 表本身不在（建表镜像与 schemas/ 漂了、或这个文件不是本包建的）—— 后面每一步都会在它上面失败，先说清楚
  for (const table of TABLES) {
    if (actualColumns(db, getTableName(table)).size === 0) {
      throw new Error(
        `本地库没有 ${getTableName(table)} 表：建表镜像（init.ts）与 schemas/ 漂了，或这个文件不是本包建的`,
      );
    }
  }

  // 1) 补列（`changed` / `extra` 的先放着，它们要么重建要么删，删之前要把索引拆了）
  for (const one of diff.columns) {
    if (one.kind !== "missing") continue;
    const column = declaredColumns(one.table).find((c) => c.name === one.name)!;
    try {
      db.run(addColumnSql(one.table, column));
      applied.push({ action: "add-column", table: one.table, target: one.name });
    } catch (e) {
      // 另一个 TUI 实例刚补过这一列：不是错，接着往下走
      if (!failureText(e).includes("duplicate column name")) {
        throw new Error(
          `给本地库 ${one.table} 表补列「${one.name}」失败：${failureText(e)}。` +
            "这种变更不是加列能表达的，请手工迁移或删库重建",
        );
      }
    }
  }

  // 2) 重建表：一张表一次（重建只搬声明里的列，同表第二列形状变了也已被顺带修好；旧的索引随旧表一起没）
  const changedByTable = new Map<string, string[]>();
  for (const one of diff.columns) {
    if (one.kind !== "changed") continue;
    const names = changedByTable.get(one.table) ?? [];
    names.push(one.name);
    changedByTable.set(one.table, names);
  }
  for (const [table, names] of changedByTable) {
    const note = rebuildTable(db, table);
    applied.push({
      action: "rebuild-table",
      table,
      target: names.join("、"),
      note: `按新形状重建，${note}`,
    });
  }

  // 3) 拆掉多余的索引（删列与重建表都要求它先不在；重建过的表索引已经没了，这里自然空转）
  for (const one of diff.indexes) {
    if (one.kind !== "extra") continue;
    db.run(`DROP INDEX IF EXISTS ${ident(one.name)}`);
    applied.push({ action: "drop-index", table: one.table, target: one.name });
  }

  // 4) 补索引（重建表后重新读一次实际索引，别拿同步前的旧账）
  for (const table of TABLES) {
    const tableName = getTableName(table);
    const have = actualIndexes(db, tableName);
    for (const config of getTableConfig(table).indexes.map((one) => one.config)) {
      if (have.has(config.name)) continue;
      db.run(createIndexSql(tableName, config));
      applied.push({ action: "add-index", table: tableName, target: config.name });
    }
  }

  // 5) 删掉多余的列（⚠️ 数据不可逆 —— 改列名要走重命名，别靠删了再加）
  // ⚠️ 按**当下的**实际列再核一遍：同一次同步里若刚重建过表（重建只搬声明里的列 ⇒ 多余的列当场就没了），
  //   这一档不能再去 DROP 一个已经不存在的列（那会报 `no such column` 并把整个同步打断）
  for (const one of diff.columns) {
    if (one.kind !== "extra") continue;
    if (!actualColumns(db, one.table).has(one.name)) continue;
    db.run(`ALTER TABLE ${ident(one.table)} DROP COLUMN ${ident(one.name)}`);
    applied.push({ action: "drop-column", table: one.table, target: one.name, note: "该列数据不再保留" });
  }

  return { diff, applied };
}
