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
import { resourcePlugin } from "../plugins/resource.js";

/** 默认档：UI → 配置 → 本地库 → 资源（会话 / 消息）（待重建：控制面拨号 / 状态层） */
export async function defaultPreset(ctx: Context): Promise<void> {
  await ctx.plugin(uiPlugin); // 渲染树根最先起（退出信号由入口接管，无需 ctx.cfg）
  await ctx.plugin(configPlugin);
  await ctx.plugin(databasePlugin);
  await ctx.plugin(resourcePlugin);
}
