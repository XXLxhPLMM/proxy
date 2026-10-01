/**
 * @fileoverview 账号表的读与改（**结构化结果，零渲染**）
 * @module ops/accounts
 * @description
 * 账号表是本仓**唯一一份「既是配置、又要支持多种存放方式」**的数据，而它的写语义里藏着一个
 * 已被 `AccountSource.put` 的注释点名的陷阱：
 *
 * > ⚠️ **整条替换，不是字段级合并**。只影响该 `username` 这一条（别的账号逐字不动），但这条账号的
 * > 其它可选键会被一起清掉。
 *
 * 于是本模块的全部设计都是围绕**不让运维在不知情的情况下丢掉配额**：
 * - 新建账号遇到已存在的名字**直接拒绝**（新建的字面意思就是「新建」；让它落到 `put` 上就是
 *   一次静默的整条覆盖）。
 * - 改字段 / 禁用启用 / 改密码全部是**读-改-写**：先把现读的归一化账号取出来，在它身上改指定的
 *   字段，再整条 `put` 回去。**未指定的字段逐字保留**。
 * - 每一次 `put` 的载荷都过 `AccountSource.put` 自带的形状校验（`normalizeOne`，走**磁盘形态**
 *   的 `validateAuthUsers`），所以「改一个字段」不可能顺手改坏另一个字段的形态。
 *
 * ## 为什么不提供「删掉某个可选键」以外的任何字段级接口
 *
 * 因为 `put` 只有整条替换一个出口。在它之上发明 `patch(field, value)` 会让「后端支持哪些字段」
 * 这件事在每个后端上各写一遍，而单列 `UPDATE` 出来的记录**未必还过 `validateAuthUsers`** ——
 * 那正是「写得进去、读不出来」的来源。整条替换让「落盘 = 校验过的字节」这条性质对每个后端都成立。
 *
 * @module
 */

import { normalizeAccountExpiry } from "@/datasource/users/index.js";
import type { AuthAccount } from "@/datasource/users/index.js";
import type { OpsChange } from "./change.js";
import { OpsError } from "./error.js";
import { readAccountsOrFail, type OpsSources } from "./sources.js";

/** 账号字段的**局部修改**
 * @description
 * **每个字段都可选，而「缺省」与「显式给值」必须可区分**：`disabled` 的缺省是「不动它」，
 * 「置 true」是显式给值，「置 false」也是显式给值。故这些字段用**三态**表达：
 * `undefined` = 不动，`false`/`0`/`""` = 显式改成那个值。
 *
 * **`quota` 与 `expires` 的「删掉这个键」用字面量 `clear`**而不是某个魔术数值：`0` 已经是
 * 「不限流」的合法值，用它当「删键」会让「我想要无限」和「我想要这个字段消失」变成同一句话。
 * 两者运行期同义（判定层 `quota === undefined` 与 `bytes === 0` 都恒放行），但它们在文件里
 * 长相不同，而这份文件是要被人 diff 的。
 */
export interface AccountPatch {
  /** 新密码（**明文**，落盘前由数据源的形状校验把关） */
  readonly password?: string;
  /** 新的 `quota.bytes`（非负安全整数），或 `"clear"` = 删掉整个 `quota` 键 */
  readonly quotaBytes?: number | "clear";
  /** 新的 `quota.window`（`day` / `month`），或 `"clear"` = 删掉 `quota` 键 */
  readonly quotaWindow?: "day" | "month" | "clear";
  /** 新的 `expiresAt`（**带时区偏移的 ISO 8601**，即磁盘形态），或 `"clear"` = 删键 */
  readonly expiresAt?: string | "clear";
  /** 新的 `disabled`；缺省 = 不动这个字段 */
  readonly disabled?: boolean;
  /** 整份替换该用户个人名单的 `target.whitelist`（空数组 = 清空） */
  readonly targetWhitelist?: readonly string[];
  /** 整份替换该用户个人名单的 `target.blacklist`（空数组 = 清空） */
  readonly targetBlacklist?: readonly string[];
}

/** 按用户名线性找（账号表是几百到几千行，与 JSON 档整表读同量级） */
export function findAccount(
  accounts: readonly AuthAccount[],
  name: string,
): AuthAccount | undefined {
  for (const account of accounts) {
    if (account.username === name) {
      return account;
    }
  }
  return undefined;
}

