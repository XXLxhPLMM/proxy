/**
 * @fileoverview 操作控制面的那批工具（12 个，按资源切）
 * @module tools/manager-tools
 * @description
 * 一个工具 = 一条控制面端点（或一组同形端点）。⚠️ **不做「一个万能工具」**：参数会变成一个大
 * union，模型要在其中猜一组，而写操作猜错就是改错了地方。
 *
 * 每个工具的 body 都是同一个形状：`fanOut`（解 targets → 逐个跑 → 聚合）。
 *
 * ⚠️ **`homedir()` 在每次调用时取，不在模块加载时取**：工具表在进程启动时组装的，而单测
 * 正是靠「每个用例给一个临时 home」隔离台账的 —— 取一次就固化了等于所有用例共用一份。
 */

import {
  ACL_GROUPS,
  ACL_LISTS,
  QUOTA_WINDOWS,
  addAclEntry,
  createAccount,
  deleteAccount,
  getAccount,
  getAcl,
  getConfig,
  getStatus,
  getUsage,
  getUsageFor,
  listAccounts,
  removeAclEntry,
  updateAccount,
  type AccountCreateInput,
  type AccountUpdateInput,
  type AclMutationInput,
} from "../api/index.js";
import type { ToolDefinition } from "../protocol/index.js";
import { McpError } from "../utils/errors.js";
import { homedir } from "./host.js";
import { fanOut, onTarget, renderReport } from "./batch.js";
import { withManagers, type Field } from "./schema.js";
import {
  compact,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  optionalString,
  optionalStringArray,
  readEnum,
  readString,
} from "./args.js";

/** 账号名那一格（⚠️ 逐字共用同一个对象 —— 它是常量，四处各写一遍就有第四种措辞） */
const USERNAME: Field = { type: "string", description: "账号名" };

/** 密码那一格 */
const PASSWORD: Field = {
  type: "string",
  description: "密码（明文写入对面。这是控制面上唯一能设密码的地方）",
};

/** 配额那一格（⚠️ `0` = 不限流，而那是**合法值** —— 判据里有它，见 `@/tools/args.js`） */
const QUOTA_BYTES: Field = { type: "number", description: "配额字节数；0 = 不限流" };

/** 配额窗口那一格 */
const QUOTA_WINDOW: Field = {
  type: "string",
  enum: [...QUOTA_WINDOWS],
  description: "配额窗口，或 clear = 清零",
};

/** 过期那一格 */
const EXPIRES: Field = { type: "string", description: "过期时间（ISO 串），或 clear = 永不过期" };

/** 禁用那一格 */
const DISABLED: Field = { type: "boolean", description: "是否禁用这个账号" };

/** 个人名单两格（⚠️ **整体替换**，不是增删 —— 与服务端 `PUT` 的语义一致） */
const TARGET_WHITELIST: Field = {
  type: "array",
  items: { type: "string" },
  description: "该账号的目标白名单（整体替换）",
};
const TARGET_BLACKLIST: Field = {
  type: "array",
  items: { type: "string" },
  description: "该账号的目标黑名单（整体替换）",
};

/** 名单分组与方向那两格 */
const GROUP: Field = {
  type: "string",
  enum: [...ACL_GROUPS],
  description: "名单分组：客户端 IP / 目标 / 上游",
};
const LIST: Field = {
  type: "string",
  enum: [...ACL_LISTS],
  description: "白名单还是黑名单",
};
const ENTRY: Field = { type: "string", description: "那一条规则（如 1.2.3.4、example.com、:8080）" };

/** 账号写的七个可改字段（**增与改共用** —— 两者只有 username 与 password 是必填的差别） */
const ACCOUNT_PATCH_FIELDS: Record<string, Field> = {
  quotaBytes: QUOTA_BYTES,
  quotaWindow: QUOTA_WINDOW,
  expiresAt: EXPIRES,
  disabled: DISABLED,
  targetWhitelist: TARGET_WHITELIST,
  targetBlacklist: TARGET_BLACKLIST,
};

