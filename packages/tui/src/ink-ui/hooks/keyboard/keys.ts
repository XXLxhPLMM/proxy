/**
 * @fileoverview 键盘事件的归一层：ink 的 `(input, key)` → 结构化 `KeyboardEvent`
 * @module ink-ui/hooks/keyboard/keys
 * @description
 * 三种事件：`key`（ink 给了标志位的命名键：方向 / home / end / 翻页 / 回车 / tab / 退格 /
 * delete / esc）、`text`（可打印文本，**可能是多字符**——一个 chunk 里的连打，或没开 bracketed
 * paste 时的整块粘贴）、`paste`（整块粘贴，只在 `useKeyboard` 开了 `paste` 时才出现）。
 *
 * ⚠️ **F1–F12 / insert / clear 收不到，也不补**：ink 在键名命中 `nonAlphanumericKeys` 时把
 * `input` 置空，而 `key` 上**没有**给这些键留标志位 ⇒ 它们与「这一下什么都没有」不可区分。
 * 宁可不报也不猜字节，故 `NamedKey` 里没有它们，写 `switch` 的人也不会写出永不执行的分支。
 *
 * ⚠️ **Ctrl+字母是 `text` + `modifiers.ctrl`**：ink 把控制字符提前翻成了字母（`\x01` → `"a"`
 * 且 `ctrl` 为真），判快捷键看 `modifiers.ctrl`，别去 `text` 里找。
 *
 * ⚠️ **Alt 与 Meta 合流到 `alt`**：终端把两者都报在 Meta 位上（与 `MouseModifiers` 对齐）。
 *
 * ⚠️ **鼠标上报会混进来，由本层滤掉**；返回 `null` 即「这一下没有键盘事件」，**仅此一种含义**。
 * ⚠️ **认不出来的终端回询滤不掉**：ink 不告诉我们原序列带没带 ESC，剥过 ESC 的残骸（`[99;7R`）
 * 与「用户真打了一串 `[99;7R`」完全同形，当普通文本收即可。
 *
 * 纯函数层：零 IO、零 React。React 侧在同目录 `use-keyboard.ts`。
 */

import type { Key } from "ink";
import { isMouseSequence } from "@/ink-ui/hooks/mouse/index.js";

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
  if (isMouseSequence(input)) return null;

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