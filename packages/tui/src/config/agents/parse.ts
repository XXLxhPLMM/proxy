/**
 * @fileoverview agents 一节的校验：只认 `maxSteps`，缺项吃默认
 * @module config/agents/parse
 * @description 校验从严（同 `loader`）：认不得的项、不是正整数的取值都当场抛——配置错了就是启动错了。
 */

import { assertKeys, requireRecord } from "../guards.js";
import { defaultAgentsConfig } from "./defaults.js";
import type { AgentsConfig } from "./defaults.js";

/** 校验 agents 一节并合上默认值；`maxSteps` 缺省吃默认，给了就必须是 ≥1 的整数 */
export function parseAgentsConfig(raw: unknown, file: string): AgentsConfig {
  const record = requireRecord(raw, file, "agents");
  assertKeys(record, ["maxSteps"], file, "agents");
  const maxSteps = record.maxSteps;
  if (maxSteps === undefined) return defaultAgentsConfig();
  if (typeof maxSteps !== "number" || !Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error(`${file}：agents.maxSteps 必须是 ≥1 的整数`);
  }
  return { maxSteps };
}