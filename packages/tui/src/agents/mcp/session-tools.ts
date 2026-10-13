/**
 * @fileoverview 把一台服务器给的工具搬进 `ctx.tools`：拼上 `mcp__<服务器名>__` 前缀、登记、登记不上的点名跳过
 * @module agents/mcp/session-tools
 */

import type { Tool } from "ai";
import type { Context } from "cordis";
import type { McpToolSet } from "./connection.js";
import { isRegistrableToolName, mcpToolName } from "./naming.js";

/** 一台的工具搬进注册表之后的结果 */
export interface RegisteredTools {
  /** 已登记的键（**含 `mcp__` 前缀**），按登记序 */
  readonly names: readonly string[];
  /** 登记不上的工具**它自己的名字**（前缀后那半截）；空 = 这台的工具全上来了 */
  readonly skipped: readonly string[];
  /** 退订这批工具。⚠️ 幂等（第二次调用什么也不做）——退订函数归本模块保管，调用方只管在关会话时调一次 */
  unsubscribeAll(): void;
}

/**
 * 把一台给的工具集登记进 `ctx.tools`（只管「搬进来」，退订交给 {@link RegisteredTools.unsubscribeAll}）。
 * @description ⚠️ **一条登记不上不牵连这台服务器**（丢一条好过丢一整台），但 {@link RegisteredTools.skipped}
 *   会点名它们是谁——静默丢工具等于让人以为「这服务器就这么点能力」。两条理由不同，都记：工具名不合法是
 *   第三方给的（拼完仍可能带空白），登记抛错是注册表那边的（重名等）。
 * ⚠️ 走 `ctx.tools.register` 而不是直接调注册表：那是**别的插件在运行期加工具**的正路，会发
 *   `tools.register.*` 事件，UI 才知道「凭空多了哪些工具」。收的是**造好的**工具，所以回调直接把它交出去。
 */
export function registerSessionTools(ctx: Context, server: string, tools: McpToolSet): RegisteredTools {
  const offTools: (() => void)[] = [];
  const names: string[] = [];
  const skipped: string[] = [];

  for (const [toolName, mcpTool] of Object.entries(tools)) {
    const name = mcpToolName(server, toolName);
    if (!isRegistrableToolName(name)) {
      ctx.logger.warn("MCP 服务器「%s」的工具「%s」拼出的名字不合法（%s），已跳过", server, toolName, name);
      skipped.push(toolName);
      continue;
    }
    try {
      const off = ctx.tools.register(name, () => described(asRegistryTool(mcpTool), server, toolName));
      offTools.push(off);
      names.push(name);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.logger.warn("MCP 服务器「%s」的工具「%s」登记失败，已跳过：%s", server, toolName, reason);
      skipped.push(toolName);
    }
  }
  if (skipped.length > 0) {
    ctx.logger.warn("MCP 服务器「%s」接上了，但 %d 条工具没登记上：%s", server, skipped.length, skipped.join("、"));
  }
  return {
    names,
    skipped,
    unsubscribeAll: () => {
      // ⚠️ `splice(0)` 是**取干净并就地清空** ⇒ 天然幂等；`for (const off of offTools)` 那样第二次调用会把
      //   **别人重新登记上的**同名工具也摘掉
      for (const off of offTools.splice(0)) off();
    },
  };
}

/**
 * 把 MCP 给的那条工具当成注册表认的那种 `Tool`。
 * @description ⚠️ 这个断言是**类型层面的噪声，不是真的不兼容**：MCP 的工具集是 `Tool<unknown, CallToolResult>`，
 *   而 `ai` 的 `Tool` 缺省 `Tool<any, any>`，`Schema` 上那个 `[schemaSymbol]` 常量让 TS 判成不协变。
 *   **两边是同一代 API 的同一个 `Tool`**，接不上是类型措辞问题。真跑不跑得起来由紧跟着的 `registerTool` 判
 *   （它查 `execute` 是不是函数），不由类型判 —— 所以这个断言**有运行时兜底**。
 */
function asRegistryTool(mcpTool: McpToolSet[string]): Tool {
  return mcpTool as unknown as Tool;
}

/**
 * 交出去登记前补一句说明。
 * @description ⚠️ MCP 规范里工具的 `description` 是**可选**的，而 `defineTool` 硬要非空（模型靠它判断该不该调，
 *   理由见 `@/agents/tools/index.js`）——不给它兜一句，这台服务器的工具会**整条都登记不上**。这里**如实说清
 *   「这是什么、谁给的」**，不替第三方编功能。⚠️ 下面那个 `as Tool` 同 {@link asRegistryTool}：只是把
 *   `description` 填回它**本来就可选**的字段，形状没变；不写它是因为展开一个联合类型后 TS 认不回是哪个成员。
 */
function described(mcpTool: Tool, server: string, tool: string): Tool {
  if (typeof mcpTool.description === "string" && mcpTool.description !== "") return mcpTool;
  return {
    ...mcpTool,
    description: `MCP 服务器「${server}」提供的工具「${tool}」（该服务器没给说明）`,
  } as Tool;
}