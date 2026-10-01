/**
 * @fileoverview 账号表的**读取面**：转发到已解析的实现器，零直接读取器
 * @module datasource/users/read
 * @description
 * 全部函数只做「取整张表 → 内存里答一个问题」。**真正的 IO 在两个实现器里**，而它们共用
 * 同一套节流 / 缓存 / 四态事件（`@/utils/json-file`）。保留这些函数名是为了让全部调用方
 * （`loadAuthUsers` / `loadUserPolicy` / `loadUserQuota` / `hasAccountExpiry` /
 * `hasAccountDisabled` / `server/log/config-log.ts`）**不必知道有后端这回事**。
 *
 * ## 为什么签名收「接线」而不收 `ConfigAccessor`
 *
 * 接线（`../users/types.ts:AccountLocator`）是两个闭包：`driver()` 与 `pathFor(driver)`。
 * 收它而不是收配置端口，有三处具体收益：
 * - **本层不依赖配置层**：于是这一份账号表能被一个不跑代理的库调用方直接用。
 * - **「哪个键装哪个驱动」只有一处**（装配层的 `pathFor`），读面不再重复那份映射。
 * - **记忆表的键有了一个稳定对象**（接线由装配层长期持有），实现器因此能按「装配点」隔离
 *   记忆，而不必认识 `ConfigAccessor`。
 *
 * ⚠️ **代价：调用方必须自己造接线**。装配层是唯一该造它的地方（见 `AccountLocator` 的注释），
 * 读面**永不**替调用方从配置里猜。
 */

import fs from "node:fs";
import { BUILTIN_ACCOUNT_DRIVERS, type DataSourceDriver } from "../driver.js";
import type { JsonFileEvent, JsonFileRead } from "@/utils/json-file/index.js";
import { accountSourceFor, resolveAccountSource } from "./registry.js";
import type { AccountLocator, AuthAccount, UserPolicy, UserQuota } from "./types.js";
import { validateAuthUsers } from "./validate.js";

/** 空账号表（只读哨兵，文件缺失或启动期校验失败时使用）。 */
const EMPTY_ACCOUNTS: AuthAccount[] = [];

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

/**
 * 启动期强校验用的账号表读取：**不缓存、不发事件、只读一次**
 * @param driver - 数据来源（由 `AUTH_USERS_DRIVER` 定）
 * @param pathFor - 该驱动对应的数据位置（现取，**不是**只对内置两档有意义的固定值）
 * @description
 * 与 {@link readAuthUsersAsync}（JSON 专版）并列，**不是**它的超集：json 档走
 * `fs.promises.readFile`（真正的一次性异步读），其余驱动走注册表解析出的实现器（同步，但
 * **不经缓存**，所以仍然满足「不碰热加载缓存」这一条纪律）。
 *
 * **为什么不用缓存那条路**：`loadConfig` 跑在 store 提交之前，此时「上一份有效值」这个概念
 * 还不存在（没有前一次读可以沿用），所以「坏内容保留上一份」在这里退化成「坏内容 = 空表 + error」，
 * 正是 fail-closed 想要的。走缓存反而会**继承**一个不该继承的东西：库里残留的旧条目。
 */
export async function readAuthUsersAsyncStartup(
  driver: DataSourceDriver,
  pathFor: (driver: DataSourceDriver) => string,
): Promise<JsonFileRead<AuthAccount[]>> {
  if (driver === BUILTIN_ACCOUNT_DRIVERS.json) {
    return readAuthUsersAsync(pathFor(driver));
  }
  const file = pathFor(driver);
  const accounts = resolveAccountSource(driver)(() => file).list({ force: true });
  return { value: accounts.value, path: file, exists: accounts.exists, error: accounts.error };
}

export interface ReadAuthUsersOptions {
  force?: boolean;
  /** 显式路径覆盖（**只对 JSON 档有意义**：它就是「换个文件读」）。 */
  path?: string;
  /** 装配接线：驱动名与路径都是现取（runtime 相位，可热改）。 */
  locator: AccountLocator;
  /** 当前服务显式提供的文件状态观察面；缺省不产生日志副作用。 */
  onEvent?: (event: JsonFileEvent) => void;
  /**
   * 显式指定后端（**启动期校验与路径覆盖专用**）
   * @description 缺省 = 读 `locator.driver()`（runtime 相位，可热改）。
   * 那两处调用方要的是一个**确定的**后端：启动期强校验不该被「上一次热改留下的取值」影响，
   * 而 `path` 覆盖本来就是「换个 JSON 文件读」这件事，与 SQLite 档无关。
   */
  driver?: DataSourceDriver;
}

/**
 * 读账号表（**唯一**的账号表读取入口；后端由 `accountSourceFor` 按驱动选）
 * @param opts - 读取选项；`locator` 必须显式传入
 * @returns 读取结果：value 为生效账号表，error 为最近一次失败原因
 */
