/**
 * @fileoverview 账号条目的**形状校验**：一份判据，零 IO
 * @module datasource/users/validate
 * @description
 * 本模块是「**什么是合法账号**」的**唯一**判据：所有后端都把原始值交给
 * {@link validateAuthUsers}，于是「换个后端行为一样」这件事由结构保证，而不是靠各实现器
 * 自觉。**零 IO、零配置读取、零日志**——它只答「这份值合法吗」，不答「它存在吗」「读得到吗」。
 *
 * ## 四组可选字段的共同纪律：fail-closed 到整份表
 *
 * `acl` / `quota` / `expiresAt` / `disabled` 各自独立校验、各自独立决定整份表是否作废，**不是**
 * 「只丢非法的那一个、另一个照常生效」——后者会造出「我配了名单但它没生效」这种要靠读源码才能查出来的
 * 问题。
 *
 * 条目语法的合法性**唯一**判据是 `src/utils/addr/host.ts:parseHostRule`，与全局
 * `acl.json` 的 `target` 组逐字同一条实现；本模块**没有第二套条目解析**。
 */

import type { QuotaWindow } from "../quota-window.js";
import { parseHostRule } from "@/utils/addr/index.js";
import type { AuthAccount, UserPolicy, UserPolicyList, UserQuota } from "./types.js";

/**
 * 账号允许的顶层键（**闭合集合**：出现任何其它键 → 整份文件非法）
 * @description `acl` / `quota` / `expiresAt` / `disabled` 缺省时不出现在文件里；一旦写出就必须在表内，否则
 * 带这几个字段的文件全部被判非法。新增可选字段必须同时加进本表，护栏
 * `tests/unit/config/auth-users/validate.test.ts`「ACCOUNT_KEYS 联动」那条断言锁住它。
 */
const ACCOUNT_KEYS = new Set(["username", "password", "acl", "quota", "expiresAt", "disabled"]);

/** 账号级 `quota` 允许的子键（**闭合集合**：出现任何其它键 → 整组非法） */
const QUOTA_KEYS = ["bytes", "window"] as const;

const QUOTA_KEY_SET: ReadonlySet<string> = new Set<string>(QUOTA_KEYS);

/**
 * `quota.window` 允许的字面量（**闭合集合**，与 `datasource/quota-window.ts:QuotaWindow` 同一份语义）
 * @description
 * 这里收的是**磁盘上写了什么**，缺省不在本层补成 `month`（补在消费侧
 * `quota-window.ts:quotaWindow`，理由见 `UserQuota.window` 的注释）。任何不在表里的取值
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

/**
 * @description 条目合法性**唯一**判据是 `rules/host.ts:parseHostRule`（IP/CIDR/域名/
 * `*.域名`，不支持端口、不做 DNS）——与全局 `acl.json` 的 `target` 组逐字同一条实现。
 * 本文件**没有第二套条目解析**，护栏见 `tests/unit/config/auth-users/source-guards.test.ts` 的源码级断言。
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
  if (keysNotIn(raw, USER_POLICY_GROUP_KEYS)) {
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
  if (keysNotIn(raw, QUOTA_KEY_SET)) {
    return undefined;
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
 * @description **本函数是「磁盘形态的 `expiresAt` 是否合法」的唯一判据**，故它对外可见：收磁盘
 *   形态、交给 `AccountSource.put` 归一形态的那一侧（`proxy-cli user set --expires`）必须用本函数，
 *   而不是自己的 `Date.parse` —— 后者会给「无偏移」「空格分隔」这些写法默默猜一个时区。
 * @example normalizeAccountExpiry("2026-10-01T00:00:00+08:00") // => 1790784000000
 * @example normalizeAccountExpiry("2026-10-01") // => undefined（没有偏移，会被当 UTC 午夜）
 */
