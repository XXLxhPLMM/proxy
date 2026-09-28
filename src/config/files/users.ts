/**
 * 用户账号文件：同步热加载 API + 启动期无日志异步校验 API。
 *
 * 同步读取复用 utils/json-file 的节流缓存与事件呈现；异步读取只用于配置加载器在提交
 * store 前做一次直接、不可缓存的 fail-closed 校验。
 *
 * 账号级可选 `acl`（**只允许 `target` 一个组**，fail-closed 理由见 `USER_POLICY_GROUP_KEYS`）
 * 、账号级可选 `quota`（**单个合计字节上限** + `day`/`month` 日历窗；`window` 缺省不补、
 * 在消费侧归一）与账号级可选 `expiresAt`（ISO 8601 有效期截止，**必须带时区偏移**）：
 * 逐条判据见下面 `UserQuota` / `QUOTA_WINDOW_VALUES` / `USER_POLICY_GROUP_KEYS` 处的注释，
 * 逐条断言锁点见 `tests/unit/user-quota.test.ts` 与 `tests/unit/auth-users.test.ts` 的头注释。
 * `loadUserPolicy` 是**每请求**调用、`consume` 是**每 chunk** 调用，故这两条热路径零分配。
 */

import fs from "node:fs";
import type { ConfigAccessor } from "../context.js";
import type { QuotaWindow } from "@/core/traffic/index.js";
import { readJsonCached, type JsonFileEvent, type JsonFileRead } from "@/utils/json-file/index.js";
import { parseHostRule } from "./rules/index.js";

/**
 * @description 形状与全局 `acl.json:AclList` 同形，但**刻意不共用那个类型**：全局组与
 * 按用户组是两类语义（全局组缺失 = 放行策略的兜底、用户组缺失 = 该用户不受额外限制），
 * 共用一个类型名会让将来任一侧扩字段静默传染另一侧。真正必须单一份的是**条目语法**，
 * 那已由 `rules/host.ts:parseHostRule` 保证。
 */
export interface UserPolicyList {
  readonly whitelist: readonly string[];
  readonly blacklist: readonly string[];
}

/** 某用户当前生效的访问策略（只读） */
export interface UserPolicy {
  /** 客户端请求目标的个人名单；条目同形于全局 `acl.json` 的 `target` 组 */
  readonly target: UserPolicyList;
}

/**
 * 账号表形状；与 core 使用的账号结构保持结构兼容。
 */
export interface AuthAccount {
  username: string;
  password: string;
  /**
   * 可选：该用户专属的访问名单（判定在 `core/access-control.ts` 的个人层）。
   * 对凭证索引**不可见**：`core/helpers/credentials.ts` 消费的是 core 那份两字段
   * `AuthAccount`（`core/types/proxy.ts`），`acl` 既不进索引也不影响 `buildCredentialIndexes`。
   */
  acl?: UserPolicy;
  /**
   * 可选：该用户专属的流量配额（计量与耗尽判定见 `core/traffic/`）。
   * 同样**对凭证索引不可见**，理由与 `acl` 一致：凭证比对只认用户名+密码。
   * 归一化后 `bytes` 恒为 number，**0 = 不限流**；`window` 缺省时不写键
   * （缺省 = `month`，由消费侧 `core/traffic/window.ts:quotaWindow` 归一）。
   */
  quota?: UserQuota;
  /**
   * 可选：该账号的**有效期截止**（归一化为 **epoch 毫秒**；磁盘上写 ISO 8601 且**必须带时区
   * 偏移**）。判定在 `core/identity/token.ts:TokenIdentityBase.identify`（命中凭证**之后**），
   * `now >= expiresAt` → 认证不通过，审计 `auth.decided` 带 `reason = "account-expired"`。
   * @description
   * - **对凭证索引不可见**（理由与 `acl` / `quota` 一致，且这里更硬）：有效期是**命中之后的
   *   第二道判定**。索引同时供出站剥离判据（`isOwnCredential`）使用，把过期账号从索引里剔除
   *   会让它的凭证**不再被剥掉**、原样转发给目标站——凭证没被识别 ≠ 凭证不存在。
   * - **已经过期的时间戳是合法配置**（那正是这个字段要表达的状态），**不判整份文件非法**；
   *   非法的是**形态**（见 {@link normalizeAccountExpiry}）。
   * - **`AUTH_TYPE=jwt` 下本字段不生效**：jwt 的用户名取自 token 的 `sub`、**不查账号表**，
   *   它的过期由 token 自己的 `exp` 声明裁决（`core/helpers/credentials.ts:verifyHs256Jwt`）。
   *   「配了不生效」正是假安全感，故启动期有一条 `account-expiry-inert` 告警兜着。
   * - **与配额窗口正交**：配额是「用量」的时间窗（`quota.window`，滚动即清账），本字段是
   *   「账号」的有效期（到点即拒）。两者互不影响，账号过期也**不清用量**。
   */
  expiresAt?: number;
}