export function readAuthUsers(opts: ReadAuthUsersOptions): JsonFileRead<AuthAccount[]> {
  if (!opts.locator) {
    throw new Error("readAuthUsers 必须显式传入 locator");
  }
  return accountSourceFor(opts.locator, opts.driver, opts.path).list({
    force: opts.force,
    onEvent: opts.onEvent,
  });
}

/**
 * @param locator - 必填装配接线
 */
export function loadAuthUsers(
  locator: AccountLocator,
  onEvent?: (event: JsonFileEvent) => void,
): AuthAccount[] {
  return readAuthUsers({ locator, onEvent }).value;
}

/**
 * 账号表的身份索引：**按账号数组对象身份**命中，查找从 O(账号数) 降到 O(1)
 * @description
 * 判据 = **数组对象身份**：读取器在内容未变时返回**同一个**数组（同一批 account 对象），
 * 故「数组身份相同」就是「账号表快照未变」的精确判据 —— 与 {@link frozenPolicies} /
 * {@link frozenQuotas} 同一手法，WeakMap 让它随缓存条目一起被回收。
 *
 * **为什么索引必须长在这个数组上而不是每次重建**：本文件全部函数都只做「取整张表 →
 * 内存里答一个问题」，而「答」的那一步每请求（`loadUserPolicy`，个人名单）或每 chunk
 * （`loadUserQuota`，配额判定）都要走一次。线性扫在这个频次上就是热路径本身的成本。
 * 挂在数组身份上则与读取缓存**同生共死**：内容没变零重建，内容变了（新数组）自然重建，
 * 于是「索引与账号表一致」不是一条需要维护的不变量，而是 WeakMap 键的性质。
 *
 * **不变量：喂进来的账号表没有重名。** `validateAuthUsers` 对重名用户名**整组拒绝**
 * （`./validate.ts` 的 `seen.has(username)`），而每个后端都把原始值交给那**一份**校验，
 * 故重名账号根本到不了这里——索引用「后写覆盖」建表与「取首个」不可区分，不必为不可达的
 * 输入写分支。
 *
 * 护栏：`tests/unit/user-quota.test.ts` 的「查找是 O(1) 身份索引」与「内容变更后索引跟着换」
 * 两条（前者还钉住「不许退回线性扫」这个形状判据）。
 */
const accountIndexes = new WeakMap<AuthAccount[], ReadonlyMap<string, AuthAccount>>();

/** 取该账号数组的身份索引（未建则建一次并记忆）。 */
function accountIndex(accounts: AuthAccount[]): ReadonlyMap<string, AuthAccount> {
  const cached = accountIndexes.get(accounts);
  if (cached !== undefined) {
    return cached;
  }
  const index = new Map<string, AuthAccount>();
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    index.set(account.username, account);
  }
  accountIndexes.set(accounts, index);
  return index;
}

/**
 * 已冻结策略的记忆表：**按源策略对象身份**命中，快照不变即零分配返回。
 * @description 读取器在内容未变时返回**同一个**账号数组（同一批 policy 对象），
 * 故对象身份就是「快照是否变了」的精确判据（与 `core/access-control.ts` 编译缓存的
 * `source === acl` 同一手法）。WeakMap 让它随缓存条目一起被回收，不留悬垂引用。
 */
const frozenPolicies = new WeakMap<UserPolicy, UserPolicy>();

/**
 * 深拷贝并冻结一份策略：绝不把读取缓存里的内部数组引用交给调用方
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
 * **复用账号表的同一条读取路径**（`readAuthUsers` → `@/utils/json-file`，缓存键仍是
 * `label + path`）：另开一个读取器会造成两份节流缓存、两份解析、两套坏文件
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
 * @param locator - 必填装配接线
 * @param onFileEvent - 与账号表同一个事件回调（缺省不产生日志副作用）
 * @returns 策略（深度冻结）；用户不存在或未配 `acl` 返回 undefined
 */
export function loadUserPolicy(
  username: string,
  locator: AccountLocator,
  onFileEvent?: (event: JsonFileEvent) => void,
): UserPolicy | undefined {
  const account = accountIndex(readAuthUsers({ locator, onEvent: onFileEvent }).value).get(username);
  return account === undefined || account.acl === undefined ? undefined : frozenPolicy(account.acl);
}

/**
 * 已冻结配额的记忆表：**按源配额对象身份**命中，快照不变即零分配返回
 * @description 与 `frozenPolicies` 同一手法（判据 = 读取缓存内容未变时返回同一批
 * 对象）：`UsageAccount.consume` 是**每 chunk** 调用（一次大文件传输能调用几万次），
 * 「每次深冻结一份新对象」在这种频次上是纯浪费。记忆表按账号规模自动分槽（key 是对象本身），
 * 随缓存条目一起被 WeakMap 回收，不留悬垂引用。
 */