export function normalizeAccountExpiry(value: unknown): number | undefined {
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

/** 对象的键是否**全部**落在闭合集合内（空集合 = 任何键都非法） */
function keysNotIn(raw: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(raw).some((k) => !allowed.has(k));
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
    if (keysNotIn(item, ACCOUNT_KEYS)) {
      return undefined;
    }
    const { username, password, acl, quota, expiresAt, disabled } = item as {
      username?: unknown;
      password?: unknown;
      acl?: unknown;
      quota?: unknown;
      expiresAt?: unknown;
      disabled?: unknown;
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

    // `disabled` 缺省即「启用」；**出现但不是布尔**（`"true"` / `1` / `null` / 对象）→ 整份文件非法。
    // ⚠️ 与 `expiresAt` 那一组的差别在于**没有「非法但合法表达」这回事**：不存在「已过期的 disabled」
    // 这种东西，所以不存在「值本身合法、只是碰巧不利」的值，一律 fail-closed。
    //
    // ⚠️ **判据用 `typeof` 而不是三态真值**：写成 `disabled === true` 会把 `"true"` / `1` 静默归一成
    // `false`（= 启用），那正是「看着配了禁用、实际按没配跑」的假安全感——比整份表作废更坏。
    if (disabled !== undefined && typeof disabled !== "boolean") {
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
      ...(disabled === undefined ? {} : { disabled }),
    });
  }

  return out;
}

/**
 * 把一条**归一化**账号转成**磁盘形态**并交给 `validateAuthUsers` 校验
 * @description
 * 走**整表**的 `validateAuthUsers` 而不是自己判一遍：单条判据必须是整表判据的子集，否则会出现
 * 「单条合法但整表非法」（如与别的账号重名）这种只有落库时才发现的错。
 *
 * ⚠️ **关键：先转磁盘形态、再校验**。`AuthAccount.expiresAt` 是 **epoch 毫秒**（归一化产物），
 * 而 `validateAuthUsers` / `normalizeAccountExpiry` 判的是**磁盘形态**（带时区偏移的 ISO 8601
 * 串）。两者在 TS 上是同一个类型、在运行期是两种值——这正是本仓最容易踩的一个形状
 * （归一化对象直接丢给 `validateAuthUsers` 时，**任何带 `expiresAt` 的账号都写不进去**）。
 *
 * 顺带得到一条强性质：**校验过的字节就是落盘的字节**（`toDoc` 的输出即校验输入），
 * 所以「写得进去但读不出来」这件事在本档不存在。
 */
export function toAccountDoc(account: AuthAccount): string {
  const out: Record<string, unknown> = {
    username: account.username,
    password: account.password,
  };
  if (account.acl !== undefined) {
    out.acl = account.acl;
  }
  if (account.quota !== undefined) {
    out.quota = account.quota;
  }
  if (account.expiresAt !== undefined) {
    // 归一化产物里 `expiresAt` 是 epoch 毫秒（`normalizeAccountExpiry` 的产物），
    // 而 JSON 档要求磁盘上写**带时区偏移的 ISO 8601** —— 这里必须换回去，否则同一个账号
    // 在两个后端里的磁盘形态不同（而 `expiresAt` 的偏移强制正是它存在的理由之一）。
    out.expiresAt = new Date(account.expiresAt).toISOString();
  }
  if (account.disabled !== undefined) {
    // 布尔原样透传，**不做「false → 缺省」的压缩**：压缩会让「我明确开了这个账号」与「我明确关了
    // 它」在文件里长得一样，而那正是下一次 diff / 人工编辑最容易读错的一处。
    out.disabled = account.disabled;
  }
  return JSON.stringify(out);
}

/**
 * 把一条**归一化**账号过一遍写前校验（走**磁盘形态**，理由见 {@link toAccountDoc}）
 * @throws 形状非法时抛错（**不**静默丢字段）
 */
export function normalizeOne(account: AuthAccount): AuthAccount {
  const doc = JSON.parse(toAccountDoc(account)) as unknown;
  const validated = validateAuthUsers([doc]);
  if (validated === undefined) {
    throw new Error(
      `账号 ${JSON.stringify(account.username)} 形状非法（字段缺失、类型不符或存在未知键）`,
    );
  }
  return validated[0];
}