/**
 * @description
 * - `bytes` **可选**，缺省即 0；`quota` 整体缺省、或 `bytes` 为 0 = **该用户不限流**。
 * - `bytes` 必须是**非负安全整数**（`Number.isSafeInteger` 且 `>= 0`）：负数 / 小数 /
 *   字符串 / 布尔 / 未知子键 → **整组非法 → 启动期 abort**（绝不静默丢字段后当作没配）。
 * - **只有「双向合计」一个上限，刻意不分方向**。分方向上限在判定语义下是**伪控制力**：
 *   耗尽判定是**账号级封禁**（撞顶后该用户在当前窗口内彻底不可用，跨窗口才恢复），
 *   所以「只配一个方向的上限」实际等于「整号断网，且要先把那个方向撞满才触发」——
 *   配置看起来生效、实际语义比写的更狠。真要分方向限流那是**限速/并发**问题，
 *   答案在传输层与反向代理，不在本字段。
 * - `window` **可选**（缺省 = `month`，由消费侧 `core/traffic/window.ts:quotaWindow` 归一），
 *   且只认 `day` / `month` 两个**日历窗**字面量（闭合集合）。不设滚动窗：滚动窗的运维解释
 *   成本高（「为什么现在被拒了」答不上来），且判定要跨多个历史窗口做聚合，与账本
 *   「滚动即清账」的惰性模型（无定时器）不相容。窗口键的计算与 DST 取舍见
 *   `src/core/traffic/window.ts` 文件头。
 */
export interface UserQuota {
  /**
   * 双向合计累计上限（上传 + 下载算在一起）；0 = 不限。
   * @description 判定是「累计 **>** 上限才拒」（恰好等于上限放行）。**剩余 = `bytes - usage`**，
   * 刻意不另开一个 `remaining` 出口：那是纯减法，而「未配配额 / 0 上限 = 无限」时它该返回什么
   * （`Infinity` / `null` / 负数）是个没有好答案的分支。消费方用
   * `TrafficAccount.usage(user)` 拿到当前窗口的已用量即可。
   */
  readonly bytes: number;
  /**
   * 配额窗口（日历窗）。**缺省即 `month`**，故本键在未配置时**不出现**于归一化产物中
   * （判据：未配 `window` 的账号，其归一化产物逐字等于 `{ bytes }`）。
   */
  readonly window?: QuotaWindow;
}

/** 空账号表（只读哨兵，文件缺失或启动期校验失败时使用）。 */
const EMPTY_ACCOUNTS: AuthAccount[] = [];

/**
 * 账号允许的顶层键（**闭合集合**：出现任何其它键 → 整份文件非法）
 * @description `acl` / `quota` 缺省时不出现在文件里；一旦写出就必须在表内，否则带这两个
 * 字段的文件全部被判非法。新增可选字段必须同时加进本表，护栏
 * `tests/unit/auth-users.test.ts`「ACCOUNT_KEYS 联动」那条断言锁住它。
 */