const frozenQuotas = new WeakMap<UserQuota, UserQuota>();

/**
 * 深拷贝并冻结一份配额：绝不把读取缓存里的对象引用交给调用方
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
 * **复用账号表的同一条读取路径**（`readAuthUsers` → `@/utils/json-file`，缓存键仍是
 * `label + path`）：与 `loadUserPolicy` 完全同构，故热加载语义逐字一致
 * （1s stat 节流、坏内容保留上一份有效值、缺失 = 空表），也**不会**出现两份节流缓存、
 * 两份解析、两套坏文件处理互相污染同一缓存键。
 *
 * **零分配**：`consume` 是每 chunk 调用的热路径，故定位账号用下标循环、冻结结果按源对象身份
 * 记忆；配额快照未变时本函数**不再产生任何新对象**，连续两次查询返回**同一对象身份**。
 *
 * **判定不在本模块**：本模块只提供数据。「超了没有」的裁决住在
 * `@/datasource/quota/mirror.ts:UsageMirror`（单一合计上限 `bytes`，
 * 累计 **>** 上限即拒，恰好等于放行）。
 *
 * @param username - 账号用户名
 * @param locator - 必填装配接线
 * @param onFileEvent - 与账号表同一个事件回调（缺省不产生日志副作用）
 * @returns 配额（深度冻结）；用户不存在或未配 `quota` 返回 undefined（= 不限流）
 */
export function loadUserQuota(
  username: string,
  locator: AccountLocator,
  onFileEvent?: (event: JsonFileEvent) => void,
): UserQuota | undefined {
  const account = accountIndex(readAuthUsers({ locator, onEvent: onFileEvent }).value).get(
    username,
  );
  return account === undefined || account.quota === undefined
    ? undefined
    : frozenQuota(account.quota);
}

/**
 * 账号表里是否至少有一个账号配了 `expiresAt`
 * @description
 * 这是**启动期 `account-table-inert` 告警的一半判据**：`AUTH_TYPE=jwt` 时身份来自 token 的
 * `sub`、**不查账号表**，故账号上的 `expiresAt` **不生效**（jwt 的过期由 token 自己的 `exp`
 * 裁决）。配了而不报，等于收下一个「看起来配了、实际没做」的限制——正是本仓最恨的假安全感。
 *
 * **签名与理由同 `hasConfiguredQuota`**：只收装配接线（纯判定、不观察也不发布任何东西），
 * 走 `loadAuthUsers` 那条 1s 节流读取路径，判据是**文件事实**而不是配置猜测。
 *
 * **刻意不判「是否已过期」**：本函数只答「有没有人配过」。「现在有没有人过期」是**每请求**的判定，
 * 住在 `core/identity/token.ts:TokenIdentityBase.identify`；混进启动期告警会让「一个早就过期、
 * 早就该被拒的账号」在每次启动时也报一遍「配了不生效」这种不相干的噪音。
 * @param locator - 必填装配接线
 * @param onEvent - 与账号表同一个事件回调（缺省不产生日志副作用）
 * @returns 至少一个账号带 `expiresAt` 时为 true
 */
export function hasAccountExpiry(
  locator: AccountLocator,
  onEvent?: (event: JsonFileEvent) => void,
): boolean {
  return loadAuthUsers(locator, onEvent).some((a) => a.expiresAt !== undefined);
}

/**
 * 账号表里是否至少有一个账号配了 `disabled: true`
 * @description
 * 与 {@link hasAccountExpiry} **逐字同构**的另一半判据，同一个启动期 `account-table-inert` 告警。
 * 两者**刻意是两个函数而不是一个带参数的**：「某个字段有没有人配过」是**数据事实**（本层的职责），
 * 而「这些字段在哪种身份模式下会不会被读」是**策略**（`src/runtime/runtime.ts` 那一个门禁点的
 * 职责）。合成一个 `hasAccountFlags(locator, fields)` 会把「jwt 不查账号表」这个身份域的知识
 * 塞进数据源层——而数据源层零 `@/config` 依赖正是它能脱离代理单用的前提。
 *
 * 判据是 `=== true` 而不是「键存在」：`disabled: false` 与缺省逐字同义，把它算成「配了」会让
 * 一个把所有账号都显式写成 `false` 的部署每次启动都收一条「配了不生效」。
 * @param locator - 必填装配接线
 * @param onEvent - 与账号表同一个事件回调（缺省不产生日志副作用）
 * @returns 至少一个账号带 `disabled: true` 时为 true
 */
export function hasAccountDisabled(
  locator: AccountLocator,
  onEvent?: (event: JsonFileEvent) => void,
): boolean {
  return loadAuthUsers(locator, onEvent).some((a) => a.disabled === true);
}
