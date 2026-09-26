/**
 * users.json 结构校验 - 纯函数，零 IO
 *
 * 只回答「这份 JSON.parse 结果是不是合法的账号表」，不认识路径、不读文件、
 * 不做缓存。读盘与缓存语义在 `reader.ts`，按账号取策略在 `policy.ts`。
 *
 * 校验规则：
 * - 用户名必须非空且不含 `:`（Basic 凭证是 `user:pass`，含冒号会产生歧义）
 * - 密码允许空串：uid 模式（socks4 USERID）只用用户名
 * - 用户名不得重复（重复账号表在鉴权时只会命中第一条，是配置错误而非可容忍的输入）
 * - `acl` 可选，缺省 = 该账号不额外限制；形状与 `acl.json` 顶层**完全同构**，
 *   因此直接复用 `acl/schema.ts:validateAcl`——**不维护第二份名单校验**（两处漂移过一次
 *   就会出现「全局名单认得的条目、账号名单认不得」这种静默半放行）
 * - `quota` 可选，缺省 = 不限流量；`bytes` 与 `period` **都必填**（见下）
 */
import type { AuthAccount } from "@/core/types/proxy.js";
import { validateAcl, type AclConfig } from "../acl/schema.js";

/** 账号内联可选键 */
const ACCOUNT_KEYS = new Set(["username", "password", "acl", "quota"]);
/** 流量配额的计量窗口 */
const QUOTA_PERIODS = ["hourly", "daily", "monthly", "total"] as const;
/** 单个账号的流量上限（`quota.bytes`） */
const QUOTA_MAX_BYTES = Number.MAX_SAFE_INTEGER;

/** 流量配额 - 某账号在某个计量窗口内允许传输的总字节数 */
export interface UserQuota {
  /** 窗口内允许传输的字节数（正安全整数；**不限请省略 `quota` 字段**，0 视为非法） */
  readonly bytes: number;
  /** 计量窗口；`total` = 进程生命周期累计（见 `plugins/usage-store.ts` 的诚实性边界） */
  readonly period: (typeof QUOTA_PERIODS)[number];
}

/**
 * 校验账号的流量配额
 * @description
 * **`bytes` 与 `period` 都必填，不给缺省值**，这是刻意的：写
 * `{"quota":{"bytes":1073741824}}` 时「1GB 是每天还是每月」在配置里是**歧义**，
 * 而本项目对歧义一律 abort（`parseStartupArgs` 的显式值解析失败即 abort 是同一条原则），
 * 绝不静默挑一个窗口。
 * @param raw - 候选对象
 * @returns 合法时返回归一化配额，非法返回 undefined
 */
export function validateUserQuota(raw: unknown): UserQuota | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  if (Object.keys(raw).some((k) => k !== "bytes" && k !== "period")) {
    return undefined;
  }

  const { bytes, period } = raw as { bytes?: unknown; period?: unknown };

  // 正安全整数：`0` / 负数 / 小数 / 字符串一律非法（0 不是「不限」——不限请省略整个 quota 字段）
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) {
    return undefined;
  }
  if (bytes > QUOTA_MAX_BYTES) {
    return undefined;
  }
  if (typeof period !== "string" || !QUOTA_PERIODS.includes(period as UserQuota["period"])) {
    return undefined;
  }

  return { bytes, period: period as UserQuota["period"] };
}

/**
 * 校验账号文件内容
 * @param raw - JSON.parse 结果
 * @returns 合法时返回账号数组（顺序保留；带可选策略的账号对象身份每次解析都不同，
 *   供 `policy.ts` 的快照身份索引与 `acl/eval.ts` 的编译缓存自然失效），非法返回 undefined
 * @example validateAuthUsers([{ username: "a", password: "p", acl: { target: { blacklist: ["x.com"] } } }])
 * // => [{ username: "a", password: "p", acl: { clientIp: {...空...}, target: {...}, upstream: {...空...} } }]
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
    const {
      username,
      password,
      acl,
      quota,
    } = item as { username?: unknown; password?: unknown; acl?: unknown; quota?: unknown };
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

    // 两个可选策略各自独立校验：给了但非法 = 整个账号表非法（fail-closed，
    // 绝不「悄悄忽略这个账号的名单」——那正是静默半放行的来源）
    const aclConfig: AclConfig | undefined = acl === undefined ? undefined : validateAcl(acl);
    const userQuota: UserQuota | undefined =
      quota === undefined ? undefined : validateUserQuota(quota);

    if (acl !== undefined && aclConfig === undefined) {
      return undefined;
    }
    if (quota !== undefined && userQuota === undefined) {
      return undefined;
    }

    out.push({
      username,
      password,
      ...(aclConfig === undefined ? {} : { acl: aclConfig }),
      ...(userQuota === undefined ? {} : { quota: userQuota }),
    });
  }

  return out;
}