const ACCOUNT_KEYS = new Set(["username", "password", "acl", "quota", "expiresAt"]);

/** 账号级 `quota` 允许的子键（**闭合集合**：出现任何其它键 → 整组非法） */
const QUOTA_KEYS = ["bytes", "window"] as const;

const QUOTA_KEY_SET: ReadonlySet<string> = new Set<string>(QUOTA_KEYS);

/**
 * `quota.window` 允许的字面量（**闭合集合**，与 `core/traffic/window.ts:QuotaWindow` 同一份语义）
 * @description
 * 这里收的是**磁盘上写了什么**，缺省不在本层补成 `month`（补在消费侧
 * `window.ts:quotaWindow`，理由见 `UserQuota.window` 的注释）。任何不在表里的取值
 * （`"week"` / `"hour"` / `""` / 非字符串 / `null`）→ **整组非法 → 启动期 abort**：
 * 收下一个「看起来配了、实际按 month 跑」的值等于给假的安全感。
 */
const QUOTA_WINDOW_VALUES: ReadonlySet<string> = new Set<string>(["day", "month"]);

/**
 * 账号级 `acl` 允许的组：**只有 `target`**
 * @description 出现 `clientIp` / `upstream` / 任何未知键 → 整组非法（返回 undefined，
 * 启动期 abort）。这是**刻意 fail-closed**，理由如下：
 * - `clientIp`（限制来源 IP）在当前判定顺序下**不可实现**：`core/server/admission.ts` 的
 *   两阶段准入顺序是 clientIp（阶段 A）→ auth（阶段 B）→ target ACL → 路由，
 *   客户端名单判定发生在**鉴权之前**，那时还不知道用户是谁，「按用户限制来源 IP」拿不到身份。
 *   与其收下一个永不生效的字段（配置看起来生效、实际是假的安全感），不如启动期直接报错。
 * - `upstream` 是 client 模式的**路由名单**（命中 = 直连），描述的是「这类目标走不走
 *   上游」，与「你是谁」正交，按用户限制它没有可判定的语义。
 * @see 三组名单各自的动作语义与判定顺序见 `core/access-control.ts`；本层只做数据与形状校验
 */
const USER_POLICY_GROUP_KEYS = new Set(["target"]);

const USER_POLICY_LIST_KEYS = new Set(["whitelist", "blacklist"]);

/** 启动期直接读取的大小上限：1MiB。 */
const MAX_FILE_BYTES = 1024 * 1024;

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @description 条目合法性**唯一**判据是 `rules/host.ts:parseHostRule`（IP/CIDR/域名/
 * `*.域名`，不支持端口、不做 DNS）——与全局 `acl.json` 的 `target` 组逐字同一条实现。
 * 本文件**没有第二套条目解析**，护栏见 `tests/unit/auth-users.test.ts` 的源码级断言。
 * @param raw - 候选数组
 * @returns 合法时返回条目数组（去空白），非法返回 undefined（fail-closed，整组作废）
 */
function validateUserPolicyEntries(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const out: string[] = [];
  for (const e of raw) {
    if (typeof e !== "string" || !e.trim()) {
      return undefined;
    }
    const entry = e.trim();
    if (parseHostRule(entry) === undefined) {
      return undefined;
    }
    out.push(entry);
  }
  return out;
}

/**
 * @param raw - 候选对象（缺省视为空名单，与全局 ACL 同语义）
 * @returns 合法时返回 `{ whitelist, blacklist }`，非法返回 undefined
 */
function validateUserPolicyGroup(raw: unknown): UserPolicyList | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  if (Object.keys(raw).some((k) => !USER_POLICY_LIST_KEYS.has(k))) {
    return undefined;
  }

  const o = raw as { whitelist?: unknown; blacklist?: unknown };
  const whitelist = o.whitelist === undefined ? [] : validateUserPolicyEntries(o.whitelist);
  const blacklist = o.blacklist === undefined ? [] : validateUserPolicyEntries(o.blacklist);

  if (!whitelist || !blacklist) {
    return undefined;
  }
  return { whitelist, blacklist };
}

