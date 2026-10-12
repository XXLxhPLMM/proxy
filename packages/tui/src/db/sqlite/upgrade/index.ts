/**
 * @fileoverview 结构同步整块的出口：把库改成 `schemas/` 声明的样子 —— 比对差异 → 迁移 → 交回账
 * @module db/sqlite/upgrade
 * @description
 * 四件事分住四个文件，各自只管一桩：
 * - `./diff.ts`：**只读**地比对「库里的样子」与「`schemas/` 声明的样子」，产出 `missing` / `extra` / `changed` 三档
 * - `./ddl.ts`：把 drizzle 声明翻译成该发给驱动的 SQL（补列 / 建表 / 建索引）
 * - `./rebuild.ts`：重建表 —— 改类型或 NOT NULL 时 SQLite 没有 `ALTER COLUMN`，这是唯一出路（事务里搬数据）
 * - `./sync.ts`：**编排**五步并记账（`SchemaSyncResult`）
 *
 * ⚠️ 入口是 `ensureSchema`（`../init.ts`），由 `starter/plugins/schema.ts` 在开库时调；同步失败 = 那个插件装载失败
 *   ⇒ 本地库的闸门关着，别的插件都拿不到句柄。
 * ⚠️ 运行期**不应用** git 里 `drizzle/sqlite/` 各迁移目录的 SQL —— 那是「变更是什么」的留档；
 *   唯一需要人照着它手工处理的是**重命名**这类本模块与库里分不清的变更。
 */

export { syncSchema } from "./sync.js";
export type { AppliedChange, SchemaSyncResult, SyncAction } from "./sync.js";
export type { ColumnDiff, ColumnShape, IndexDiff, SchemaDiff } from "./diff.js";
