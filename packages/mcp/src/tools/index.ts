/**
 * @fileoverview 工具表 —— 本包对模型暴露的全部工具的唯一出口
 * @module tools/index
 * @description
 * ⚠️ **清单类与操作类工具顺序对模型可见**：台账在前（manager / env），操作在后。而 `tools/list`
 * 返回的顺序就是客户端面板里的顺序，模型在补全提示里先看到的那几个也是它们。
 */

import type { ToolDefinition } from "../protocol/index.js";
import { LEDGER_TOOLS } from "./ledger-tools.js";
import { MANAGER_TOOLS } from "./manager-tools.js";

/** 全部工具（⚠️ 启动时组装一次，故 `homedir()` 不在这里取 —— 见 `@/tools/host.js`） */
export const TOOLS: readonly ToolDefinition[] = [...LEDGER_TOOLS, ...MANAGER_TOOLS];

export { LEDGER_TOOLS } from "./ledger-tools.js";
export { MANAGER_TOOLS } from "./manager-tools.js";