/**
 * @param raw - 候选对象
 * @returns 合法时返回归一化策略，非法返回 undefined
 */
function validateUserPolicy(raw: unknown): UserPolicy | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  if (Object.keys(raw).some((k) => !USER_POLICY_GROUP_KEYS.has(k))) {
    return undefined;
  }

  const o = raw as { target?: unknown };
  const target =
    o.target === undefined ? { whitelist: [], blacklist: [] } : validateUserPolicyGroup(o.target);
  if (!target) {
    return undefined;
  }
  return { target };
}

/**
 * 校验账号级 `quota`（字节上限 + 窗口；子键闭合、缺省不写键）
 * @param raw - 候选对象
 * @returns 合法时返回归一化（并冻结的）配额，非法返回 undefined
 * @description
 * **fail-closed**：出现未知子键 / `bytes` 不是非负安全整数（负数、小数、字符串、布尔、
 * `NaN`、`Infinity`、超 `Number.MAX_SAFE_INTEGER`）/ `window` 不在 `day|month` 闭合集合内
 * → 整组非法 → 启动期 abort。理由与 `acl` 一致：收下一个「看起来配了、实际被忽略」的字段
 * 等于给假的安全感。归一化把**缺省的 `bytes`** 补成 0，消费方因此**永远拿到一个 number**，
 * 不必到处判 `undefined`；但「未配」与「配了但为 0」在这里是同一件事（不限流），
 * 那属于请求期判定层的裁决。**`window` 缺省不补**（见 `UserQuota.window` 注释）。
 */
function validateUserQuota(raw: unknown): UserQuota | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!QUOTA_KEY_SET.has(key)) {
      return undefined;
    }
  }

  const o = raw as {
    bytes?: unknown;
    window?: unknown;
  };
  const bytes = normalizeQuotaBound(o.bytes);
  if (bytes === undefined) {
    return undefined;
  }

  // window 缺省 → 不写键（缺省 month 是消费侧裁决）；出现则必须是 day|month 之一
  let window: QuotaWindow | undefined;
  if (o.window !== undefined) {
    if (typeof o.window !== "string" || !QUOTA_WINDOW_VALUES.has(o.window)) {
      return undefined;
    }
    window = o.window as QuotaWindow;
  }

  return Object.freeze({
    bytes,
    ...(window === undefined ? {} : { window }),
  });
}

/**
 * 上限字段的归一：缺省 → 0（= 不限流）；出现则必须是非负安全整数
 * @description 用 `Number.isSafeInteger` 一次性挡掉：非 number（含 string/boolean/null）、
 * `NaN`、`±Infinity`、小数、负数、超 `2^53-1`。返回 `undefined` 表示**非法**（与「合法的 0」区分开）。
 */
