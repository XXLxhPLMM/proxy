/**
 * @fileoverview MCP 一圈的出口：一台的会话 + 连接那一层 + 命名规则
 * @module agents/mcp
 * @description ⚠️ `agents/tools/` 是**深路径直引**的（`./index.js` / `./shell.js`），本目录对外只留这一个
 *   出口给别的目录用；本目录内部几份文件之间互引也走相对路径（`./session.js` 这种），别自我引本 barrel。
 *
 * ⚠️ 这里只出「**一台**的机制」。「一批」（配置表 / 运行期注册 / 重启 / 重载）归
 *   `starter/plugins/mcp/`——两边不共享状态，重叠就会出两份真值。
 */

export { openMcpSession } from "./session.js";
export type { McpSession } from "./session.js";
export { connectMcpServer } from "./connection.js";
export type { ConnectMcpOptions, McpConnection, McpToolSet } from "./connection.js";
export { isRegistrableToolName, isValidServerName, mcpToolName, SERVER_NAME_PATTERN } from "./naming.js";