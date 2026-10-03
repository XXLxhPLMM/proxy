/**
 * @fileoverview 台账的**编辑面**：全部是纯函数，返回全新的 {@link Ledger}，绝不改入参
 * @module ledger/edit
 * @description
 * 这一层没有 IO、没有校验的判据（判据全在 {@link ./validate.ts}）、也没有渲染：它只回答
 * 「改完之后那份台账长什么样」。输入的合法性由 {@link ./validate.ts:validateTargetInput} 在每个
 * 写操作里现判一遍，而不是让本层假设调用方已经判过 —— 假设过一次的东西，第二次调用就会漏。
 *
 * ## 为什么「不改入参」是硬要求而不是风格偏好
 * @description
 * 界面层的典型写法是「读一份台账 → 连按三次 → 每按一次写一次盘」。若某个函数在连按的过程中
 * 悄悄改了那份共享的台账，那么「撤销」与「重算界面」就会拿到一份已经被改过的东西，而用户看到
 * 的列表还是旧的那份 —— 那类 bug 极难复现也极难定位。纯函数把它变成一次性的：入参是快照，出参是
 * 另一份，回调链里任何一环都能安全地拿旧值。
 *
 * ## ⚠️ `id` 是稳定身份，`name` 是可变显示名
 * @description
 * 改名字**不改 id** —— 因为 `selected` 指着 id，改了它就等于「下次打开连到另一个端点」，而用户做
 * 的只是改了个显示名。反过来改地址与 token 也不改 id：id 是台账内的引用键，一个引用键的语义必须
 * 稳定到「只有删除才会让它消失」。
 *
 * 本模块零 console、零 `process.*`、零 IO。
 *
 * @module
 */

import { LedgerError, validateTargetInput } from "./validate.js";
import type { Ledger, Target, UpsertInput } from "./types.js";

/** slug 为空时的兜底名（全部非 `[a-z0-9-]` 的名字 —— 例如纯中文名 —— 都会落到这里） */
const FALLBACK_SLUG = "target";

/**
 * 名字 → slug
 * @description
 * 小写、非 `[a-z0-9-]` 的字符**整段**折成单个 `-`（连续多个折成段算一个），再去首尾的 `-`。
 *
 * ⚠️ **折成段而不是逐字符替换**，是为了让本函数**幂等**：`slugify(slugify(x)) === slugify(x)`。
 * 不幂等的话，「已存在的 id 是怎么来的」这条推理会在下一次重算时给出另一个答案，而用户看不出
 * 端点被改名了 —— 表现为「同一个端点，昨天叫 `prod--api`、今天叫 `prod-api`」，随后 `selected`
 * 悬空。本层把幂等当作**契约**而不是巧合。
 *
 * @param name - 人给的显示名（任意文本）
 * @returns 一个 `[a-z0-9-]` 的 slug；折不出任何字符时给 {@link FALLBACK_SLUG}
 * @example slugify("  生产 API  ") // => "api"
 * @example slugify("生产环境") // => "target"
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? FALLBACK_SLUG : slug;
}

/**
 * 给一个新端点分配一个没被占用的 `id`
 * @description
 * slug 本身没被占就用它，被占了就 `-2` / `-3` 地递增。**递增而不是随机后缀**：人读 slug 的全部
 * 价值在于「看一眼就知道这条是谁」，而 `a7f3c1` 那类后缀把这个价值整个换掉了 —— 它只在「一定不撞」
 * 这个维度上更好，而撞名的处置（`-2`）同样可预测。
 *
 * 终止性由「`existingIds` 有限」保证，不设上界。
 *
 * @param name - 新端点的显示名
 * @param existingIds - 台账里已占用的 id
 * @returns 一个未被占用的 id
 * @example idFor("prod", []) // => "prod"
 * @example idFor("prod", ["prod"]) // => "prod-2"
 */