function normalizeQuotaBound(value: unknown): number | undefined {
  if (value === undefined) {
    return 0;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 账号 `expiresAt` 允许的形态：**ISO 8601 日历日 + 时间，且必须带时区偏移**
 * @description
 * 六个捕获组分别是年 / 月 / 日 / 时 / 分 / 秒（秒与小数秒可选），末段是 `Z` 或 `±HH:MM`。
 *
 * **偏移为什么强制**：`Date.parse` 会把 `"2026-10-01"` 读成 **UTC 午夜**、把
 * `"2026-10-01 00:00"` 读成**本地午夜**——同一份配置在 UTC 机器与 `+08:00` 机器上相差 8 小时，
 * 而运维写它时心里想的一定是本地零点。收下这种值等于把「这台机器的时区」变成隐藏真相。
 */
const RE_ACCOUNT_EXPIRY =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 账号有效期的归一：ISO 8601（带偏移）→ epoch 毫秒；缺省由调用方判，非法返回 undefined
 * @description
 * **时刻与形态两道都要**：正则挡掉「没有偏移」「空格分隔」「只有日期」这些
 * `Date.parse` 会**默默猜一个时区**接受的写法；`Date.parse` 剩下唯一会「静默给出另一个时刻」
 * 的形态是**日历上不存在的日**——实测 `Date.parse("2026-02-30T00:00:00Z")` 返回一个有限值
 * （滚成 3 月 2 日），故这里显式按「该月天数」再判一次。月 13 / 时 24 这类由 `Date.parse`
 * 自己返回 `NaN`，不必重复判。
 * @param value - 候选值（磁盘上写的是字符串）
 * @returns 合法时返回 epoch 毫秒（非负有限数），非法返回 undefined
 * @example normalizeAccountExpiry("2026-10-01T00:00:00+08:00") // => 1790784000000
 * @example normalizeAccountExpiry("2026-10-01") // => undefined（没有偏移，会被当 UTC 午夜）
 */
function normalizeAccountExpiry(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const m = RE_ACCOUNT_EXPIRY.exec(value);
  if (m === null) {
    return undefined;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // 时/分/秒的上界：正则只保证是**两位数字**，`24:00` / `99:99` 这类要显式挡。
  // 月 13 与 2 月 30 日由下面两行一并处理（`Date.UTC` 会把越界月日规范化到下一年/下个月，
  // 所以不能靠 `Date.parse` 判——它对这两种都返回有限值）。
  if (month < 1 || month > 12 || Number(m[4]) > 23 || Number(m[5]) > 59) {
    return undefined;
  }
  if (m[6] !== undefined && Number(m[6]) > 59) {
    return undefined;
  }
  // `Date.UTC(y, month, 0)` = 该月**最后一天**：用它挡「2 月 30 日」这类滚动的假合法值
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * `acl` 与 `quota` 都是**可选**的：缺省 `acl` 即**不设个人名单**，缺省 `quota` 即**不设限**，
 * 因此 `[{username,password}]` 本身就是一份最小账号表。用户名非空 / 不含 `:` / 不重复、
 * 密码必须是 string、数组元素必须是对象、未知顶层键一律拒绝——这些规则与 `acl` / `quota`
 * 的可选性无关，一律生效。
 *
 * **`acl` 与 `quota` 互不影响**（各自独立校验、各自独立决定整份文件是否作废）：
 * 一个合法一个非法时，那一份**整份文件判非法**（fail-closed，与全局 ACL 同语义），
 * 而不是「只丢非法的那一个、另一个照常生效」——后者会造出「我配了名单但它没生效」这种
 * 要靠读源码才能查出来的问题。
 *
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
    const { username, password, acl, quota, expiresAt } = item as {
      username?: unknown;
      password?: unknown;
      acl?: unknown;
      quota?: unknown;
      expiresAt?: unknown;
    };
    if (typeof username !== "string" || !username || username.includes(":")) {
      return undefined;
    }
    if (typeof password !== "string") {
      return undefined;
    }
    if (seen.has(username)) {
      return undefined;
    }

    // `acl` 缺省即「无个人名单」；出现但非法 → 整份文件非法（与全局 ACL 同语义：任一条
    // 非法即整组失败，绝不静默丢字段后当作没配）
    const policy = acl === undefined ? undefined : validateUserPolicy(acl);
    if (acl !== undefined && policy === undefined) {
      return undefined;
    }

    // `quota` 同构：缺省即「不限流」；出现但非法 → 整份文件非法
    const bound = quota === undefined ? undefined : validateUserQuota(quota);
    if (quota !== undefined && bound === undefined) {
      return undefined;
    }

    // `expiresAt` 缺省即「永不过期」；**出现但形态非法** → 整份文件非法。
    // ⚠️ 与上面两组的差别只有一处，且是刻意的：**已经过期的时间戳是合法值**（那就是这个字段
    // 要表达的状态），判它非法等于「把账号设成过期 → 整个服务起不来」。
    const expiry = expiresAt === undefined ? undefined : normalizeAccountExpiry(expiresAt);
    if (expiresAt !== undefined && expiry === undefined) {
      return undefined;
    }

    seen.add(username);
    // 不写 `acl: undefined` / `quota: undefined` / `expiresAt: undefined` 键：最小形态账号的
    // 产物必须逐字等于 `{ username, password }`（护栏断言 `Object.keys(...)` 恰为这两个）
    out.push({
      username,
      password,
      ...(policy === undefined ? {} : { acl: policy }),
      ...(bound === undefined ? {} : { quota: bound }),
      ...(expiry === undefined ? {} : { expiresAt: expiry }),
    });
  }

  return out;
}

/**
 * - 缺失文件返回空账号表且不算错误。
 * - 超过 1MiB、JSON 解析失败、schema 校验失败或其它读取错误都返回 `error`，绝不向
 *   调用方抛出，也绝不触发热加载事件/全局 logger。
 * - `acl` 的校验与同步路径**共用** `validateAuthUsers`（同一份形状校验），故带 `acl` 的
 *   文件同样 fail-closed。
 */
export async function readAuthUsersAsync(filePath: string): Promise<JsonFileRead<AuthAccount[]>> {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      return {
        value: EMPTY_ACCOUNTS,
        path: filePath,
        exists: true,
        error: `文件超过 ${MAX_FILE_BYTES} 字节上限`,
      };
    }

    const raw = JSON.parse(content) as unknown;
    const value = validateAuthUsers(raw);
    if (value === undefined) {
      return {
        value: EMPTY_ACCOUNTS,
        path: filePath,
        exists: true,
        error: "格式非法（字段缺失、类型不符或存在未知键）",
      };
    }
    return { value, path: filePath, exists: true };
  } catch (error) {
    if (isMissingFile(error)) {
      return { value: EMPTY_ACCOUNTS, path: filePath, exists: false };
    }
    return {
      value: EMPTY_ACCOUNTS,
      path: filePath,
      exists: false,
      error: errorMessage(error),
    };
  }
}

