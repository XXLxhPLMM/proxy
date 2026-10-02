/**
 * @fileoverview 账号数据源的**端口**与形状类型
 * @module datasource/users/types
 * @description
 * 账号表是本仓唯一一份「既是配置、又要支持多种存放方式」的数据。本模块只声明**形状**：
 * 端口 `AccountSource`、一条读选项、账号条目本身，以及装配接线 `AccountLocator`。
 *
 * ## 抽象落在「**数据从哪来**」，不落在「数据是什么意思」
 *
 * 这是本层唯一的设计决策，也是它能同时服务多个实现器的原因：**形状校验只有一份**
 * （`./validate.js:validateAuthUsers`），每个实现器都把原始值交给它。SQLite 档因此**不重新
 * 实现任何校验**——它把每行账号读成一条 JSON 文档、拼回数组、丢给同一个 `validateAuthUsers`。
 *
 * 换来的硬性质：**多个后端不可能对「什么是合法账号」有分歧**。若让 SQLite 档自己逐列判
 * （`quota_bytes` 是不是非负安全整数、`expiresAt` 有没有时区偏移……），那份判据就是第二份
 * 真相源，而它与 JSON 档漂移的那一天，就是「配了 sqlite、行为悄悄不同」的开始。
 *
 * 代价要认：**SQLite 档放弃了一部分查询能力**（不能 `WHERE quota_bytes > 0`）。但账号表是
 * **只读**的、规模是「几百到几千行」，整表读进内存与读 JSON 文件是同一个量级。为了
 * 「能不能在 SQL 里筛」去复制一份校验，代价远大于收益。
 *
 * ## 名字为什么是「数据源」而不是「存储」
 *
 * 端口的判据是「**账号数据从哪来、怎么整张取出来**」，而 `AUTH_USERS_FILE` / `AUTH_USERS_DB`
 * 存的是什么文件、放在哪个容器上，**不参与任何判据**。叫 `Store` 会把「它是代理配置的附属
 * 存储」写进名字，而事实正相反：装配一份账号数据源**不启动代理**也成立（`driver.ts` 文件头
 * 裁决了驱动名是开放集合的理由）。
 */

import type { DataSourceDriver } from "../driver.js";
import type { QuotaWindow } from "../quota-window.js";
import type { JsonFileEvent, JsonFileRead } from "@/utils/json-file/index.js";

/** 读取选项（各实现器同形，故调用方无需知道后端） */
export interface AccountListOptions {
  /** 跳过节流强制重读（启动期校验用） */
  readonly force?: boolean;
  /** 状态迁移事件回调（`error` / `missing` / `recovered` / `reloaded`） */
  readonly onEvent?: (event: JsonFileEvent) => void;
}

/**
 * 账号表的**数据源端口**
 * @description
 * 只暴露「整张表」这一个读出口，**刻意不做按用户取单条**：`loadUserPolicy` / `loadUserQuota`
 * 已经是「读整张表 + 内存线性扫」的实现（每请求 / 每 chunk 调用，靠零分配与对象身份记忆
 * 摊平成本，见 `../users/read.ts` 那两处的注释），而它拿到的是**同一份数组对象**（内容未变时
 * `readCachedSource` 返回缓存里那一个），所以按用户取单条并不会更省——只会让「同一时刻
 * 读两次可能读到两个不同快照」成为可能。
 */