export function idFor(name: string, existingIds: readonly string[]): string {
  const taken = new Set(existingIds);
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * 新建或替换一个端点
 * @description
 * - **给了 `id`** = 替换那一条：`id` 不变、它在数组里的位置不变（位置是界面上的显示顺序，用户
 *   排好的序不该因为改一个字段而变），`selected` 也不动 —— 它指着 id，而 id 没变。
 * - **没给 `id`** = 新建：`id` 由 {@link idFor} 分配，并**把 `selected` 指过去**。这是「刚加的端点
 *   就是要连的那个」的默认；反之（新建完不选中）意味着用户加完还得再找一次才用得上。
 *
 * ⚠️ **给了 `id` 而台账里没有它 ⇒ 抛 {@link LedgerError} `invalid-target`**，不静默新建：后者让
 * 「我改的是 A」变成「我多了一个 B」，而 A 还在那儿没被改。
 *
 * @param ledger - 现状（不改）
 * @param input - 新端点 / 端点改动；带 `id` 即替换
 * @returns 新的台账
 * @throws {LedgerError} `invalid-target`：输入不合法，或 `id` 不存在
 * @throws {TuiError} 地址形状不合法（判据在 `@/api`，见 {@link ./validate.ts:validateTargetInput}）
 */
export function upsertTarget(ledger: Ledger, input: UpsertInput): Ledger {
  const checked = validateTargetInput(input);
  const wanted = input.id;
  if (wanted === undefined) {
    const id = idFor(
      checked.name,
      ledger.targets.map((target) => target.id),
    );
    return { version: 1, selected: id, targets: [...ledger.targets, { ...checked, id }] };
  }
  const existing = ledger.targets.find((target) => target.id === wanted);
  if (existing === undefined) {
    throw new LedgerError(
      "invalid-target",
      `台账里没有 id 为 ${wanted} 的端点（改一个不存在的条目 = 静默新建一条，而用户以为改成了）`,
    );
  }
  const targets = ledger.targets.map((target) =>
    target.id === wanted ? { ...checked, id: target.id } : target,
  );
  return { version: 1, selected: ledger.selected, targets };
}

/**
 * 删掉一个端点
 * @description
 * 顺带**清掉指向它的 `selected`**：留一个指向不存在 id 的 `selected`，下次打开就是「查无此人」，
 * 而 {@link ./validate.ts:validateLedger} 会把那种台账判成坏的 —— 于是这份文件会**再也读不出来**，
 * 连里面其余几条好端点一起赔进去。
 *
 * 删一个不存在的 `id` 是**成功的一次 no-op**（不是失败）：用户达到了目的，而数据一个字节都没动。
 *
 * @param ledger - 现状（不改）
 * @param id - 要删的 id
 * @returns 新的台账
 */
export function removeTarget(ledger: Ledger, id: string): Ledger {
  const targets = ledger.targets.filter((target) => target.id !== id);
  return {
    version: 1,
    selected: ledger.selected === id ? null : ledger.selected,
    targets,
  };
}

/**
 * 换掉当前选中的端点
 * @description
 * ⚠️ **指向不存在的 id ⇒ 抛 {@link LedgerError} `invalid-target`**，不静默忽略：一个指向查无此人的
 * `selected` 会让整份台账读不出来（{@link ./validate.ts:validateLedger} 判 `selected` 必须在
 * `targets` 里），而**这份文件是唯一一份凭据副本** —— 它读不出来，后面所有操作全部无从谈起。
 *
 * @param ledger - 现状（不改）
 * @param id - 新的选中 id；`null` = 一个都不选（「下次别自动连」）
 * @returns 新的台账
 * @throws {LedgerError} `invalid-target`：`id` 不存在
 */
export function setSelected(ledger: Ledger, id: string | null): Ledger {
  if (id !== null && !ledger.targets.some((target) => target.id === id)) {
    throw new LedgerError(
      "invalid-target",
      `台账里没有 id 为 ${id} 的端点（selected 指向它会让整份台账读不出来）`,
    );
  }
  return { version: 1, selected: id, targets: [...ledger.targets] };
}

/**
 * 当前选中的那一条
 * @description
 * `selected: null` 或台账里没有它 ⇒ `null`（不抛）：本函数是给界面用的**读**，读到一个空的当前项
 * 应当显示「没选」，而不是让界面崩掉。⚠️ 而 {@link ./validate.ts:validateLedger} 保证「有 selected
 * 必有这条」—— 那个 `?? null` 只服务于未经判据手工拼出来的对象。
 *
 * @param ledger - 现状
 * @returns 那一条端点，或 `null`
 */
export function selectedTarget(ledger: Ledger): Target | null {
  if (ledger.selected === null) return null;
  return ledger.targets.find((target) => target.id === ledger.selected) ?? null;
}
