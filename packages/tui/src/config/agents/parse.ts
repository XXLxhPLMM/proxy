/**
 * @fileoverview agents 一节的校验：`maxSteps`
 * @module config/agents/parse
 * @description 校验从严（同 `loader`）：认不得的项、不是正整数的取值都当场抛——配置错了就是启动错了。
 *
 * ⚠️ **MCP 服务器不在这份配置里**：它在 `mcps` 表（`@/service/mcps.ts` 那一圈）。⚠️ 原来这里
 *   解析过 `mcpServers`，那一份已经删掉——留着它就等于给同一批服务器留了第二个出处，
 *   而两者都写的话，配置里那台被顶掉之后极难查（工具名 `mcp__<id>__<工具>` 里那一段就是它的名字）。
 */

import { assertKeys, requireRecord } from "../guards.js";
import { defaultAgentsConfig } from "./defaults.js";
import type { AgentsConfig } from "./defaults.js";

/** 校验 agents 一节并合上默认值；`maxSteps` 缺省吃默认，给了就必须是 ≥1 的整数 */
export function parseAgentsConfig(raw: unknown, file: string): AgentsConfig {
  const record = requireRecord(raw, file, "agents");
  assertKeys(record, ["maxSteps"], file, "agents");
  const defaults = defaultAgentsConfig();
  const maxSteps = record.maxSteps === undefined ? defaults.maxSteps : parseMaxSteps(record.maxSteps, file);
  return { maxSteps };
}

/** `maxSteps`：≥1 的整数；小数、0、负数、字符串一律抛 */
function parseMaxSteps(raw: unknown, file: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new Error(`${file}：agents.maxSteps 必须是 ≥1 的整数`);
  }
  return raw;
}
