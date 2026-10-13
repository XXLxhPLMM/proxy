/**
 * @fileoverview 工具插件：把工具注册表挂成服务 `ctx.tools`，并登记内置那两条
 * @module starter/plugins/tools
 * @description
 * `ctx.tools` 是**注册表的门面**（模块级单例，进程内一份）：别的插件经它看「现在有哪些工具」、
 * 往里加自己的工具（加完拿退订函数）、摘掉别人的。内置那两条（`shell` / `webfetch`）在同一个 effect
 * 里登记，卸载时一起退订 —— 谁登记谁退订，只有这个文件说了算。
 *
 * ## 事件（动手前后各一条，形状见 `@/starter/index.js`）
 * - `tools.register.start`（**动手之前**）：载荷是工具名。
 * - `tools.register.finish`：登记好了。
 * - `tools.register.failed`：登记失败（重名、名字非法、说明为空）；随后错照原样抛给调用方。
 * - `tools.unregister.start` / `.finish`：摘一条工具的前后。⚠️ **没有 `failed`**——
 *   摘一条不存在的工具不抛（规则是「会抛的才补 `failed`」）。
 *
 * ⚠️ 这五条只覆盖 **`ctx.tools` 的那两个方法**（别的插件在运行期增删工具）。
 *   本插件装配内置那两条时直接调注册表，**一条事件都不发**——装载期的一次性装配不是谁请求的动作。
 *
 * ⚠️ **登记 `shell` 就是把 shell 交出去**：它会执行任意命令，没有开关、没有白名单、没有确认
 *   （见 `@/agents/tools/shell.js` 文件头）。要少一条，就从这里把那行删掉。
 * ⚠️ 退订收在**同一个 effect** 里：卸载时多个 effect 是并发执行的（无顺序保证，见 `@/starter/index.js`）。
 */

import type { Context } from "cordis";
import type { Tool } from "ai";
import { AGENT_TOOLS, defineTool, registerTool, type ToolBuild } from "@/agents/tools/index.js";
import { registerShellTool } from "@/agents/tools/shell.js";
import { registerWebFetchTool } from "@/agents/tools/webfetch.js";

declare module "cordis" {
  interface Context {
    /** 工具注册表（由 `toolsPlugin` 提供；看有哪些 / 取一条 / 加一条） */
    tools: ToolsService;
  }
  interface Events {
    /** 动手之前：此刻工具还没进注册表 */
    "tools.register.start"(name: string): void;
    /** 登记好了；载荷是工具名 */
    "tools.register.finish"(name: string): void;
    /** 登记失败；随后错照原样抛给调用方（不改控制流） */
    "tools.register.failed"(name: string, error: Error): void;
    /** 摘之前：此刻工具还在注册表里 */
    "tools.unregister.start"(name: string): void;
    /** 摘掉了；载荷是工具名。⚠️ **没有 `failed`**：摘一条不存在的工具不抛（见 `unregister`） */
    "tools.unregister.finish"(name: string): void;
  }
}

/** 工具服务面：注册表的门面，不自己存一份 */
export interface ToolsService {
  /** 现在有哪些工具（名字，按登记序） */
  names(): readonly string[];
  /** 取一条工具；没有这条给 `undefined` */
  get(name: string): Tool | undefined;
  /**
   * 登记一条工具。收的是 {@link defineTool} 的那个**回调**，不是造好的工具。
   * @returns 退订函数：调它把这条摘掉（只摘自己那一条）。
   * @description `tool`（SDK 的）与 `z`（zod 的）由本服务递进回调，调用方不必 import `ai` 与 `zod`。
   *   重名、名字非法、说明为空都**当场抛**（判据见 `@/agents/tools/index.js`）。
   * @example
   * ```ts
   * ctx.tools.register("echo", (tool, z) => tool({
   *   description: "原样回声",
   *   inputSchema: z.object({ text: z.string() }),
   *   execute: ({ text }) => text,
   * }));
   * ```
   */
  register<BUILT extends Tool>(name: string, build: ToolBuild<BUILT>): () => void;
  /**
   * 摘掉一条工具；没有这条就什么也不做（幂等，不抛）。
   * ⚠️ **认名字不认人**：`register` 交回来的退订函数只在「现在这条还是我那条」时才摘，
   *   而本方法把当前挂在那个名字下的一切都摘掉 —— 同名被别人重新注册过时，用退订函数，用本方法会摘错人。
   */
  unregister(name: string): void;
}

/** 插件抛出来的东西未必是 `Error`（`throw "boom"` 合法），统一成 `Error` 再交给监听者 */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** 工具插件：提供 `ctx.tools`，装载即登记内置两条，卸载即退订 */
export function toolsPlugin(ctx: Context): void {
  ctx.provide("tools", {
    names: () => Object.keys(AGENT_TOOLS),
    get: (name) => AGENT_TOOLS[name],
    register<BUILT extends Tool>(name: string, build: ToolBuild<BUILT>): () => void {
      ctx.emit("tools.register.start", name); // 动手之前
      try {
        const dispose = registerTool(name, defineTool(build));
        ctx.emit("tools.register.finish", name);
        return dispose;
      } catch (error) {
        try {
          // `ctx.emit` 会把监听器抛的错原样冒出来，不兜就会顶掉真正的错
          ctx.emit("tools.register.failed", name, asError(error));
        } catch {
          // 监听器自己坏了，它已经在自己的栈里炸过一次，这里不再叠一个
        }
        throw error;
      }
    },
    unregister: (name) => {
      ctx.emit("tools.unregister.start", name);
      delete AGENT_TOOLS[name];
      ctx.emit("tools.unregister.finish", name);
    },
  });

  ctx.effect(() => {
    // ⚠️ 内置这两条**直接调注册表，不走 `ctx.tools.register`**：那是装载期的一次性装配，
    //   不是别人请求的一次动作，为它发事件只会让启动时凭空多出两对事件、UI 还得专门去忽略。
    //   `ctx.tools.register` 是给**别的插件**在运行期加工具用的，那条路才带事件。
    const offShell = registerShellTool();
    const offWebFetch = registerWebFetchTool();
    return () => {
      offWebFetch();
      offShell();
    };
  });
}