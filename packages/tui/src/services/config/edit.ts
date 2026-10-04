/**
 * @fileoverview 台账的**编辑面**：全部是纯函数，返回全新的 {@link Ledger}，绝不改入参；⚠️ 合法性在每个写操作里**现判**一遍，⚠️ **`id` 是稳定身份**而 `name` 是可变显示名
 */

import { LedgerError, validateTargetInput } from "./validate.js";
import type { Ledger, Target, UpsertInput } from "./types.js";

/** slug 为空时的兜底名（全部非 `[a-z0-9-]` 的名字 —— 例如纯中文名 —— 都会落到这里） */
const FALLBACK_SLUG = "target";

/** 名字 → slug（小写，非 `[a-z0-9-]` 的字符**整段**折成单个 `-`，再去首尾的 `-`） */
// ⚠️ **折成段而不是逐字符替换**，是为了让本函数**幂等**：不幂等的话「已存在的 id 是怎么来的」这条推理
// 会在下一次重算时给出另一个答案，而 `selected` 悬空。
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? FALLBACK_SLUG : slug;
}

/** 给一个新端点分配一个没被占用的 `id`（slug 递增 `-2` / `-3` 避让） */
// ⚠️ **递增而不是随机后缀**：人读 slug 的全部价值在于「看一眼就知道这条是谁」。
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
 * 新建或替换一个端点；⚠️ **给了 `id` 而台账里没有它 ⇒ 抛** `invalid-target`，不静默新建（替换时 `id`、位置与 `selected` 都不动）
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

/** 删掉一个端点（顺带**清掉指向它的 `selected`**；删一个不存在的 `id` 是**成功的一次 no-op**） */
export function removeTarget(ledger: Ledger, id: string): Ledger {
  const targets = ledger.targets.filter((target) => target.id !== id);
  return {
    version: 1,
    selected: ledger.selected === id ? null : ledger.selected,
    targets,
  };
}

/** 换掉当前选中的端点（⚠️ **指向不存在的 id ⇒ 抛** `invalid-target`，那会让整份台账读不出来） */
export function setSelected(ledger: Ledger, id: string | null): Ledger {
  if (id !== null && !ledger.targets.some((target) => target.id === id)) {
    throw new LedgerError(
      "invalid-target",
      `台账里没有 id 为 ${id} 的端点（selected 指向它会让整份台账读不出来）`,
    );
  }
  return { version: 1, selected: id, targets: [...ledger.targets] };
}

/** 当前选中的那一条（台账里没有它 ⇒ `null`，不抛：读到一个空的当前项应当显示「没选」） */
export function selectedTarget(ledger: Ledger): Target | null {
  if (ledger.selected === null) return null;
  return ledger.targets.find((target) => target.id === ledger.selected) ?? null;
}