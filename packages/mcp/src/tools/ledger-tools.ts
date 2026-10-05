/**
 * @fileoverview 本机台账那一族工具（manager 与环境：列 / 增 / 改 / 删 / 激活）
 * @module tools/ledger-tools
 * @description
 * ⚠️ **这些工具一个请求都不发** —— 它们只动 `~/.swain-proxy/` 下那两份 JSON。
 * 而这是**整个工具面里唯一能碰凭据的地方**，所以它有两条专属纪律：
 *
 * ## ① 返回值里**永远没有** key 的明文
 * @description 打码出口是 `redactManager`，它连**长度**都不泄露（固定 `***`）。理由与
 * `@/store/managers.js` 的文件头同族：key 等价于主机上的 root shell，而工具结果逐字进
 * 模型的上下文，也进 provider 那台机器的日志。
 *
 * ## ② ⚠️ **激活状态不落盘**（完整推导见 `@/store/session.js` 的文件头）
 * @description 于是模型每次新会话都要重新 `env_activate`。这不是缺陷而是有意的：
 * 一个**驱动别人机器**的工具不该继承「上次打过哪儿」。
 */

import type { ToolDefinition } from "../protocol/index.js";
import { TIMEOUT_BOUNDS } from "../store/index.js";
import {
  REDACTED_KEY,
  activeEnvName,
  activateEnv,
  addManager,
  createEnv,
  deactivateEnv,
  readEnvs,
  readManagers,
  redactManager,
  removeEnv,
  removeManager,
  setEnvMembers,
  updateManager,
} from "../store/index.js";
import { homedir } from "./host.js";
import { json, noArgs, oneField, type Field } from "./schema.js";
import { McpError } from "../utils/errors.js";
import { optionalNumber, optionalString, readString, readStringArray } from "./args.js";

/** id 那一格（⚠️ 三处 `manager_update` / `manager_remove` / `env_update` 共用同一句措辞） */
const ID_FIELD: Field = { type: "string", description: "manager 的 id（manager_list 看现有的）" };

/** 环境名那一格 */
const ENV_NAME: Field = { type: "string", description: "环境名（唯一）" };

/** 成员 id 那一格 */
const MEMBERS: Field = {
  type: "array",
  items: { type: "string" },
  description: "成员 manager 的 id 数组（id，不是 name）",
};

