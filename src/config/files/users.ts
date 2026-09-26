/**
 * 用户账号文件：同步热加载 API + 启动期无日志异步校验 API。
 *
 * 同步读取继续复用 utils/json-file 的节流缓存与事件呈现；异步读取只用于配置加载器
 * 在提交 store 前做一次直接、不可缓存的 fail-closed 校验。
 *
 * 职责边界（与同目录 `acl.ts` 同构，三层互不越界）：
 * - **条目规则层** `./rules/`（`ip.ts` + `host.ts`）：条目语法（IP/CIDR/域名/`*.域名`）
 *   的解析、编译与匹配，纯函数、零 IO。改条目语法动这里。
 * - **本模块（数据层）**：读文件、校验顶层形状、返回合法的账号表。**不做任何判定。**
 * - **策略层**：全局名单的请求期判定在 `src/core/access-control.ts`；账号级名单的请求期
 *   判定**也已落地**：`access.checkTarget({ host, user })` 消费本模块的 `loadUserPolicy`，
 *   判定为「放行 ⇔ 全局 target 组放行 ∧ 该用户 target 组放行」
 *   （先全局后个人、全局短路）。**本模块仍然只提供数据**，判定与两层合流规则都在 core。
 *
 * 账号级可选名单 `acl`（数据层只读，判定在 core）：
 * - 形状与全局 `acl.json` 的 `target` 组**完全同形**，条目合法性**只**经
 *   `./rules/index.js:parseHostRule` 判定——严禁在本文件另写一套条目解析。
 * - **只允许 `target` 一个组**，理由见 `USER_POLICY_GROUP_KEYS` 处注释（fail-closed）。
 * - `loadUserPolicy` 是**每请求**调用（热路径），故零分配：下标循环定位账号 +
 *   冻结结果按源对象身份记忆（见 `frozenPolicies` 处注释）。
 *
 * 账号级可选流量配额 `quota`（本模块只提供读取面，计量与耗尽判定在 `core/traffic/`）：
 * - 形状 `{ "bytesUp": N, "bytesDown": N, "bytesTotal": N, "window": "day"|"month" }`，
 *   四个子键**各自可选**；三个字节字段缺省即 0，**全 0 或整体缺省 = 该用户不限流**；
 *   每个字节字段必须是非负安全整数，否则整组非法。
 * - `window` 缺省**不在这里补**（消费侧 `core/traffic/window.ts:quotaWindow` 归一为
 *   `month`）：归一化产物只回显磁盘上写了什么，否则「旧文件产物逐字不变」这条不变量失效。
 * - 与 `acl` **互不影响**（各自独立校验），但「一个合法一个非法」时**整份文件判非法**。
 * - `loadUserQuota` 与 `loadUserPolicy` **逐字同构**：复用同一条 `readAuthUsers` 读取路径
 *   （本文件全文 `readJsonCached` 恰好一处，源码级护栏锁死），故热加载语义完全一致。
 * - **判定不在本文件**：`超了没有` 的裁决住在 `core/traffic/memory.ts`。
 * - `quota` 与 `acl` 一样**对凭证索引不可见**（`credentials.ts` 只认用户名+密码）。
 */

import fs from "node:fs";
import type { ConfigAccessor } from "../context.js";
import type { QuotaWindow } from "@/core/traffic/index.js";
import { readJsonCached, type JsonFileEvent, type JsonFileRead } from "@/utils/json-file/index.js";
import { parseHostRule } from "./rules/index.js";

/**
 * 账号级名单的单组条目（只读）
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
   * 归一化后三个**字节**字段恒为 number，**0 = 该上限不生效**；`window` 缺省时不写键
   * （缺省 = `month`，由消费侧 `core/traffic/window.ts:quotaWindow` 归一）。
   */
  quota?: UserQuota;
}

/**
 * 某用户的流量配额（字节）
 * @description
 * - 三个字节子字段**各自可选**，缺省即 0；`quota` 整体缺省、或三个子字段全 0 = **该用户不限流**。
 * - 每个字节字段都必须是**非负安全整数**（`Number.isSafeInteger` 且 `>= 0`）：负数 / 小数 /
 *   字符串 / 布尔 / 未知子键 → **整组非法 → 启动期 abort**（绝不静默丢字段后当作没配）。
 * - `window` **可选**（缺省 = `month`，由消费侧 `core/traffic/window.ts:quotaWindow` 归一），
 *   只认 `day` / `month` 两个**日历窗**字面量。**为什么不做滚动窗**（`"30 天内 100GB"`）：
 *   滚动窗的运维解释成本高（「为什么现在被拒了」答不上来）、且判定要跨多个历史窗口做聚合，
 *   与账本「滚动即清账」的惰性模型（无定时器）不相容。本项目处于设计期，**不预留占位值**
 *   ——塞一个 `window: "rolling"` 却按日历窗跑，恰恰是「配了但没生效」的最坏形态。
 *   窗口键的计算与 DST 取舍见 `src/core/traffic/window.ts` 文件头。
 * - **刻意没有速率字段**（`rateBps` 之类）：限速必须 `pause()`/`resume()` 整形，会与
 *   `guardDialing` 的半关闭联动形成第三层流控，且粒度只能到 chunk（TLS record ~16KB），
 *   低限速值只能靠延迟换平滑——那是在用用户态重写内核已经做更好的事。
 */
