/**
 * @fileoverview MCP 一圈的出口：一台的机制（连上 / 登记 / 收）+ 一批的管理（表 / 判定 / 对表）
 * @module agents/mcp
 * @description
 * ⚠️ **`agents/tools/` 是深路径直引的**（`./index.js` / `./shell.js`），本目录对外只留这一个出口给
 *   别的目录用；本目录内部几份文件之间互引走相对路径（`./session.js` 这种），别自我引本 barrel。
 *
 * ## 这一圈的文件（每份各有各的理由，见各自文件头）
 * 一台：`naming.ts` 命名（零依赖）→ `transport.ts` 三档配置到 SDK 两条路 → `stderr.ts` 子进程 stderr →
 *   `connection.ts` 连一台 → `session-tools.ts` 搬工具进 `ctx.tools` → `session.ts` 一台的活会话
 * 一批：`status.ts` 一台的两个形状 → `plan.ts` 对表的**纯判定** → `manager.ts` **那个类**（表 + 串行队列 +
 *   起关重开对表），`ctx.mcp` 的实现；插件那边只剩**装配**：new 出来 provide 上去、装载时对表、卸载时收掉。
 */

export { McpManager } from "./manager.js";
export type { McpChanges } from "./manager.js";
export type { McpDraft } from "@/db/dto/index.js";
export { planMcp } from "./plan.js";
export type { McpDesired, McpPlan } from "./plan.js";
export { toStatus } from "./status.js";
export type { McpEntry, McpServerState, McpServerStatus } from "./status.js";
export { openMcpSession } from "./session.js";
export type { McpSession } from "./session.js";
export { registerSessionTools } from "./session-tools.js";
export type { RegisteredTools } from "./session-tools.js";
export { connectMcpServer } from "./connection.js";
export type { ConnectMcpOptions, McpConnection, McpToolSet } from "./connection.js";
export { buildTransport, isStdio } from "./transport.js";
export type { McpTransport } from "./transport.js";
export {
  assertValidServerName,
  isRegistrableToolName,
  isValidServerName,
  mcpToolName,
  serverNameReason,
  SERVER_NAME_PATTERN,
} from "./naming.js";