/**
 * 把一个 `AccountPatch` 施加到一份**已归一化**的账号上，产出一条新账号
 * @description
 * 纯函数：输入是「现读的那条」+「要改什么」，输出是「要 `put` 回去的那条」。**未出现在 patch
 * 里的字段原样带过去**——这是「不弄丢配额」的全部实现。
 *
 * `quota` 与 `expires` 的三态：缺省 = 不动；给了值 = 改；`"clear"` = 删键。
 * ⚠️ **bytes 与 window 分开处理**：`quotaBytes` 为 `clear` 删整个 `quota`，`quotaWindow` 为
 * `clear` 也删整个 `quota`（`window` 不可能脱离 `quota` 单独存在）。反过来只给 `window` 而当前
 * 没有 `quota` 时**报错**而不是凭空造一个 `quota: { bytes: 0, window: "day" }`——那是一条「没配
 * 上限、只有窗口」的记录，而它的语义（不限流、窗口却存在）让人以为有上限在生效。
 *
 * @throws {OpsError} `invalid`：组合不成立（见上）
 */
export function applyPatch(current: AuthAccount, patch: AccountPatch): AuthAccount {
  const next: AuthAccount = { ...current };

  if (patch.password !== undefined) {
    next.password = patch.password;
  }
  if (patch.disabled !== undefined) {
    next.disabled = patch.disabled;
  }
  if (patch.expiresAt !== undefined) {
    if (patch.expiresAt === "clear") {
      delete next.expiresAt;
    } else {
      // ⚠️ **判据取自数据源层那个唯一的归一**（`normalizeAccountExpiry`），**不是**这里的
      // `Date.parse`。`Date.parse("2027-01-01")` 返回一个有限值（UTC 午夜）、
      // `Date.parse("2027-01-01 00:00")` 返回本地午夜——两者与「+08:00 机器上的运维心里想的
      // 那个时刻」差 8 小时，而本仓看不出差别。CLI 自己写一份正则就是第二份真相源，漂了就是
      // 「CLI 认得、代理不认得」——那比 CLI 直接不认更坏。
      const epoch = normalizeAccountExpiry(patch.expiresAt);
      if (epoch === undefined) {
        throw new OpsError(
          "invalid",
          `--expires ${patch.expiresAt} 不是合法的有效期时刻` +
            "（要带时区偏移的 ISO 8601，如 2027-01-01T00:00:00+08:00 或 2027-01-01T00:00:00Z；" +
            "只写日期、空格分隔、日历上不存在的日都判非法）",
        );
      }
      next.expiresAt = epoch;
    }
  }

  // `quota` 的两个字段**必须一起想**，因为 `window` 不可能脱离 `quota` 单独存在：
  //  - 任一侧 `clear` ⇒ 整个 `quota` 删掉（留一个只剩 `window` 的 `quota` 是没有形状的）
  //  - 给 `quotaBytes` ⇒ bytes 改掉、**window 原样带过去**（没配过 quota 就没有 window 可带）
  //  - 只给 `quotaWindow` 而当前没有 quota ⇒ **报错**：那是一条「没配上限、只有窗口」的记录，
  //    而它的语义（不限流）让人以为有上限在生效。要设窗口请一并给 bytes。
  if (patch.quotaBytes === "clear" || patch.quotaWindow === "clear") {
    delete next.quota;
  } else if (patch.quotaBytes !== undefined || patch.quotaWindow !== undefined) {
    if (patch.quotaBytes === undefined && current.quota === undefined) {
      throw new OpsError(
        "invalid",
        "该账号当前没有 quota，--window 没有可依附的字段；要设窗口请一并给 --quota",
      );
    }
    const bytes = patch.quotaBytes ?? current.quota?.bytes ?? 0;
    const window = patch.quotaWindow ?? current.quota?.window;
    next.quota = { bytes, ...(window === undefined ? {} : { window }) };
  }

  if (patch.targetWhitelist !== undefined || patch.targetBlacklist !== undefined) {
    const prev = current.acl?.target;
    next.acl = {
      target: {
        whitelist: patch.targetWhitelist ?? prev?.whitelist ?? [],
        blacklist: patch.targetBlacklist ?? prev?.blacklist ?? [],
      },
    };
  }

  return next;
}

/**
 * 整张账号表（归一化形态）
 * @throws {OpsError} `source-unreadable`：内容读不到或形状非法（**绝不当成空表**）
 */
export function listAccounts(sources: OpsSources): readonly AuthAccount[] {
  return readAccountsOrFail(sources.accounts);
}

/**
 * 按名取一条账号
 * @throws {OpsError} `not-found`：账号表里没有这个名字
 */
export function getAccount(sources: OpsSources, name: string): AuthAccount {
  const target = findAccount(readAccountsOrFail(sources.accounts), name);
  if (target === undefined) {
    throw new OpsError("not-found", `账号表里没有 ${name}`);
  }
  return target;
}

