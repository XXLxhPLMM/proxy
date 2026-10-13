/**
 * @fileoverview 一台 MCP 服务器的**活会话**：连上它 + 把它的工具登记进 `ctx.tools` + 收干净
 * @module agents/mcp/session
 * @description
 * 「活」是这个文件存在的全部理由：{@link McpSession} 是**可重启的最小单位**——`restart` 一台服务器
 * 就是 `close()` 掉这个会话再开一个新的，而**不是**在旧连接上增量改几���工具。
 * 原因在 `McpServerConfig` 的服务器那头：它宣告多少条工具**随时间变**，所以「重启」必然是全量换一批。
 *
 * ⚠️ 本文件只管**一台**；一批（配置表 / 运行期注册 / 重载）归 `starter/plugins/mcp/`。
 *   两边不重叠：会话不知道自己属于谁，管的是「起 → 登记 → 收」。
 *
 * ⚠️ **连接与工具的生杀必须绑在一个对象上**：`@/agents/mcp/connection.ts` 只管连上，
 *   「登记的那些工具怎么一起摘掉」只有这里知道 ⇒ 拆开就会出现「工具还在、连接没了」的死工具。
 */

import type { Context } from "cordis";
import type { Tool } from "ai";
import type { McpServerConfig } from "@/config/agents/defaults.js";
import { connectMcpServer, type ConnectMcpOptions, type McpToolSet } from "./connection.js";
import { isRegistrableToolName, mcpToolName } from "./naming.js";

/** 一台服务器的活会话 */
export interface McpSession {
  /** 配置里的服务器名（工具名里那一段就是它） */
  readonly server: string;
  /** 它自报的名字与版本（如 `filesystem 1.0.6`） */
  readonly serverInfo: string;
  /** 已登记进注册表的工具键（**含 `mcp__` 前缀**），按登记序 */
  readonly toolNames: readonly string[];
  /** 登记不上的工具**它自己的名字**（前缀后那半截）；空 = 这台的工具全上来了 */
  readonly skipped: readonly string[];
  /** 收尾：先退订全部工具、再关连接（幂等） */
  close(): Promise<void>;
}

/**
 * 起一台服务器并把它的工具登记进 `ctx.tools`。
 * @param ctx - `ctx.tools` 是登记口，`ctx.logger` 是唯一的话出口
 * @param server - 服务器名（进工具名与日志；形状的判据见 `naming.ts`，配置与运行期注册共用那一条）
 * @param config - 怎么起它（见 `McpServerConfig`）
 * @param options - 见 `ConnectMcpOptions`
 * @throws 这台起不来 / 起超时。⚠️ **抛之前不登记任何工具**（登记发生在连上之后），
 *   所以「抛了」这个形状天然就是「这台什么都没有」，不留半拉子。
 * @description ⚠️ 一条工具登记不上**不牵连这台服务器**（记一条 `warn` 跳过，理由见文件内注释），
 *   但 `McpSession.skipped` 会点名它们是谁——静默丢工具等于让人以为「这服务器就这么点能力」。
 */
export async function openMcpSession(
  ctx: Context,
  server: string,
  config: McpServerConfig,
  options: ConnectMcpOptions = {},
): Promise<McpSession> {
  const connection = await connectMcpServer(ctx, server, config, options);
  const offTools: (() => void)[] = [];
  const toolNames: string[] = [];
  const skipped: string[] = [];

  for (const [toolName, mcpTool] of Object.entries(connection.tools)) {
    const name = mcpToolName(server, toolName);
    // ⚠️ 工具名是第三方给的，拼完仍可能带空白（`registerTool` 会拒收）。
    //   **跳过这一条**而不是让整台哑掉：丢一条工具好过丢十几个。
    if (!isRegistrableToolName(name)) {
      ctx.logger.warn("MCP 服务器「%s」的工具「%s」拼出的名字不合法（%s），已跳过", server, toolName, name);
      skipped.push(toolName);
      continue;
    }
    try {
      // ⚠️ 走 `ctx.tools.register`（不是直接调注册表）：那是**别的插件在运行期加工具**的正路，
      //   会发 `tools.register.*` 事件，UI 才知道「凭空多了哪些工具」。
      //   收的是**造好的**工具，所以回调直接把它交出去，`tool` / `z` 两个入参用不上。
      const off = ctx.tools.register(name, () => described(asRegistryTool(mcpTool), server, toolName));
      offTools.push(off);
      toolNames.push(name);
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
    server,
    serverInfo: connection.serverInfo,
    toolNames,
    skipped,
    close: async () => {
      // ⚠️ **先退订工具、再关连接**：反过来的话，从「模型正在调它」到「连接没了」之间有个窗口，
      //   那一次调用会撞上一个正在关闭的客户端，错误信息还很难认。
      //   `splice(0)` 是取干净并就地清空 ⇒ `close()` 天然幂等（第二次调用拿到空数组）。
      for (const off of offTools.splice(0)) off();
      await connection.close().catch(() => undefined);
    },
  };
}

/**
 * 把 MCP 给的那条工具当成注册表认的那种 `Tool`。
 * ⚠️ 这个断言是**类型层面的噪声，不是真的不兼容**：`@ai-sdk/mcp` 的工具集是
 *   `Tool<unknown, CallToolResult> & {…}`，`inputSchema` 落在 `FlexibleSchema<unknown>` 上；
 *   而 `ai` 的 `Tool` 缺省是 `Tool<any, any>`，`Schema` 上那个 `[schemaSymbol]` 常量让 TS 判成
 *   不协变。**两边是同一代 API 的同一个 `Tool`**，接不上是类型定义的措辞问题，不是行为问题。
 * 真跑不跑得起来由紧跟着的 `registerTool` 判（它查 `execute` 是不是函数），不由类型判 ——
 * 所以这个断言是**有运行时兜底**的，不是把检查关掉。
 */
function asRegistryTool(mcpTool: McpToolSet[string]): Tool {
  return mcpTool as unknown as Tool;
}

/**
 * 交出去登记前补一句说明。
 * ⚠️ MCP 规范里工具的 `description` 是**可选**的，而 `defineTool` 硬要非空（模型靠它判断该不该调，
 *   理由见 `@/agents/tools/index.js`）。不给它兜一句，这台服务器的工具就会**整条都登记不上**。
 *   这里**如实说清「这是什么、谁给的」**，不替第三方编功能——那只会把模型引到错误的期待上。
 *
 * ⚠️ 下面那个 `as Tool` 同 {@link asRegistryTool}：只是把 `description` 填回它**本来就可选**的
 *   字段，形状没变；不写它是因为展开一个联合类型后 TS 认不回是哪个成员。
 */
function described(mcpTool: Tool, server: string, tool: string): Tool {
  if (typeof mcpTool.description === "string" && mcpTool.description !== "") return mcpTool;
  const description = `MCP 服务器「${server}」提供的工具「${tool}」（该服务器没给说明）`;
  return { ...mcpTool, description } as Tool;
}