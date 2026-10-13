/**
 * @fileoverview agents 一节的校验：`maxSteps` 与 `mcpServers`
 * @module config/agents/parse
 * @description 校验从严（同 `loader`）：认不得的项、不是正整数的取值都当场抛——配置错了就是启动错了。
 *
 * ⚠️ **`mcpServers` 这一格有两个本文件**抓不到**的盲区，写在这里免得日后当成不存在**：
 *   - **重名的服务器**：JSON 自身允许重复键，而 `JSON.parse` 静默保留**最后一个** ⇒ 等本文件
 *     拿到对象时重复已经消失，配置里写两遍同一个服务器名不会报错，只是前面那份被悄悄丢掉。
 *   - **重名的工具**：那是服务器那头的事，配置看不见，见 `@/agents/mcp/loader.js`。
 *   两者的挡法分别在 `mcp__` 前缀（让工具键结构上唯一）与服务器名不许含 `__`（让前缀可分）。
 */

import { assertKeys, requireRecord, requireString } from "../guards.js";
import { isValidServerName } from "@/agents/mcp/naming.js";
import { defaultAgentsConfig } from "./defaults.js";
import type { AgentsConfig, McpServerConfig } from "./defaults.js";

/** 校验 agents 一节并合上默认值；`maxSteps` 缺省吃默认，给了就必须是 ≥1 的整数 */
export function parseAgentsConfig(raw: unknown, file: string): AgentsConfig {
  const record = requireRecord(raw, file, "agents");
  assertKeys(record, ["maxSteps", "mcpServers"], file, "agents");
  const defaults = defaultAgentsConfig();
  const maxSteps = record.maxSteps === undefined ? defaults.maxSteps : parseMaxSteps(record.maxSteps, file);
  const mcpServers = record.mcpServers === undefined ? defaults.mcpServers : parseMcpServers(record.mcpServers, file);
  return { maxSteps, mcpServers };
}

/** `maxSteps`：≥1 的整数；小数、0、负数、字符串一律抛 */
function parseMaxSteps(raw: unknown, file: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new Error(`${file}：agents.maxSteps 必须是 ≥1 的整数`);
  }
  return raw;
}

/** `mcpServers`：一张「服务器名 → 怎么起」的表；缺项吃默认（空表） */
function parseMcpServers(raw: unknown, file: string): Readonly<Record<string, McpServerConfig>> {
  const record = requireRecord(raw, file, "agents.mcpServers");
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(record)) {
    // ⚠️ 服务器名会进工具名 `mcp__<名>__<工具>`，形状的判据只有一处（`@/agents/mcp/naming.js`）：
    //   这里不合规就抛，别自己再写一条正则——两处规则一旦分叉，工具名就对不上了。
    if (!isValidServerName(name)) {
      throw new Error(
        `${file}：agents.mcpServers 的服务器名 ${JSON.stringify(name)} 不合法` +
          "（须字母或数字开头，其余为字母数字 / _ / . / -，且不许含 __ —— 它是工具名 mcp__<服务器名>__<工具> 的分界）",
      );
    }
    servers[name] = parseMcpServer(value, file, name);
  }
  return servers;
}

/** 一台服务器：`command` 必填非空，`args` / `env` / `cwd` 可选，其余键不认 */
function parseMcpServer(raw: unknown, file: string, name: string): McpServerConfig {
  const where = `agents.mcpServers."${name}"`;
  const record = requireRecord(raw, file, where);
  assertKeys(record, ["command", "args", "env", "cwd"], file, where);
  const args = record.args === undefined ? [] : parseArgs(record.args, file, where);
  const env = record.env === undefined ? undefined : parseEnv(record.env, file, where);
  const cwd = record.cwd === undefined ? undefined : requireString(record.cwd, file, `${where}.cwd`);
  return { command: requireString(record.command, file, `${where}.command`), args, env, cwd };
}

/** `args`：数组，每项非空字符串（空串传给 spawn 没有意义，只会拼出更难查的错） */
function parseArgs(raw: unknown, file: string, where: string): readonly string[] {
  if (!Array.isArray(raw)) throw new Error(`${file}：${where}.args 必须是字符串数组`);
  return raw.map((item, index) => requireString(item, file, `${where}.args[${index}]`));
}

/**
 * `env`：键值都必须是字符串。
 * ⚠️ 值只收字符串、不收数字与布尔：环境变量本来就是字符串，配置里写 `{"PORT": 3000}` 看着无害，
 *   但 spawn 的 `env` 会被 `String()` 静默转掉，与本包其它地方「类型不对就当场抛」的调子相反。
 */
function parseEnv(raw: unknown, file: string, where: string): Readonly<Record<string, string>> {
  const record = requireRecord(raw, file, `${where}.env`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") throw new Error(`${file}：${where}.env.${key} 必须是字符串`);
    env[key] = value;
  }
  return env;
}