export interface ReadAuthUsersOptions {
  force?: boolean;
  path?: string;
  /** 必填：决定未显式给 path 时读取哪份配置。 */
  config: ConfigAccessor;
  /** 当前服务显式提供的文件状态观察面；缺省不产生日志副作用。 */
  onEvent?: (event: JsonFileEvent) => void;
}

/**
 * @param opts - 读取选项；`config` 必须显式传入
 * @returns 读取结果：value 为生效账号表，error 为最近一次失败原因
 */
export function readAuthUsers(opts: ReadAuthUsersOptions): JsonFileRead<AuthAccount[]> {
  if (!opts.config) {
    throw new Error("readAuthUsers 必须显式传入 config");
  }
  const filePath = opts.path ?? opts.config.get("authUsersFile");
  return readJsonCached(filePath, validateAuthUsers, {
    label: "用户账号文件",
    fallback: EMPTY_ACCOUNTS,
    force: opts.force,
    maxBytes: MAX_FILE_BYTES,
    onEvent: opts.onEvent,
  });
}

/**
 * @param config - 必填配置访问器
 */
export function loadAuthUsers(
  config: ConfigAccessor,
  onEvent?: (event: JsonFileEvent) => void,
): AuthAccount[] {
  return readAuthUsers({ config, onEvent }).value;
}

/**
 * 已冻结策略的记忆表：**按源策略对象身份**命中，快照不变即零分配返回。
 * @description `readJsonCached` 在内容未变时返回**同一个**账号数组（同一批 policy 对象），
 * 故对象身份就是「快照是否变了」的精确判据（与 `core/access-control.ts` 编译缓存的
 * `source === acl` 同一手法）。WeakMap 让它随缓存条目一起被回收，不留悬垂引用。
 */
const frozenPolicies = new WeakMap<UserPolicy, UserPolicy>();