export interface AccountSource {
  /** 本实现器对应的后端（诊断与测试断言用；**不参与任何判据**） */
  readonly kind: DataSourceDriver;
  /**
   * 取整张账号表
   * @description 语义（各后端**逐条一致**）：缺失 = 空表且不算错误；坏内容 = **保留上一份
   * 有效值**并给出 `error`（不接管）；内容未变 = 返回**同一个数组对象**（热路径靠它零分配）。
   */
  list(options?: AccountListOptions): JsonFileRead<AuthAccount[]>;
  /**
   * 写入 / 覆盖一个账号（**upsert**，按 `username`）
   * @returns 写入后该账号的归一化形态（`validateAuthUsers` 的产物，非你传进去的那份）
   * @throws 形状非法时抛错（**不**静默丢字段）——调用方拿到的是「这份数据配不了」的明确答案
   * @description
   * ⚠️ **整条替换，不是字段级合并**。只影响**该 `username` 这一条**（别的账号逐字不动），
   * 但这条账号的**其它可选键会被一起清掉**：想给 alice 加一条 `acl` 而漏传了她的 `quota` /
   * `expiresAt` / 旧 `acl`，那三项就**消失了**（且消失是静默的——那正是 upsert 该有的样子，
   * 但它是本仓最容易造成「配额莫名其妙没了」的一个动作）。
   *
   * **要改一个字段就先读出来、改、再写回**：
   * `const cur = s.list().value.find(a => a.username === "alice"); s.put({ ...cur, acl })`。
   * 没有「patch 一个键」的接口是刻意的：patch 语义要在每个后端上各实现一遍（JSON 档读-改-重写、
   * sqlite 档 `UPDATE` 单列），而单列 `UPDATE` 出来的记录**未必还过 `validateAuthUsers`** ——
   * 那正是「写得进去、读不出来」的来源。整条替换让「落盘 = 校验过的字节」这条性质对每个入口
   * 都成立。
   *
   * @note 写完**不**主动清读缓存：下一次 `list()` 最迟 1s（`maxAgeMs`）后自然看到新值。
   *   主动清缓存需要一个跨后端统一的 cache key 反查，那是「缓存归读取器管」这条纪律的破口。
   */
  put(account: AuthAccount): AuthAccount;
  /** 删除一个账号；`username` 不存在时**静默成功**（upsert 语义下的 delete 无需区分） */
  delete(username: string): void;
}

/**
 * 路径解析器：**现取**，不是构造期烤进去的字符串
 * @description 实现器若持有固定路径、而装配层又记忆化了实现器实例，那么「改配置指向另一个
 * 账号文件」就**永远不生效**——而 `AUTH_USERS_FILE` / `AUTH_USERS_DB` 恰恰是文档写明可热改的
 * 字段。记忆的必须是「不可变的东西」（哪个实现器），路径交给闭包现取，两者不混。
 */
export type PathResolver = () => string;

/**
 * 一个驱动名对应的那份东西（注册表的 `T`）
 * @description **只吃一个路径闭包，不吃任何配置端口**——于是本层的全部类型都不必认识
 * `ConfigAccessor`，「这个数据源单独用、不经配置装配」在类型上就成立。闭包而不是字符串
 * 的理由见 {@link PathResolver}。
 */
export type AccountSourceFactory = (locator: PathResolver) => AccountSource;

/**
 * 账号数据源的**装配接线**：驱动名与路径，两者都是**现取**
 * @description
 * 本层与配置层之间**唯一的接缝**。配置层的「哪个键装哪个驱动」经它变成两个闭包，本层拿到
 * 的就是「现在是哪个驱动」「现在在哪个位置」这两个答案，**完全不知道键名、也不知道
 * `ConfigAccessor` 长什么样**。
 *
 * ⚠️ **两个成员都必须是函数而不是值**：`AUTH_USERS_DRIVER` 与 `AUTH_USERS_FILE` /
 * `AUTH_USERS_DB` 都是 **runtime 相位**（可热改），烤成字符串就让「改配置指向另一个账号源」
 * 永远不生效。记忆的必须是「不可变的东西」（哪个实现器），路径交给闭包现取，两者不混。
 *
 * `pathFor` **收驱动名**而不是裸路径：一条接线同时服务多个驱动（换驱动就换位置），而
 * 「哪个驱动读哪个键」是**配置层**的知识，配置层经 `pathFor(driver)` 回答它，实现器因此不必
 * 认识 `AUTH_USERS_DB`。
 */
export interface AccountLocator {
  /** 当前驱动名（现读：`AUTH_USERS_DRIVER` 是 runtime 相位） */
  readonly driver: () => DataSourceDriver;
  /** 给定驱动对应的数据位置（现取：路径字段也是 runtime 相位） */
  readonly pathFor: (driver: DataSourceDriver) => string;
}