export const LEDGER_TOOLS: readonly ToolDefinition[] = [
  {
    name: "manager_list",
    description:
      "列出已登记的控制面（id / 名称 / 地址 / 超时）。⚠️ key 只显示为掩码——本工具面**任何地方**" +
      "都拿不到 key 的明文；要换 key 用 manager_update。",
    inputSchema: noArgs(),
    handler: async () => {
      const views = readManagers(homedir()).map(redactManager);
      return json({
        path: "~/.swain-proxy/managers.json",
        activeEnv: activeEnvName(),
        count: views.length,
        managers: views,
        // ⚠️ 空清单也要回一句**说得清的话**，而不是光秃秃的 0
        ...(views.length === 0 ? { hint: "还没有登记任何控制面，先 manager_add" } : {}),
      });
    },
  },
  {
    name: "manager_add",
    description:
      "登记一个控制面（名称 + 地址 + 操作 key）。key 就是那个控制面的 MANAGER_TOKEN，等价于主机上的" +
      "root shell——它会明文存在 ~/.swain-proxy/managers.json（目录 0700 / 文件 0600）。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "显示名（⚠️ 可以重复，id 才是稳定身份）" },
        baseUrl: {
          type: "string",
          description: "控制面地址，如 http://10.0.0.1:8080（不带 scheme 会补 http）",
        },
        key: { type: "string", description: "操作 key（MANAGER_TOKEN）" },
        timeoutMs: {
          type: "number",
          description: `单次请求超时毫秒（${String(TIMEOUT_BOUNDS.min)}–${String(TIMEOUT_BOUNDS.max)}），缺省 30000`,
        },
      },
      required: ["name", "baseUrl", "key"],
    },
    handler: async (args) => {
      const timeoutMs = optionalNumber(args, "timeoutMs");
      const record = addManager(homedir(), {
        name: readString(args, "name"),
        baseUrl: readString(args, "baseUrl"),
        key: readString(args, "key"),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      return json({
        added: redactManager(record),
        note: `key 已按掩码 ${REDACTED_KEY} 记下；本工具面之后拿不到它的明文`,
      });
    },
  },
  {
    name: "manager_update",
    description: "改一个已登记的控制面（名称 / 地址 / key / 超时）。⚠️ id 不可改。",
    inputSchema: {
      type: "object",
      properties: {
        id: ID_FIELD,
        name: { type: "string", description: "新显示名" },
        baseUrl: { type: "string", description: "新地址" },
        key: { type: "string", description: "新操作 key" },
        timeoutMs: { type: "number", description: "新超时毫秒" },
      },
      required: ["id"],
    },
    handler: async (args) => {
      const timeoutMs = optionalNumber(args, "timeoutMs");
      const record = updateManager(homedir(), readString(args, "id"), {
        ...strField(args, "name"),
        ...strField(args, "baseUrl"),
        ...strField(args, "key"),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      return json({ updated: redactManager(record) });
    },
  },
  {
    name: "manager_remove",
    description:
      "删一个已登记的控制面。⚠️ 还被某个环境引用时**会失败**——先 env_update 把那个环境里的它去掉。",
    inputSchema: oneField("id", ID_FIELD),
    handler: async (args) =>
      json({ removed: redactManager(removeManager(homedir(), readString(args, "id"))) }),
  },
  {
    name: "env_list",
    description:
      "列出所有环境（名字 + 成员 id）与当前激活的是哪个。⚠️ 激活只活在**当前进程内存**里——" +
      "重启后归零，每次新会话都要重新 env_activate。",
    inputSchema: noArgs(),
    handler: async () => {
      const envs = readEnvs(homedir());
      const active = activeEnvName();
      return json({
        path: "~/.swain-proxy/envs.json",
        activeEnv: active,
        count: envs.length,
        environments: envs.map((env) => ({ ...env, active: env.name === active })),
        ...(envs.length === 0 ? { hint: "还没有环境，先 env_create" } : {}),
      });
    },
  },
  {
    name: "env_create",
    description: "建一个环境（名字 + 一组 manager 的 **id**）。⚠️ 名字唯一；成员必须已登记。",
    inputSchema: {
      type: "object",
      properties: { name: ENV_NAME, managers: MEMBERS },
      required: ["name", "managers"],
    },
    handler: async (args) => {
      const env = createEnv(homedir(), {
        name: readString(args, "name"),
        managers: readStringArray(args, "managers"),
      });
      return json({ created: env, activeEnv: activeEnvName() });
    },
  },
  {
    name: "env_update",
    description: "改一个环境的成员（⚠️ **整体替换**那些成员，不是增删）。",
    inputSchema: {
      type: "object",
      properties: { name: ENV_NAME, managers: MEMBERS },
      required: ["name", "managers"],
    },
    handler: async (args) => {
      const env = setEnvMembers(
        homedir(),
        readString(args, "name"),
        readStringArray(args, "managers"),
      );
      return json({ updated: env, activeEnv: activeEnvName() });
    },
  },
  {
    name: "env_remove",
    description: "删一个环境。⚠️ 正在激活的那个**不许删**——先 env_deactivate。",
    inputSchema: oneField("name", ENV_NAME),
    handler: async (args) =>
      json({ removed: removeEnv(homedir(), readString(args, "name")), activeEnv: activeEnvName() }),
  },
  {
    name: "env_activate",
    description:
      "**激活**一个环境——之后所有操作类工具（不给 managers 时）默认只动这个环境里的那些 manager。" +
      "⚠️ 激活只活在当前进程内存里，重启后归零。",
    inputSchema: oneField("name", ENV_NAME),
    handler: async (args) => {
      const name = readString(args, "name");
      const envs = readEnvs(homedir());
      const hit = envs.find((one) => one.name === name);
      if (hit === undefined) {
        // ⚠️ **当场验存在**而不在 `activateEnv` 里：激活本身零 IO 是 `@/store/session.js` 的
        // 设计（它只存名字），而模型需要的是「你要激活的那个环境不存在」这一句，
        // 不是「激活成功了但下一个调用用不了」
        throw McpError.local(
          `没有叫 ${name} 的环境（现有的是：${envs.map((one) => one.name).join("、") || "（一个都没有）"}）`,
        );
      }
      activateEnv(name);
      return json({
        activeEnv: name,
        managers: hit.managers,
        note: "之后不给 managers 的操作类工具只动上面这些 manager",
      });
    },
  },
  {
    name: "env_deactivate",
    description: "取消激活。之后操作类工具不给 managers 会**报错**（不会静默变成「动全部」）。",
    inputSchema: noArgs(),
    handler: async () => {
      deactivateEnv();
      return json({ activeEnv: null });
    },
  },
];

/** 只有给了值才带上那个键（⚠️ `manager_update` 与服务端同一条纪律：没给 ≠ 清空） */
function strField(
  args: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const value = optionalString(args, key);
  return value === undefined ? {} : { [key]: value };
}
