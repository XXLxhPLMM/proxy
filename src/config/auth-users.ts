/**
 * 用户账号文件 - 多账号登录的配置来源
 * 职责：
 * - 校验 users.json 结构（`[{ username, password }]`），非法即返回 undefined
 * - 经 utils/json-file 做 mtime 节流热加载，供鉴权每请求读取（走缓存，不额外 IO）
 * 设计：
 * - 用户名必须非空且不含 `:`（Basic 凭证是 `user:pass`，含冒号会产生歧义）
 * - 密码允许空串：uid 模式（socks4 USERID）只用用户名
 * - 文件缺失 = 空账号表（是否放行由 loader 的 assertAuthConfig 决定）；内容非法 = 保留上一份有效值
 * - 返回值视为只读，调用方不得原地修改（缓存共享同一实例）
 * - 配置经端口注入：`readAuthUsers` 的 `opts.config` 缺省读全局单例 `get("authUsersFile")`（行为与改造前一致），
 *   库模式多实例时由 core 注入私有 store 派生的访问器，使各实例读各自的账号文件
 */

import { globalConfigAccessor, type ConfigAccessor } from "@/core/config-access.js";
import type { AuthAccount } from "@/core/types/proxy.js";
import { readJsonCached, type JsonFileRead } from "@/utils/json-file.js";
import { logJsonFileEvent } from "./json-file-log.js";

/** 空账号表（只读哨兵，文件缺失时使用） */
const EMPTY_ACCOUNTS: AuthAccount[] = [];

/** users.json 允许的字段名 */
const ACCOUNT_KEYS = new Set(["username", "password"]);

/**
 * 校验账号文件内容
 * @param raw - JSON.parse 结果
 * @returns 合法时返回账号数组（顺序保留），非法返回 undefined
 */
export function validateAuthUsers(raw: unknown): AuthAccount[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const seen = new Set<string>();
  const out: AuthAccount[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return undefined;
    }
    if (Object.keys(item).some((k) => !ACCOUNT_KEYS.has(k))) {
      return undefined;
    }
    const { username, password } = item as { username?: unknown; password?: unknown };
    if (typeof username !== "string" || !username || username.includes(":")) {
      return undefined;
    }
    if (typeof password !== "string") {
      return undefined;
    }
    if (seen.has(username)) {
      return undefined;
    }
    seen.add(username);
    out.push({ username, password });
  }

  return out;
}

/**
 * 读取账号文件（带节流缓存）
 * @param opts.force - 跳过节流强制重读（启动期校验用）
 * @param opts.path - 显式路径覆盖（initConfig 写 store 之前用解析值校验时必须传）
 * @param opts.config - 配置访问器，缺省 `globalConfigAccessor`（读全局单例的 `authUsersFile`，行为与改造前一致）；
 *   库模式多实例时传入 `configAccessorFromStore(runtimeStore)` 以读该实例自己的账号文件
 * @returns 读取结果：value 为生效账号表，error 为最近一次失败原因
 */
export function readAuthUsers(opts?: {
  force?: boolean;
  path?: string;
  config?: ConfigAccessor;
}): JsonFileRead<AuthAccount[]> {
  const path = opts?.path ?? (opts?.config ?? globalConfigAccessor).get("authUsersFile");
  return readJsonCached(path, validateAuthUsers, {
    label: "用户账号文件",
    fallback: EMPTY_ACCOUNTS,
    force: opts?.force,
    onEvent: logJsonFileEvent,
  });
}

/**
 * 取当前生效账号表（供鉴权与凭据剥离使用）
 * @param config - 配置访问器，缺省 `globalConfigAccessor`（读全局单例，行为与改造前一致）
 * @returns 账号数组（只读）；文件缺失或非法时为空数组/上一份有效值
 */
export function loadAuthUsers(config: ConfigAccessor = globalConfigAccessor): AuthAccount[] {
  return readAuthUsers({ config }).value;
}
