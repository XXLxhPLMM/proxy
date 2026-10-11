/**
 * @fileoverview 键盘事件的归一层：ink 的 `(input, key)` → 结构化 `KeyboardEvent`
 * @module ink-ui/hooks/keyboard/keys
 * @description
 * ink 把终端输入摊平成两个参数：`input` 是原始文本（没认出来的序列会被剥掉前导 ESC），
 * `key` 是一组布尔标志。本模块把这两样折成一个判别联合，视图层 `switch (event.type)`
 * 就能用，不必自己回忆「方向键的 input 是空的」「Ctrl+A 的 input 是字母 a」这类 ink 的内部约定。
 *
 * 三种事件：
 * - `key`：ink 给了标志位的命名键（方向 / home / end / 翻页 / 回车 / tab / 退格 / delete / esc）
 * - `text`：可打印文本，**可能是多字符**（一个 chunk 里的连打，或没开 bracketed paste 时整块粘贴）
 * - `paste`：整块粘贴，只在 `useKeyboard` 开了 `paste` 时才出现（React 侧见同目录 `use-keyboard.ts`）
 *
 * ⚠️ **F1–F12 / insert / clear 收不到，也不补**：ink 的 `use-input.js` 在键名命中
 * `nonAlphanumericKeys` 时把 `input` 置空，而 `key` 上**没有**给这些键留标志位，于是它们到我们
 * 手里是「空 `input` + 标志位全 false」——与「这一下什么都没有」不可区分。宁可不报，也不猜
 * 字节（同一条纪律见 `hooks/mouse/protocol.ts` 的文件头）。因此 `NamedKey` 里没有它们，
 * 写 `switch` 的人拿不到这些分支，也就不会写出永远不执行的死代码。
 *
 * ⚠️ **Ctrl+字母是 `text` + `modifiers.ctrl`，不是命名键**：ink 把控制字符提前翻成了字母
 * （`\x01` → `text: "a"` 且 `ctrl` 为真）。判快捷键要看 `modifiers.ctrl`，别去 `text` 里找。
 *
 * ⚠️ **Alt 与 Meta 合流到 `alt`**：终端把两者都报在 Meta 位上，ink 也只给一个 `meta` 标志。
 * 本层统一叫 `alt`，与 `hooks/mouse/protocol.ts` 的 `MouseModifiers` 对齐。
 *
 * ⚠️ **鼠标上报会混进来，由本层滤掉**：ink 把每个输入广播给**所有** `useInput` 订阅者，
 * 而没认出来的序列它会剥掉前导 ESC ⇒ 鼠标上报到这里时形如 `[<0;12;34M`（背景见
 * `hooks/mouse/use-mouse.ts` 的 ⚠️）。返回 `null` 即「这一下没有键盘事件」，**仅此一种含义**。
 *
 * ⚠️ **认不出来的终端回询（DSR 光标位置报告之类）滤不掉**：ink 不告诉我们原序列带没带 ESC，
 * 剥过 ESC 的残骸（`[99;7R`）与「用户真打了一串 `[99;7R`」在本层完全同形。当普通文本收即可。
 *
 * 纯函数层：零 IO、零 React。React 侧在同目录 `use-keyboard.ts`。
 */

import type { Key } from "ink";
import { parseMouseSequence } from "@/ink-ui/hooks/mouse/protocol.js";

/** 修饰键；`alt` 一项同时覆盖终端的 Alt 与 Meta（见文件头） */
export interface KeyModifiers {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  super: boolean;
  hyper: boolean;
  capsLock: boolean;
  numLock: boolean;
}

/**
 * 归一后的命名键：只含 ink 在 `key` 上留了标志位的那些。
 *
 * ⚠️ 这里**故意**没有 F1–F12 / insert / clear：ink 收不到它们，
 * 列进来只会诱导写出永不执行的分支（见文件头）。
 */
export type NamedKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "return"
  | "tab"
  | "backspace"
  | "delete"
  | "escape";

/** 一次键盘事件：以 `type` 判别，三支的判据互斥且穷尽 */
export type KeyboardEvent =
  | { type: "key"; key: NamedKey; modifiers: KeyModifiers; sequence: string }
  | { type: "text"; text: string; modifiers: KeyModifiers; sequence: string }
  | { type: "paste"; text: string };

/** ink `key` 上表示「命名键」的布尔标志位 */
type KeyFlag =
  | "upArrow"
  | "downArrow"
  | "leftArrow"
  | "rightArrow"
  | "pageUp"
  | "pageDown"
  | "home"
  | "end"
  | "return"
  | "escape"
  | "tab"
  | "backspace"
  | "delete";

/** 标志位 → 归一键名；一条事件只亮一个标志，并列时按下表顺序取先命中的 */
const FLAGS: readonly (readonly [KeyFlag, NamedKey])[] = [
  ["upArrow", "up"],
  ["downArrow", "down"],
  ["leftArrow", "left"],
  ["rightArrow", "right"],
  ["home", "home"],
  ["end", "end"],
  ["pageUp", "pageup"],
  ["pageDown", "pagedown"],
  ["return", "return"],
  ["tab", "tab"],
  ["backspace", "backspace"],
  ["delete", "delete"],
  ["escape", "escape"],
];

/**
 * 把 ink 的一次 `useInput` 回调折成键盘事件。
 *
 * @param input ink 交回的原始文本（未认出的序列已剥掉前导 ESC）
 * @param key ink 交回的标志位集合
 * @returns 事件；这一下**没有**键盘事件时为 `null`——要么是混进来的鼠标上报，要么是 ink
 *          丢掉的键（F1–F12 / insert / clear，见文件头）
 */
export function toKeyboardEvent(input: string, key: Key): KeyboardEvent | null {
  // 判键前先滤鼠标：ink 剥过 ESC 后上报形如 `[<0;12;34M`，符号位全 false，与「无输入」同形
  if (parseMouseSequence(input) !== null) return null;

  const modifiers: KeyModifiers = {
    ctrl: key.ctrl,
    shift: key.shift,
    alt: key.meta,
    super: key.super,
    hyper: key.hyper,
    capsLock: key.capsLock,
    numLock: key.numLock,
  };

  for (const [flag, name] of FLAGS) {
    if (key[flag]) return { type: "key", key: name, modifiers, sequence: input };
  }

  // 空 input 且无标志位 = ink 丢掉的键，不是「按了某个键」，不报也不猜
  if (input === "") return null;

  return { type: "text", text: input, modifiers, sequence: input };
}