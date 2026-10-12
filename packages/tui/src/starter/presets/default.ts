/**
 * @fileoverview 默认预设（组合插件）：把 TUI 这一档要装的插件成批装进根上下文
 * @module starter/presets/default
 * @description 预设只管「装哪些插件」；宿主来源（库地址等）归各插件自己从 `ctx.cfg` 取，预设不转手参数。
 * ⚠️ async + 逐个 `await`：Cordis 不把孙插件的装载失败传给父的 `await`（理由见 `@/starter/index.js` 文件头）。
 */

import type { Context } from "cordis";
import { uiPlugin } from "../plugins/ui.js";
import { configPlugin } from "../plugins/config.js";
import { databasePlugin } from "../plugins/database.js";
import { schemaPlugin } from "../plugins/schema.js";
import { resourcePlugin } from "../plugins/resource.js";

/**
 * 默认档：UI → 配置 → 本地库 → **结构同步（闸门）** → 资源（会话 / 消息）
 * （待重建：控制面拨号 / 状态层）
 * @description ⚠️ `schemaPlugin` 必须排在 `resourcePlugin` 前面被 `await`：它是本地库的闸门，
 *   同步失败要变成启动失败（fail-fast），而依赖方停在等 `ctx.library` 的状态 ⇒ 一个插件都不动
 */
export async function defaultPreset(ctx: Context): Promise<void> {
  await ctx.plugin(uiPlugin); // 渲染树根最先起（退出信号由入口接管，无需 ctx.cfg）
  await ctx.plugin(configPlugin);
  await ctx.plugin(databasePlugin);
  await ctx.plugin(schemaPlugin); // 结构同步：比对差异 + 迁移，做完才放行后面的插件
  await ctx.plugin(resourcePlugin);
}
