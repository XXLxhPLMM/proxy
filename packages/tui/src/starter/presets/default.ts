/**
 * @fileoverview 默认预设（组合插件）：把 TUI 这一档要装的插件成批装进根上下文
 * @module starter/presets/default
 * @description 预设只管「装哪些插件」；宿主来源（库地址等）归各插件自己从 `ctx.cfg` 取，预设不转手参数。
 * ⚠️ async + 逐个 `await`：Cordis 不把孙插件的装载失败传给父的 `await`（理由见 `@/starter/index.js` 文件头）。
 */

import type { Context } from "cordis";
import { uiPlugin } from "../plugins/ui/index.js";
import { configPlugin } from "../plugins/config/index.js";
import { dbPlugin } from "../plugins/db/index.js";
import { daoPlugin } from "../plugins/dao/index.js";
import { servicesPlugin } from "../plugins/services/index.js";
import { toolsPlugin } from "../plugins/tools/index.js";
import { mcpPlugin } from "../plugins/mcp/index.js";

/**
 * 默认档：UI → 配置 → 本地库（开库 + **结构同步 = 闸门**）→ 行操作目录 → 业务服务 → **工具注册** → **MCP**
 * （待重建：控制面拨号 / 状态层 / agent 循环）
 * @description ⚠️ `dbPlugin` 必须排在 `servicesPlugin` 前面被 `await`：开库或同步失败都要变成启动失败
 *   （fail-fast），而 `servicesPlugin` 停在等 `ctx.db` 的状态 ⇒ 一个业务插件都不会动。
 *   `daoPlugin` 无状态无依赖，排在哪都行；`toolsPlugin` 不依赖前面任何一个（注册表是模块级单例），
 *   排在最后纯粹因为它是给 agent 循环备的。
 * ⚠️ `mcpPlugin` 排最后且**必须排在 `toolsPlugin` 之后**：它的工具经 `ctx.tools` 登记，
 *   注入的 `tools` 注不到就装不上（`inject: ["db", "services", "tools"]`，见该文件）。
 */
export async function defaultPreset(ctx: Context): Promise<void> {
  await ctx.plugin(uiPlugin); // 渲染树根最先起（退出信号由入口接管，无需 ctx.cfg）
  await ctx.plugin(configPlugin);
  await ctx.plugin(dbPlugin); // 开库 → 结构同步 → 才 provide ctx.db（闸门）
  await ctx.plugin(daoPlugin); // 行操作目录（无状态，不带库）
  await ctx.plugin(servicesPlugin); // 业务服务：inject ["db", "dao"]
  await ctx.plugin(toolsPlugin); // 工具注册：装配 shell / webfetch（⚠️ 登记 shell = 把 shell 交出去）
  // MCP：按 mcps 表里没 disabled 的那几台起会话，工具经 ctx.tools 登记（inject ["db", "services", "tools"]）
  await ctx.plugin(mcpPlugin);
}