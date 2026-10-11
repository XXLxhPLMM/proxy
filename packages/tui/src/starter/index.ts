/**
 * @fileoverview 应用树的启动器（Cordis）：`createStarter` 建根并挂预设，`disposeStarter` 收尾
 * @module starter
 * @description
 * Cordis 是**应用级**框架，不是某个服务的容器：本地配置、本地库、控制面拨号、状态层、UI 重建后都挂成这棵树上的**插件**，
 * 依赖用 `inject` 声明、由容器排序（「提前量加载、操作随后进来」），每个注册都是可逆副作用、卸载时由 fiber 撤销。
 *
 * 边界：插件是**装配单元**（有生命周期 / 被共享 / 可能被替换的东西）；纯函数叶子不插件化——
 * `lib/request/`、`db/read.ts` 那类照旧是纯函数，在插件之间直接被调用，别为了「上树」加转发层。
 *
 * ⚠️ 建根与生命周期（`new Context()`、`fiber.dispose`）只在本文件建；`cli.tsx` 只负责调用与信号收尾
 *    （宿主来源归 `config/`，不从入口注入）。
 * ⚠️ 预设必须 async 并逐个 `await` 它装的插件：Cordis 不把**孙插件**的装载失败传给父的 `await`
 *    （实测：同步父插件里 `ctx.plugin(child)` 而 child 装载抛错，`await ctx.plugin(parent)` 照常 resolve），
 *    于是「开库失败也是启动失败」这条 fail-fast 只有在预设里逐个 await 才成立。
 * ⚠️ 卸载时多个 effect 是**并发**执行的（`Promise.all`，无顺序保证）：有先后要求的收尾要收进同一个 effect。
 * ⚠️ `cordis` 上游自述「API 未稳定」，故 package.json **精确锁版**；升级 = 改 pin + 跑冒烟，不挂 `^`。
 */

import { Context } from "cordis";

/** 应用上下文（Cordis 根上下文）：插件与消费方声明 `ctx` 参数用它；服务挂上后 `ctx.<key>` 自带类型 */
export type { Context } from "cordis";

/** 预设 = **组合插件**：一档要装哪些插件；插件要的参数各自从 `ctx.cfg` 取，预设不转手 */
export type StarterPreset = (ctx: Context) => Promise<void> | void;

/**
 * 启动：建根上下文，挂上这一档预设
 * @param preset - 组合插件（如 `defaultPreset`）；⚠️ 必须逐个 `await` 它装的插件（理由见文件头）
 * @throws 预设或它装的插件装载失败即抛（fail fast：启动期暴露，不拖到第一次使用）
 */
export async function createStarter(preset: StarterPreset): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(preset); // 可 await 的 fiber：等到预设装载完（含它 await 的子插件）
  return ctx;
}

/** 收尾（幂等）：卸载整个插件树——关库、撤销全部注册 */
export async function disposeStarter(ctx: Context): Promise<void> {
  await ctx.fiber.dispose();
}