/**
 * 深拷贝并冻结一份策略：绝不把 `readJsonCached` 缓存里的内部数组引用交给调用方
 * @description 记忆表命中原样返回（**同一个对象身份**），未命中才拷贝 + 四层冻结。
 * 这是热路径要求（`core/access-control.ts` 的个人层每请求调用一次）下的零分配实现：
 * 记忆表外仍会**新建**一份冻结副本，故「拿到的对象与缓存内部引用无关」这条不变量
 * 在任何一次调用上都成立（护栏：`tests/unit/auth-users.test.ts` 的只读/不污染缓存那条）
 */
function frozenPolicy(policy: UserPolicy): UserPolicy {
  const cached = frozenPolicies.get(policy);
  if (cached !== undefined) {
    return cached;
  }
  const frozen: UserPolicy = Object.freeze({
    target: Object.freeze({
      whitelist: Object.freeze([...policy.target.whitelist]),
      blacklist: Object.freeze([...policy.target.blacklist]),
    }),
  });
  frozenPolicies.set(policy, frozen);
  return frozen;
}

/**
 * 取某用户当前生效的访问策略。
 *
 * **复用账号表的同一条读取路径**（`readAuthUsers` → `utils/json-file:readJsonCached`，
 * 缓存键仍是 `label + path`）：另开一个读取器会造成两份节流缓存、两份解析、两套坏文件
 * 处理，并互相污染同一缓存键。热加载语义因此与账号表逐字一致（1s stat 节流、坏内容
 * 保留上一份有效值、缺失 = 空表）。
 *
 * **零分配**：本函数是**每请求**调用（`core/access-control.ts` 个人层），故定位账号用下标循环
 * 而非 `find`（闭包也是分配）、冻结结果按源对象身份记忆。
 * 策略快照未变时，本函数自身**不再产生任何新对象**，连续两次查询返回**同一对象身份**
 * （护栏：`tests/unit/user-acl-merge.test.ts` 的 `toBe` 那条）。
 * 注：共用读取路径 `readJsonCached` 自身每次返回一个新的结果对象——那是账号表与鉴权本来
 * 就在付的成本（身份门面的每请求判定也调 `loadAuthUsers`），本函数不去动它。
 *
 * @param username - 账号用户名
 * @param config - 必填配置访问器
 * @param onFileEvent - 与账号表同一个事件回调（缺省不产生日志副作用）
 * @returns 策略（深度冻结）；用户不存在或未配 `acl` 返回 undefined
 */
export function loadUserPolicy(
  username: string,
  config: ConfigAccessor,
  onFileEvent?: (event: JsonFileEvent) => void,
): UserPolicy | undefined {
  const accounts = readAuthUsers({ config, onEvent: onFileEvent }).value;
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    if (account.username === username) {
      return account.acl === undefined ? undefined : frozenPolicy(account.acl);
    }
  }
  return undefined;
}

/**
 * 已冻结配额的记忆表：**按源配额对象身份**命中，快照不变即零分配返回
 * @description 与 `frozenPolicies` 同一手法（判据 = `readJsonCached` 内容未变时返回同一批
 * 对象）：`MemoryTrafficAccount.consume` 是**每 chunk** 调用（一次大文件传输能调用几万次），
 * 「每次深冻结一份新对象」在这种频次上是纯浪费。记忆表按账号规模自动分槽（key 是对象本身），
 * 随缓存条目一起被 WeakMap 回收，不留悬垂引用。
 */
const frozenQuotas = new WeakMap<UserQuota, UserQuota>();

/**
 * 深拷贝并冻结一份配额：绝不把 `readJsonCached` 缓存里的对象引用交给调用方
 * @description 记忆表命中原样返回（**同一个对象身份**），未命中才新建一份冻结副本。
 * 记忆表外仍会**新建**一份，故「拿到的对象与缓存内部引用无关」这条不变量在任何一次调用上
 * 都成立（`validateUserQuota` 已经冻结过一次，这里是第二道：调用方拿到的永远是独立副本）。
 * `window` 与字节字段同规则：未配置时**不写键**（判据见 `UserQuota.window`）。
 */
