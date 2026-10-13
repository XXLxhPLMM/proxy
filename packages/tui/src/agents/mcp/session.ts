/**
 * @fileoverview 一台 MCP 服务器的**活会话**：连上它 + 把它的工具搬进 `ctx.tools` + 收干净
 * @module agents/mcp/session
 * @description
 * 「活」是这个文件存在的全部理由：{@link McpSession} 是**可重启的最小单位**——重启一台就是 `close()` 掉这个
 * 会话再开一个新的，而不是在旧连接上增量改几条工具（服务器宣告多少条工具随时间变，而会话登记的那些是一次性
 * 挂上去的 ⇒ 重启必然是全量换一批）。本文件只管一台，一批归 `./manager.js`。
 */

import type { Context } from "cordis";
import type { McpConnectionConfig } from "@/db/dto/mcp.js";
import { connectMcpServer, type ConnectMcpOptions } from "./connection.js";
import { registerSessionTools } from "./session-tools.js";

/** 一台服务器的活会话 */
export interface McpSession {
  /** 服务器名（`mcps.id`；工具名里那一段就是它） */
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
 * @throws 这台起不来 / 起超时。⚠️ **抛之前不登记任何工具**（登记发生在连上之后），所以「抛了」这个形状
 *   天然就是「这台什么都没有」，不留半拉子。
 * @description ⚠️ 一条工具登记不上**不牵连这台服务器**（理由见 `session-tools.ts`），但
 *   {@link McpSession.skipped} 会点名它们是谁。
 */
export async function openMcpSession(
  ctx: Context,
  server: string,
  config: McpConnectionConfig,
  options: ConnectMcpOptions = {},
): Promise<McpSession> {
  // ⚠️ 先连上再登记：反过来的话就有「登记了一部分工具却没有连接」那种形状
  const connection = await connectMcpServer(ctx, server, config, options);
  const tools = registerSessionTools(ctx, server, connection.tools);

  return {
    server,
    serverInfo: connection.serverInfo,
    toolNames: tools.names,
    skipped: tools.skipped,
    close: async () => {
      // ⚠️ **先退订工具、再关连接**：反过来的话，从「模型正在调它」到「连接没了」之间有个窗口，那一次调用
      //   会撞上一个正在关闭的客户端，错误信息还很难认。
      tools.unsubscribeAll();
      await connection.close().catch(() => undefined);
    },
  };
}