export const MANAGER_TOOLS: readonly ToolDefinition[] = [
  {
    name: "status",
    description: "看服务进程与代理的现状（进程 / 数据面在不在跑 / 数据源落在哪）。",
    inputSchema: withManagers({}, []),
    handler: (args) =>
      fanOut(homedir(), args["managers"], (t) => onTarget(t, getStatus)).then(renderReport),
  },
  {
    name: "config",
    description:
      "读配置（每个键的相位 / 是否需要重启 / 是否已打码 / 来源）。⚠️ **只有读**——控制面没有写配置的端点；" +
      "改配置要改 env 文件并重启那个进程。给了 key 就只看那一个键。",
    inputSchema: withManagers(
      { key: { type: "string", description: "只看这一个配置键" } },
      [],
    ),
    handler: (args) => {
      const key = optionalString(args, "key");
      return fanOut(homedir(), args["managers"], async (t) => {
        const body = await onTarget(t, getConfig);
        if (key === undefined) {
          return body;
        }
        const hit = body.keys.filter((one) => one.key === key);
        if (hit.length === 0) {
          throw McpError.local(`这个 manager 上没有键 ${key}`);
        }
        // ⚠️ `summary` 是**全量**那份的统计：它此刻描述的是全部键，不是筛出来的那一个 ——
        // 让模型自己去数 `keys.length` 反而会与它对不上。
        return { configDir: body.configDir, keys: hit, summary: body.summary };
      }).then(renderReport);
    },
  },
  {
    name: "account_list",
    description: "列出账号（⚠️ 明文密码永不回来，只回「设没设」）。",
    inputSchema: withManagers({}, []),
    handler: (args) =>
      fanOut(homedir(), args["managers"], (t) => onTarget(t, listAccounts)).then(renderReport),
  },
  {
    name: "account_get",
    description: "看一个账号的详情（配额 / 过期 / 它的个人名单）。",
    inputSchema: withManagers({ username: USERNAME }, ["username"]),
    handler: (args) => {
      const username = readString(args, "username");
      return fanOut(homedir(), args["managers"], (t) =>
        onTarget(t, (http) => getAccount(http, username)),
      ).then(renderReport);
    },
  },
  {
    name: "account_create",
    description:
      "新建账号。⚠️ 撞名会失败（那是 409）——改已有账号请用 account_update，别用「先删再建」。",
    inputSchema: withManagers(
      { username: USERNAME, password: PASSWORD, ...ACCOUNT_PATCH_FIELDS },
      ["username", "password"],
    ),
    handler: (args) => {
      const input = {
        username: readString(args, "username"),
        password: readString(args, "password"),
        ...optionalPatch(args),
      } as unknown as AccountCreateInput;
      return fanOut(homedir(), args["managers"], (t) =>
        onTarget(t, (http) => createAccount(http, input)),
      ).then(renderReport);
    },
  },
  {
    name: "account_update",
    description:
      "改一个账号。⚠️ 至少要给一个字段；⚠️ **没给的字段保持原样**，而 clear / 空数组才是清空。",
    inputSchema: withManagers({ username: USERNAME, password: PASSWORD, ...ACCOUNT_PATCH_FIELDS }, [
      "username",
    ]),
    handler: (args) => {
      const username = readString(args, "username");
      // ⚠️ `password` **也要过 compact**：直接写 `{password: optionalString(...)}` 时那个键
      // 恒存在（值是 `undefined`），而 `Object.keys` 数的是**键**，于是「一个字段都没给」
      // 会被算成有一个 —— 空 patch 的本地闸门恒不触发，请求带着 `{}` 打出去再被服务端 400 回来。
      const patch = compact({ password: optionalString(args, "password"), ...optionalPatch(args) });
      if (Object.keys(patch).length === 0) {
        // 判据与服务端那道 400 对齐，但**本地先答**是为了省掉一次注定失败的跨机请求
        throw McpError.local("至少要给一个要改的字段");
      }
      return fanOut(homedir(), args["managers"], (t) =>
        onTarget(t, (http) => updateAccount(http, username, patch as unknown as AccountUpdateInput)),
      ).then(renderReport);
    },
  },
  {
    name: "account_delete",
    description: "删一个账号（⚠️ 这条删掉账号表里的记录，运行中的代理最迟 1 秒后读到）。",
    inputSchema: withManagers({ username: USERNAME }, ["username"]),
    handler: (args) => {
      const username = readString(args, "username");
      return fanOut(homedir(), args["managers"], (t) =>
        onTarget(t, (http) => deleteAccount(http, username)),
      ).then(renderReport);
    },
  },
  {
    name: "acl_get",
    description: "读整份名单（clientip / target / upstream 三个组，白黑两个方向）。⚠️ 这是**全局**名单，账号各自的那份在 account_get 里。",
    inputSchema: withManagers({}, []),
    handler: (args) =>
      fanOut(homedir(), args["managers"], (t) => onTarget(t, getAcl)).then(renderReport),
  },
  {
    name: "acl_add",
    description: "给名单加一条。⚠️ 幂等：已经有了会回「没变」而**不是**报错——那是一次成功的 no-op。",
    inputSchema: withManagers({ group: GROUP, list: LIST, entry: ENTRY }, [
      "group",
      "list",
      "entry",
    ]),
    handler: (args) => {
      const input = aclInput(args);
      return fanOut(homedir(), args["managers"], (t) =>
        onTarget(t, (http) => addAclEntry(http, input)),
      ).then(renderReport);
    },
  },
  {
    name: "acl_remove",
    description: "从名单移一条。⚠️ 幂等：本来就没有会回「没变」而**不是**报错。",
    inputSchema: withManagers({ group: GROUP, list: LIST, entry: ENTRY }, [
      "group",
      "list",
      "entry",
    ]),
    handler: (args) => {
      const input = aclInput(args);
      return fanOut(homedir(), args["managers"], (t) =>
        onTarget(t, (http) => removeAclEntry(http, input)),
      ).then(renderReport);
    },
  },
  {
    name: "usage_list",
    description:
      "各账号当前窗口的用量。⚠️ 这是**账本此刻记着的数**，运行中的代理读自己的进程内镜像，最多落后一个落盘周期；" +
      "且本工具**不能清账**。",
    inputSchema: withManagers({}, []),
    handler: (args) =>
      fanOut(homedir(), args["managers"], (t) => onTarget(t, getUsage)).then(renderReport),
  },
  {
    name: "usage_get",
    description: "看一个账号当前窗口的用量（⚠️ 账本从没记过这个账号会 404，那是「没有」不是「坏了」）。",
    inputSchema: withManagers({ username: USERNAME }, ["username"]),
    handler: (args) => {
      const username = readString(args, "username");
      return fanOut(homedir(), args["managers"], (t) =>
        onTarget(t, (http) => getUsageFor(http, username)),
      ).then(renderReport);
    },
  },
];

/**
 * 账号写的那些可改字段（⚠️ **只拼给了的键** —— 服务端对未知键与 `null` 都是 400，
 * 而 `undefined` 与「显式清空」在账号写面上是两种不同操作）
 */
function optionalPatch(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return compact({
    quotaBytes: optionalNumber(args, "quotaBytes"),
    quotaWindow: optionalEnum(args, "quotaWindow", QUOTA_WINDOWS),
    expiresAt: optionalString(args, "expiresAt"),
    disabled: optionalBoolean(args, "disabled"),
    targetWhitelist: optionalStringArray(args, "targetWhitelist"),
    targetBlacklist: optionalStringArray(args, "targetBlacklist"),
  });
}

function aclInput(args: Readonly<Record<string, unknown>>): AclMutationInput {
  return {
    group: readEnum(args, "group", ACL_GROUPS),
    list: readEnum(args, "list", ACL_LISTS),
    entry: readString(args, "entry"),
  };
}