function frozenQuota(quota: UserQuota): UserQuota {
  const cached = frozenQuotas.get(quota);
  if (cached !== undefined) {
    return cached;
  }
  const frozen: UserQuota = Object.freeze({
    bytes: quota.bytes,
    ...(quota.window === undefined ? {} : { window: quota.window }),
  });
  frozenQuotas.set(quota, frozen);
  return frozen;
}

/**
 * 取某用户当前生效的流量配额。
 *
 * **复用账号表的同一条读取路径**（`readAuthUsers` → `utils/json-file:readJsonCached`，
 * 缓存键仍是 `label + path`）：与 `loadUserPolicy` 完全同构，故热加载语义逐字一致
 * （1s stat 节流、坏内容保留上一份有效值、缺失 = 空表），也**不会**出现两份节流缓存、
 * 两份解析、两套坏文件处理互相污染同一缓存键。
 *
 * **零分配**：`consume` 是每 chunk 调用的热路径，故定位账号用下标循环、冻结结果按源对象身份
 * 记忆；配额快照未变时本函数**不再产生任何新对象**，连续两次查询返回**同一对象身份**。
 *
 * **判定不在本模块**：本模块只提供数据。「超了没有」的裁决住在
 * `core/traffic/memory.ts:MemoryTrafficAccount.consume`（单一合计上限 `bytes`，
 * 累计 **>** 上限即拒，恰好等于放行）。
 *
 * @param username - 账号用户名
 * @param config - 必填配置访问器
 * @param onFileEvent - 与账号表同一个事件回调（缺省不产生日志副作用）
 * @returns 配额（深度冻结）；用户不存在或未配 `quota` 返回 undefined（= 不限流）
 */
export function loadUserQuota(
  username: string,
  config: ConfigAccessor,
  onFileEvent?: (event: JsonFileEvent) => void,
): UserQuota | undefined {
  const accounts = readAuthUsers({ config, onEvent: onFileEvent }).value;
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    if (account.username === username) {
      return account.quota === undefined ? undefined : frozenQuota(account.quota);
    }
  }
  return undefined;
}

/**
 * 账号表里是否至少有一个账号配了 `expiresAt`
 * @description
 * 这是**启动期 `account-expiry-inert` 告警的判据**：`AUTH_TYPE=jwt` 时身份来自 token 的
 * `sub`、**不查账号表**，故账号上的 `expiresAt` **不生效**（jwt 的过期由 token 自己的 `exp`
 * 裁决）。配了而不报，等于收下一个「看起来配了、实际没做」的限制——正是本仓最恨的假安全感。
 *
 * **签名与理由同 `hasConfiguredQuota`**：只收 `ConfigAccessor`（纯判定、不观察也不发布任何东西），
 * 走 `loadAuthUsers` 那条 1s 节流读取路径，判据是**文件事实**而不是配置猜测。
 *
 * **刻意不判「是否已过期」**：本函数只答「有没有人配过」。「现在有没有人过期」是**每请求**的判定，
 * 住在 `core/identity/token.ts:TokenIdentityBase.identify`；混进启动期告警会让「一个早就过期、
 * 早就该被拒的账号」在每次启动时也报一遍「配了不生效」这种不相干的噪音。
 * @param config - 必填配置访问器
 * @param onEvent - 与账号表同一个事件回调（缺省不产生日志副作用）
 * @returns 至少一个账号带 `expiresAt` 时为 true
 */
export function hasAccountExpiry(
  config: ConfigAccessor,
  onEvent?: (event: JsonFileEvent) => void,
): boolean {
  const accounts = loadAuthUsers(config, onEvent);
  for (let i = 0; i < accounts.length; i++) {
    if (accounts[i].expiresAt !== undefined) {
      return true;
    }
  }
  return false;
}

