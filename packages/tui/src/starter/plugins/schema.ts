/**
 * @fileoverview 结构同步插件：**应用树里本地库的闸门** —— 差异比对 + 迁移做完了，才把库句柄放出去
 * @module starter/plugins/schema
 * @description
 * 装载顺序由容器排（`inject: ["database"]`）。本插件把 `ctx.database` 同步成 `schemas/` 声明的样子
 * （补列 / 补索引 / 重建表 / 删索引 / 删列），同步成功之后才 `ctx.provide("library", …)`
 * —— 业务插件一律 `inject: ["library"]`。
 *
 * ## 事件（动手前后各一条，形状见 `@/starter/index.js`）
 * - `schema.syncing`（**同步前**）：⚠️ 同步会动用户的库文件（删列 / 重建表），UI 该有段时间显示「在改结构」。
 * - `schema.synced`：跑完了（动了或没动都发），载荷是**结构化**的 `SchemaSyncResult`（差异 + 已做的账）。
 * - `schema.failed`：同步失败；随后本插件**照旧装载失败**，闸门不开。
 *
 * ⚠️ **闸门**：`ctx.database` 是**打开的库句柄**，任何插件都能注入它；`ctx.library` 是**同步过的**，
 *   只有本插件跑完才存在。业务插件注入 `database` = 绕过闸门，别这么写。
 * ⚠️ 同步失败 = 本插件装载失败（`ensureSchema` 抛错）⇒ 启动失败（理由见 `@/starter/index.js`），
 *   依赖方停在等 `library` 的状态 ⇒ **一个插件都不会动**。
 * ⚠️ 换库地址时本插件跟着重跑：`databasePlugin` 重启 fiber → 依赖它的本插件先停再起 → 重新同步。
 * ⚠️ **`db/` 层不认识 cordis**：事件与人话都在本文件，`./db/sqlite/upgrade.js` 只负责把账交回来。
 */

import type { Context } from "cordis";
import type { Db } from "@/db/dialect.js";
import { ensureSchema } from "@/db/sqlite/init.js";
import type { AppliedChange, SchemaSyncResult } from "@/db/sqlite/upgrade/index.js";

declare module "cordis" {
  interface Context {
    /** **同步过**的本地库句柄（由 `schemaPlugin` 在结构同步做完后提供；业务插件只认它，别注入 `database`） */
    library: Db;
  }
  interface Events {
    /** 同步前：⚠️ 这一步会动用户的库文件 */
    "schema.syncing"(): void;
    /** 同步后：差异 + 已做的账 */
    "schema.synced"(result: SchemaSyncResult): void;
    /** 同步失败：随后闸门不开，这条只管让 UI 停转 */
    "schema.failed"(error: Error): void;
  }
}

/** 动作 → 人话（打日志与事件之外的展示都用这一份口径） */
const ACTION_TEXT: Record<AppliedChange["action"], string> = {
  "add-column": "补列",
  "drop-column": "删列",
  "add-index": "建索引",
  "drop-index": "删索引",
  "rebuild-table": "重建表",
};

/** 把同步的账打成人话（⚠️ 删列 / 重建表是自动的，这些行日志就是唯一的告知）：动了什么一行一条 */
function report(ctx: Context, result: SchemaSyncResult): void {
  for (const change of result.applied) {
    const note = change.note === undefined ? "" : `（${change.note}）`;
    ctx.logger.warn(`本地库结构已${ACTION_TEXT[change.action]}：${change.table}.${change.target}${note}`);
  }
  if (result.applied.length === 0) {
    ctx.logger.info("本地库结构已是最新，无需同步");
  }
}

/** 在已打开的库上做结构同步，然后把「同步过的句柄」放出去；同步失败 = 装载失败（= 没人能拿到句柄） */
export function schemaPlugin(ctx: Context): void {
  ctx.emit("schema.syncing"); // 动手之前：让 UI 先显示「在改结构」
  let result: SchemaSyncResult;
  try {
    result = ensureSchema(ctx.database);
  } catch (error) {
    try {
      // `ctx.emit` 会把监听器抛的错原样冒出来，不兜就会顶掉真正的同步错
      ctx.emit("schema.failed", error instanceof Error ? error : new Error(String(error)));
    } catch {
      // 监听器自己坏了，它已经在自己的栈里炸过一次，这里不再叠一个
    }
    throw error;
  }
  report(ctx, result);
  ctx.provide("library", ctx.database); // 闸门：过了这一行，业务插件才拿得到库
  ctx.emit("schema.synced", result);
}

schemaPlugin.inject = ["database"]; // ⚠️ 注入的库还没同步，本插件的职责就是同步它；业务插件注入的是 `library`