/** 新建一条账号 */
export function addAccount(
  sources: OpsSources,
  name: string,
  password: string,
  patch: AccountPatch,
): OpsChange {
  const existing = findAccount(readAccountsOrFail(sources.accounts), name);
  if (existing !== undefined) {
    // 刻意**不**退化成「改字段」：`put` 是整条替换，让「新建一个已存在的名字」静默成功等于让
    // 「我以为在新建」变成「我顺手清掉了他的配额与有效期」。要改就用改字段那条路，那是有名字的动作。
    throw new OpsError(
      "already-exists",
      `账号表里已经有 ${name}；要改它请用 \`proxy-cli user set ${name} ...\`` +
        "（user add 是新建，绝不覆盖既有账号）",
    );
  }
  const draft: AuthAccount = { username: name, password };
  // `put` 会走 `normalizeOne` → 磁盘形态的 `validateAuthUsers`，故形态非法在这一步就抛错
  sources.accounts.put(applyPatch(draft, patch));
  return { changed: true, message: `已新建账号 ${name}` };
}

/** 改一条**已存在**账号的若干字段（未提及的字段逐字保留） */
export function setAccount(
  sources: OpsSources,
  name: string,
  patch: AccountPatch,
): OpsChange {
  const existing = findAccount(readAccountsOrFail(sources.accounts), name);
  if (existing === undefined) {
    throw new OpsError("not-found", `账号表里没有 ${name}；要新建请用 \`proxy-cli user add\``);
  }
  sources.accounts.put(applyPatch(existing, patch));
  return { changed: true, message: `账号 ${name} 已更新` };
}

/** 只改密码（其余字段逐字保留） */
export function passwdAccount(
  sources: OpsSources,
  name: string,
  password: string,
): OpsChange {
  const existing = findAccount(readAccountsOrFail(sources.accounts), name);
  if (existing === undefined) {
    throw new OpsError("not-found", `账号表里没有 ${name}`);
  }
  sources.accounts.put(applyPatch(existing, { password }));
  return { changed: true, message: `账号 ${name} 的密码已更新` };
}

/** 置禁用 / 启用（其余字段逐字保留） */
export function setAccountEnabled(
  sources: OpsSources,
  name: string,
  disabled: boolean,
): OpsChange {
  const existing = findAccount(readAccountsOrFail(sources.accounts), name);
  if (existing === undefined) {
    throw new OpsError("not-found", `账号表里没有 ${name}`);
  }
  // 走 `applyPatch` 而不是直接构造：这样「整条替换」这件事**只有一个**实现，而它逐字保留了
  // 这条账号的 quota / expiresAt / acl —— 那三项恰恰是最容易被一次「改个开关」顺手清掉的。
  sources.accounts.put(applyPatch(existing, { disabled }));
  return { changed: true, message: `账号 ${name} 已${disabled ? "禁用" : "启用"}` };
}

/** 删掉一条账号（整条，不留残骸） */
export function removeAccount(sources: OpsSources, name: string): OpsChange {
  const existing = findAccount(readAccountsOrFail(sources.accounts), name);
  if (existing === undefined) {
    throw new OpsError("not-found", `账号表里没有 ${name}，没东西可删`);
  }
  sources.accounts.delete(name);
  return { changed: true, message: `已删除账号 ${name}` };
}

/**
 * 账号表里刚被写进去的限制字段，在当前 `AUTH_TYPE` 下会不会被读（给每次改完的一次性提醒）
 * @description
 * 判据与启动期那条 `account-table-inert` 告警**同源**（同一个 `authType === "jwt"` × 同一批
 * 字段），但用途不同：不是「服务起来时喊一嗓子」，而是**每次改完账号表都告诉操作者「你刚写的
 * 这个字段在你这个模式下不生效」**。改完就退出的工具，那条启动期告警要等下次重启才看得见，
 * 而运维很可能不重启 —— 于是「以为把这个账号封住了」会一直活到下一次重启。
 *
 * **这里重新读一次**（而不是复用写之前那份）：要提醒的正是**刚写进去**的内容。写完不主动清读
 * 缓存，而 `force: true` 跳过节流，所以这一次读到的一定是写之后的那份。
 *
 * @returns 一句提醒；无需提醒返回 undefined
 */
export function inertNoticeFor(sources: OpsSources): string | undefined {
  if (sources.config.get("authType") !== "jwt") {
    return undefined;
  }
  const accounts = readAccountsOrFail(sources.accounts);
  const hasExpiry = accounts.some((a) => a.expiresAt !== undefined);
  const hasDisabled = accounts.some((a) => a.disabled === true);
  if (!hasExpiry && !hasDisabled) {
    return undefined;
  }
  return (
    "注意：当前 AUTH_TYPE=jwt 判定不查账号表，刚写入的 expiresAt / disabled 都不会生效" +
    "（要让它们生效请把 AUTH_TYPE 切成 basic 或 uid）"
  );
}