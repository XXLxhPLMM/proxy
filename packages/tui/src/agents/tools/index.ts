/**
 * @fileoverview 工具注册表：造工具（`defineTool`）与登记工具（`registerTool`）
 * @module agents/tools
 */

import { tool as sdkTool, type Tool, type ToolSet } from "ai";
import { z as zod } from "zod";

/** 已注册的全部工具；键即工具名（模型看到的就是这个键） */
export const AGENT_TOOLS: ToolSet = {};

/**
 * 造一条工具的回调：`tool`（SDK 的）与 `z`（zod 的）都由本包递进来。
 * @description 具名出来是为了让 `ctx.tools.register` 一类**收回调的入口**能把形状转述出去；
 *   不然每处都得把 `(tool: typeof sdkTool, z: typeof zod) => …` 重抄一遍。
 */
export type ToolBuild<BUILT extends Tool = Tool> = (tool: typeof sdkTool, z: typeof zod) => BUILT;

/**
 * 造一条工具，交出注册表认的那个类型（**就是回调里 `tool(…)` 交出来的那个**，类型一字不丢）。
 * @description 交进回调里的 `tool`（SDK 的）与 `z`（zod 的）是为了**工具作者不必 import `ai` 与 `zod`**：
 *   认识这两个包的是本包，写工具的人只管写说明、形状与实现。将来换 SDK 或换 zod 大版本，要改的只有本文件。
 * @example
 * ```ts
 * registerTool("read_file", defineTool((tool, z) => tool({
 *   description: "读一个文件的内容",
 *   inputSchema: z.object({ path: z.string() }),
 *   execute: async ({ path }) => await readFile(path, "utf8"),
 * })));
 * ```
 * @description 相对直接调 `ai` 的 `tool()` 只加一条校验：说明必须是非空字符串。SDK 那边缺省不报错，
 *   只是模型无从判断该不该调它 —— 那种错在这里抛，别拖到看着像「工具没生效」再回头找。
 */
export function defineTool<BUILT extends Tool>(build: ToolBuild<BUILT>): BUILT {
  const built = build(sdkTool, zod);
  if (typeof built.description !== "string" || built.description === "") {
    throw new Error("工具说明必须是非空字符串（模型靠它判断该不该调这个工具）");
  }
  return built;
}

/**
 * 注册一条工具，交出工具名（模型看到的就是这个名字）与工具本身。
 * @returns 退订函数：摘掉这条；同名已被别人重新注册过时它什么也不做。
 * @description ⚠️ 全是装载期的校验：跑起来才发现工具不对时，循环那边一轮说的话已经没了。
 */
export function registerTool(name: string, tool: Tool): () => void {
  if (name === "") throw new Error("工具名不能是空串");
  if (/\s/.test(name)) throw new Error(`工具名 ${JSON.stringify(name)} 里不许有空白`);
  // ⚠️ 前一条挡的是「赋值不报错却换掉注册表原型」，后一条必须用 `hasOwn` 不能用 `in`
  //   （`in` 会把 `Object.prototype` 上的名字算成已注册）
  if (name in Object.prototype) throw new Error(`工具名 ${JSON.stringify(name)} 不许用（Object.prototype 上的键）`);
  if (Object.hasOwn(AGENT_TOOLS, name)) throw new Error(`工具名 ${name} 已经被注册过了`);
  // ⚠️ 两条都没有 = 客户端工具：调用发得出去，但本包没有客户端补结果
  if (typeof tool !== "object" || tool === null) throw new Error(`工具 ${name} 不是一个对象`);
  if (typeof tool.execute !== "function" && tool.isProviderExecuted !== true) {
    throw new Error(`工具 ${name} 既没有 execute 也不是 provider 代跑的，本包跑不了它`);
  }

  AGENT_TOOLS[name] = tool;
  return () => {
    if (AGENT_TOOLS[name] === tool) delete AGENT_TOOLS[name];
  };
}