/**
 * @description 形状与全局 `acl.json:AclList` 同形，但**刻意不共用那个类型**：全局组与
 * 按用户组是两类语义（全局组缺失 = 放行策略的兜底、用户组缺失 = 该用户不受额外限制），
 * 共用一个类型名会让将来任一侧扩字段静默传染另一侧。真正必须单一份的是**条目语法**，
 * 那已由 `src/utils/addr/host.ts:parseHostRule` 保证。
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
   * 可选：该用户专属的流量配额（计量与耗尽判定见 `@/datasource/quota/`）。
   * 同样**对凭证索引不可见**，理由与 `acl` 一致：凭证比对只认用户名+密码。
   * 归一化后 `bytes` 恒为 number，**0 = 不限流**；`window` 缺省时不写键
   * （缺省 = `month`，由消费侧 `datasource/quota-window.ts:quotaWindow` 归一）。
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
   *   非法的是**形态**（见 `../users/validate.ts:normalizeAccountExpiry`）。
   * - **`AUTH_TYPE=jwt` 下本字段不生效**：jwt 的用户名取自 token 的 `sub`、**不查账号表**，
   *   它的过期由 token 自己的 `exp` 声明裁决（`core/helpers/credentials.ts:verifyHs256Jwt`）。
   *   「配了不生效」正是假安全感，故启动期有一条 `account-table-inert` 告警兜着。
   * - **与配额窗口正交**：配额是「用量」的时间窗（`quota.window`，滚动即清账），本字段是
   *   「账号」的有效期（到点即拒）。两者互不影响，账号过期也**不清用量**。
   */
  expiresAt?: number;
  /**
   * 可选：**该账号当前被人工禁用**。判定在 `core/identity/token.ts:TokenIdentityBase.identify`
   * （凭证命中**之后**），审计 `auth.decided` 带 `reason = "account-disabled"`。
   * @description
   * - **缺省即启用**；`disabled: false` 与缺省逐字同义，**两者都合法**（显式写 `false` 不会被
   *   归一化成缺省：那是运维刚写下的意图，替他擦掉等于让「我明明开了」与「我明明关了」在文件里
   *   长得一样）。归一化保留布尔本身，只是不写 `undefined` 键。
   * - **必须真的是布尔**（`"true"` / `1` / `null` 一律非法 → 整份表作废）。理由与 `acl` /
   *   `quota` 同源：收下一个「看起来配了禁用、实际按没配跑」的值等于给假的安全感。
   * - **对凭证索引不可见**（理由与 `expiresAt` 逐字相同且更硬）：索引同时供出站剥离判据
   *   （`isOwnCredential`）使用，把被禁用的账号从索引里剔除会让它的凭证**不再被剥掉**、原样
   *   转发给目标站。凭证没被识别 ≠ 凭证不存在。索引里没有它**不是漏洞**——方向是「宁可多剥」。
   * - **不追溯已建立的连接**：与 `expiresAt` 同理，判定点在**认证点**，一条 CONNECT / SOCKS
   *   隧道不会因为中途被禁用而断开（HTTP keep-alive 的下一个请求会重新认证 → 被拒）。
   * - **`AUTH_TYPE=jwt` 下本字段不生效**：jwt 的用户名取自 token 的 `sub`、**不查账号表**。
   *   「配了不生效」正是假安全感，故启动期有一条 `account-table-inert` 告警兜着。
   * - **与 `expiresAt` 的判定次序**：先 `disabled` 后过期。`disabled` 是**当下的主动决定**，
   *   到期是**日历推着走**的结果；两者都成立时报前者，因为「谁禁的他」比「他什么时候到期」更能
   *   指导运维下一步动作。
   * - **与 `quota` 正交**：禁用不清已用流量，重新启用后当前窗口的累计值原样继续（滑窗清账的
   *   判据是窗口键，与账号是否被禁过无关）。
   */
  disabled?: boolean;
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
 * - `window` **可选**（缺省 = `month`，由消费侧 `datasource/quota-window.ts:quotaWindow` 归一），
 *   且只认 `day` / `month` 两个**日历窗**字面量（闭合集合）。不设滚动窗：滚动窗的运维解释
 *   成本高（「为什么现在被拒了」答不上来），且判定要跨多个历史窗口做聚合，与账本
 *   「滚动即清账」的惰性模型（无定时器）不相容。窗口键的计算与 DST 取舍见
 *   `src/datasource/quota-window.ts` 文件头。
 */
export interface UserQuota {
  /**
   * 双向合计累计上限（上传 + 下载算在一起）；0 = 不限。
   * @description 判定是「累计 **>** 上限才拒」（恰好等于上限放行）。**剩余 = `bytes - usage`**，
   * 刻意不另开一个 `remaining` 出口：那是纯减法，而「未配配额 / 0 上限 = 无限」时它该返回什么
   * （`Infinity` / `null` / 负数）是个没有好答案的分支。消费方用
   * `UsageAccount.usage(user)` 拿到当前窗口的已用量即可。
   */
  readonly bytes: number;
  /**
   * 配额窗口（日历窗）。**缺省即 `month`**，故本键在未配置时**不出现**于归一化产物中
   * （判据：未配 `window` 的账号，其归一化产物逐字等于 `{ bytes }`）。
   */
  readonly window?: QuotaWindow;
}
