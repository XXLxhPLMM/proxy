/**
 * 三档共用的入参与两个 shorthand。
 *
 * ⚠️ 收件门槛是「**两个以上文件真用到**」，不是「看起来通用」：只被一档用到的东西留在那一档里 ——
 * 搬进来就成了一份没人能单独删掉、也没人说得清谁在用的间接层。
 *
 * ⚠️ **`at` 只做两件事**：把用例里那个 `|` 当作光标落点取出来并去掉，再**补上前缀**。它不替用例
 * 推断别的任何东西 —— 一旦它开始猜，「行首那个 `/` 还在不在」这道闸就会从用例里消失，而那道闸
 * 正是 `boundaries.test.ts` 钉住的东西。
 *
 * ⚠️ `NAMES` 乱序给出：它同时是「排序不许依赖喂进来的顺序」那条判据的输入，而一个已经排好序的
 * 样本会让那条判据恒绿。
 *
 * @module tests/complete
 */

import { COMMAND_PREFIX } from "@/commands/parse.js";
import { complete, type Completion } from "@/commands/complete.js";

/** 台账里三个名字（乱序给出：排序不许依赖喂进来的顺序） */
export const NAMES = ["staging", "prod", "dev"] as const;

/**
 * 在 `caret` 处放一个 `|` 便于读，然后把 `|` 去掉
 * @description ⚠️ **这里补上 {@link COMMAND_PREFIX}**：各档的用例写的是**命令名**（`user set …`），
 * 而「必须以 `/` 开头」由 `packages/tui/tests/parse/command-table.test.ts` 那一组断言守，不在这里重复。
 */
export function at(lineWithCaret: string, targetNames: readonly string[] = NAMES): Completion {
  const caret = lineWithCaret.indexOf("|");
  const line = lineWithCaret.slice(0, caret) + lineWithCaret.slice(caret + 1);
  return complete({
    line: COMMAND_PREFIX + line,
    cursor: caret + COMMAND_PREFIX.length,
    targetNames,
  });
}

/** 一次补全的候选（`at` 的 shorthand） */
export function cands(lineWithCaret: string, targetNames: readonly string[] = NAMES): readonly string[] {
  return at(lineWithCaret, targetNames).candidates;
}