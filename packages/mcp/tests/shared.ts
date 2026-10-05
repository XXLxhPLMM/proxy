/**
 * @fileoverview 台账与工具两档共用的脚手架 —— 临时家目录 + 工具调用入口
 * @module tests/shared
 * @description
 * ⚠️ **家目录靠 `@/tools/host.js` 的 override 隔离**（而不是靠环境变量）：本包刻意不读环境变量
 * 决定位置（见 `@/utils/json-file.js` 的文件头），而测试若走环境变量就等于给那份纪律开了
 * 一个后门 —— 明天有人写「支持 `MCP_HOME`」时，测试会全绿而部署仍然是分裂的。
 *
 * ⚠️ **激活状态是进程级的**，故每个用例前后都要清 —— 否则「这个用例激活了 prod」会漏进下一个
 * 用例，而症状是「一个什么都没做的工具调用报『没有激活的环境』」，与真正的失败毫无相似之处。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "../src/protocol/index.js";
import { deactivateEnv } from "../src/store/index.js";
import { setHomedirOverride } from "../src/tools/host.js";
import { TOOLS } from "../src/tools/index.js";
import { asMcpError } from "../src/utils/errors.js";

const created: string[] = [];

/** 造一个空的临时家目录，并把它指成 `~/.swain-proxy/` 的上级 */
export function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swain-mcp-"));
  created.push(dir);
  setHomedirOverride(dir);
  return dir;
}

/** 回收全部临时目录 + 清激活状态（⚠️ 两者都要：激活状态不随目录一起消失） */
export function cleanupHomes(): void {
  setHomedirOverride(null);
  deactivateEnv();
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function homeFile(home: string, file: string): string {
  return path.join(home, ".swain-proxy", file);
}

/** 按名字找工具（⚠️ 找不到就抛 —— 一个静默返回 `undefined` 的查找器会让测试变成恒绿） */
export function toolNamed(name: string): ToolDefinition {
  const hit = TOOLS.find((one) => one.name === name);
  if (hit === undefined) {
    throw new Error(`没有叫 ${name} 的工具`);
  }
  return hit;
}

export interface CallResult {
  readonly text: string;
  readonly parsed: unknown;
  /** 失败时是 `McpError.toReport()` 的形态 */
  readonly error: string | null;
}

/**
 * 直接调一个工具的 handler（**不经协议层**）
 * @description ⚠️ 这一档只验「工具的 body」，协议层那档（`tools/call` 怎么把结果包成
 * `{content,isError}`）归 `tests/protocol/`。两档分开是因为它们要钉的东西不同，而合在一档里
 * 一失败就分不清是工具算错了还是协议包错了。
 */
export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const tool = toolNamed(name);
  try {
    const text = await tool.handler(args);
    return { text, parsed: parse(text), error: null };
  } catch (err) {
    const report = asMcpError(err).toReport();
    return { text: report, parsed: undefined, error: report };
  }
}

/** 批次结果聚合体（`renderReport` 的输出不是 JSON，故这一档按文本断言） */
export function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
