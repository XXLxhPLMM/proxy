/**
 * 账号策略索引 - 「用户名 → 该账号的访问控制 / 流量配额」
 *
 * `users.json` 里每个账号可内联 `acl`（三组名单，与 `acl.json` 同构）与 `quota`
 * （流量窗口上限）。本模块把这两样从**账号表快照**里按用户名取出来，供
 * `instance.ts` 装配的 `AccessControlProvider` / `UsageProvider` 每请求查询。
 *
 * 零 IO：快照由调用方从 `users/reader.ts` 取出后传入，本模块只做纯内存索引。
 * 身份查不到时返回 `undefined` —— **「没有策略」不是「拒绝」**：
 *  - 账号不在表里（jwt 模式下 token 的 `sub` 是未知主体、`AUTH_ENABLED=false` 无鉴权）
 *  - 账号在表里但没写 `acl` / `quota`（缺省 = 不额外限制）
 * 两种情况都表示「全局策略说了算」，而不是把请求拒掉。
 *
 * **索引按快照对象身份记忆（`WeakMap`），刻意不建进程级单槽**：多实例下 A/B 各读各的
 * `AUTH_USERS_FILE`，单槽会被两个实例轮流冲掉（退化成每请求重建索引）或让 A 复用 B 的
 * 账号策略（串味）。按快照身份记忆后，「同一路径恒命中同一份索引」由
 * `readJsonCached` 的值身份保证，键随缓存条目淘汰一起回收，无需手工上界。
 */
import type { AuthAccount } from "@/core/types/proxy.js";
import type { AclConfig } from "../acl/schema.js";
import type { UserQuota } from "./schema.js";

/**
 * 单个账号的可选策略
 * @param acl - 该账号自己的访问控制名单（缺省 = 不额外限制，仍受实例级名单约束）
 * @param quota - 该账号的流量配额（缺省 = 不限流量）
 */
export interface AccountPolicy {
  readonly acl?: AclConfig;
  readonly quota?: UserQuota;
}

/** 账号表快照 → (用户名 → 策略) 索引 */
const indexCache = new WeakMap<readonly AuthAccount[], Map<string, AccountPolicy>>();

/**
 * 取（并在缺失时建立）某份账号表快照的策略索引
 * @param accounts - 账号表快照（视为只读；由 `readJsonCached` 保证同路径同身份）
 * @returns 用户名 → 策略的只读索引；无任何策略的账号**不进索引**（查不到即「无策略」）
 */
function indexOf(accounts: readonly AuthAccount[]): ReadonlyMap<string, AccountPolicy> {
  const hit = indexCache.get(accounts);

  if (hit !== undefined) {
    return hit;
  }

  const next = new Map<string, AccountPolicy>();

  for (const account of accounts) {
    // 两个可选字段都没有就不进索引：让「查不到」保持为「无策略」的单一语义
    if (account.acl === undefined && account.quota === undefined) {
      continue;
    }
    next.set(
      account.username,
      account.acl === undefined && account.quota === undefined
        ? {}
        : {
            ...(account.acl === undefined ? {} : { acl: account.acl }),
            ...(account.quota === undefined ? {} : { quota: account.quota }),
          },
    );
  }

  indexCache.set(accounts, next);
  return next;
}

/**
 * 取某账号的访问控制名单
 * @param accounts - 账号表快照
 * @param username - 已鉴权用户名；空串/undefined 视为「无身份」
 * @returns 该账号的内联 `acl` 快照；无身份、账号不存在或未写 `acl` 时 `undefined`
 * @example userAcl(accounts, "alice") // => AclConfig | undefined
 */
export function userAcl(
  accounts: readonly AuthAccount[],
  username: string | undefined,
): AclConfig | undefined {
  return username ? indexOf(accounts).get(username)?.acl : undefined;
}

/**
 * 取某账号的流量配额
 * @param accounts - 账号表快照
 * @param username - 已鉴权用户名；空串/undefined 视为「无身份」
 * @returns 该账号的内联 `quota`；无身份、账号不存在或未写 `quota` 时 `undefined`
 * @example userQuota(accounts, "alice") // => UserQuota | undefined
 */
export function userQuota(
  accounts: readonly AuthAccount[],
  username: string | undefined,
): UserQuota | undefined {
  return username ? indexOf(accounts).get(username)?.quota : undefined;
}

/**
 * 账号表中配置了任一可选策略的账号数（启动摘要用；只报数、不报内容）
 * @param accounts - 账号表快照
 * @returns `{ withAcl, withQuota, total }`
 */
export function accountPolicyCounts(accounts: readonly AuthAccount[]): {
  withAcl: number;
  withQuota: number;
  total: number;
} {
  let withAcl = 0;
  let withQuota = 0;

  for (const account of accounts) {
    if (account.acl !== undefined) {
      withAcl += 1;
    }
    if (account.quota !== undefined) {
      withQuota += 1;
    }
  }

  return { withAcl, withQuota, total: accounts.length };
}