export interface UserQuota {
  /** 客户端→上游（上传）累计上限；0 = 不限。 */
  readonly bytesUp: number;
  /** 上游→客户端（下载）累计上限；0 = 不限。 */
  readonly bytesDown: number;
  /** 双向合计上限；0 = 不限。 */
  readonly bytesTotal: number;
  /**
   * 配额窗口（日历窗）。**缺省即 `month`**，故本键在未配置时**不出现**于归一化产物中
   * （判据是「旧格式账号的产物逐字不变」那条不变量）。
   */
  readonly window?: QuotaWindow;
}

/** 空账号表（只读哨兵，文件缺失或启动期校验失败时使用）。 */
const EMPTY_ACCOUNTS: AuthAccount[] = [];

/**
 * users.json 单个账号允许的字段名
 * @description `acl` / `quota` 都必须在表内，否则**所有**带这两个字段的文件都会被判非法
 * （未知顶层键一律拒绝）。新增可选字段时这是最容易漏的联动点（护栏有专门一条断言 +
 * 对应的变异测试：把它从白名单删掉，那条断言立刻变红）。
 */
const ACCOUNT_KEYS = new Set(["username", "password", "acl", "quota"]);

/** 账号级 `quota` 允许的子键（**闭合集合**：出现任何其它键 → 整组非法） */
const QUOTA_KEYS = ["bytesUp", "bytesDown", "bytesTotal", "window"] as const;

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
 * @see 判定顺序与全局三组语义见 src/config/AGENTS.md「访问控制（ACL）」
 */
const USER_POLICY_GROUP_KEYS = new Set(["target"]);

/** 账号级 `acl` 组内允许的键 */
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
 * 校验账号级名单的条目
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
 * 校验账号级名单的单组
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
 * 校验账号级 `acl`（只允许 `target` 组，见 `USER_POLICY_GROUP_KEYS` 处的 fail-closed 理由）
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
 * **fail-closed**：出现未知子键 / 任一字节字段不是非负安全整数（负数、小数、字符串、布尔、
 * `NaN`、`Infinity`、超 `Number.MAX_SAFE_INTEGER`）/ `window` 不在 `day|month` 闭合集合内
 * → 整组非法 → 启动期 abort。理由与 `acl` 一致：收下一个「看起来配了、实际被忽略」的字段
 * 等于给假的安全感。归一化把**缺省的字节字段**补成 0，消费方因此**永远拿到三个 number**，
 * 不必到处判 `undefined`；但「未配」与「配了但全 0」在这里是同一件事（不限流），
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
    bytesUp?: unknown;
    bytesDown?: unknown;
    bytesTotal?: unknown;
    window?: unknown;
  };
  const bytesUp = normalizeQuotaBound(o.bytesUp);
  const bytesDown = normalizeQuotaBound(o.bytesDown);
  const bytesTotal = normalizeQuotaBound(o.bytesTotal);
  if (bytesUp === undefined || bytesDown === undefined || bytesTotal === undefined) {
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
    bytesUp,
    bytesDown,
    bytesTotal,
    ...(window === undefined ? {} : { window }),
  });
}

/**
 * 单个上限字段的归一：缺省 → 0（= 该上限不生效）；出现则必须是非负安全整数
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
 * 校验账号文件内容。
 *
 * `acl` 与 `quota` 都是**可选**的：旧的 `[{username,password}]` 文件一律仍然合法（不因这两个
 * 字段的存在破坏任何现有部署）。其余规则一条未放松：用户名非空 / 不含 `:` / 不重复、密码必须是
 * string、数组元素必须是对象、未知顶层键一律拒绝。
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
    const { username, password, acl, quota } = item as {
      username?: unknown;
      password?: unknown;
      acl?: unknown;
      quota?: unknown;
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

    seen.add(username);
    // 不写 `acl: undefined` / `quota: undefined` 键：旧格式账号的产物必须逐字等于
    // `{ username, password }`（护栏断言 `Object.keys(...)` 恰为这两个）
    out.push({
      username,
      password,
      ...(policy === undefined ? {} : { acl: policy }),
      ...(bound === undefined ? {} : { quota: bound }),
    });
  }

  return out;
}

/**
 * 启动期直接读取并校验账号文件。
 *
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

/** 同步读取账号文件的选项。 */
export interface ReadAuthUsersOptions {
  force?: boolean;
  path?: string;
  /** 必填：决定未显式给 path 时读取哪份配置。 */
  config: ConfigAccessor;
  /** 当前服务显式提供的文件状态观察面；缺省不产生日志副作用。 */
  onEvent?: (event: JsonFileEvent) => void;
}

/**
 * 读取账号文件（带节流缓存）。
 *
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
 * 取当前生效账号表。
 *
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
 * 注：共用读取路径 `readJsonCached` 自身每次返回一个新的结果对象——那是账号表与鉴权
 * 早就在付的成本（身份门面的每请求判定也调 `loadAuthUsers`），本函数不去动它。
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
    bytesUp: quota.bytesUp,
    bytesDown: quota.bytesDown,
    bytesTotal: quota.bytesTotal,
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
 * `core/traffic/memory.ts:MemoryTrafficAccount.consume`（判定顺序 `bytesUp` → `bytesDown`
 * → `bytesTotal`，任一突破即拒）。
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

