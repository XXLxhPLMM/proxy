/** @fileoverview 输入编辑的纯算术：选区 / 替换 / 换行 / 按显示列上下移 / 命令历史 */
// ⚠️ 零 React / 零终端 / 零 IO（不读时钟、不碰随机数）：这是「能逐字断言」这件事的前提。
// ⚠️ 下标一律 UTF-16 code unit，与 `input-line.js` / `geometry.js` 同一套。

import stringWidth from "string-width";

import { INPUT_HISTORY } from "@/store/index.js";
import { caretRowOf, wrapInput, type WrappedRow } from "./geometry.js";

/** 一段选区（**半开区间** `[start, end)`；`start === end` 是空选区） */
export interface Selection {
  readonly start: number;
  readonly end: number;
}

/** 一次历史召回的结果（⚠️ `at = -1` 是「不在历史里」那一个哨兵，它答的是「清空输入行」那一档） */
export interface HistoryStep {
  /** 填回输入行的那一行 */
  readonly line: string;
  /** 填回之后插入符落在行末（⚠️ 召回的一行是**整条**塞回去的，不带半截插入符） */
  readonly cursor: number;
  /** 那一行在历史里的下标；`-1` = **不在历史里** */
  readonly at: number;
}

function clamp(text: string, at: number): number {
  const asInt = Math.trunc(at);
  return Math.min(Math.max(Number.isFinite(asInt) ? asInt : 0, 0), text.length);
}

/** 选区规范化（`anchor === null` ⇒ 空选区；⚠️ **方向刻意丢掉** —— 两个拖向是同一段） */
export function normalizeSelection(text: string, anchor: number | null, cursor: number): Selection {
  const at = clamp(text, cursor);
  if (anchor === null) return { start: at, end: at };
  const from = clamp(text, anchor);
  return from <= at ? { start: from, end: at } : { start: at, end: from };
}

/** 用 `inserted` 替换整段选区（⚠️ **输入 / 退格 / 删除 / 提交的共同入口**，空选区时是纯插入） */
export function replaceSelection(
  text: string,
  sel: Selection,
  inserted: string,
): { text: string; cursor: number } {
  const start = clamp(text, sel.start);
  const end = clamp(text, sel.end);
  return {
    text: text.slice(0, start) + inserted + text.slice(end),
    cursor: start + inserted.length,
  };
}

/** 在选区处替换成 `\n`（⚠️ **只在这条插入路径上放行** —— 放宽 `printableOnly` 会让粘贴的控制字节进来） */
export function insertNewline(text: string, sel: Selection): { text: string; cursor: number } {
  return replaceSelection(text, sel, "\n");
}

/** 删掉整段选区（⚠️ 空选区是 no-op，插入符不动 —— 「没选东西」时退格该走另一个算式） */
export function deleteSelection(text: string, sel: Selection): { text: string; cursor: number } {
  return replaceSelection(text, sel, "");
}

/** 行内第 `column` 个**显示列**之前是几个 code unit（⚠️ 夹在行内而不是越界） */
function offsetOfColumn(text: string, column: number): number {
  let col = 0;
  let index = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    // ⚠️ `col + w > column` 答的是「这一格属于下一个字」：按字符个数折的话
    // 「点汉字右半边」会插到那个字中间去。
    if (col + w > column) return index;
    col += w;
    index += ch.length;
  }
  return index;
}

/** 前 `units` 个 code unit 在一段文字里占了几个显示列（换行不在这一层：折行时已被切成两段） */
function columnOfUnits(text: string, units: number): number {
  let col = 0;
  let taken = 0;
  for (const ch of text) {
    if (taken >= units) break;
    col += stringWidth(ch);
    taken += ch.length;
  }
  return col;
}

/** 插入符那一行的**显示列**（⚠️ 判据是 `caretRowOf`：行末的光标算**折出来的那一行**的末尾） */
function columnAt(wrapped: readonly WrappedRow[], cursor: number): number {
  const at = caretRowOf(wrapped, cursor);
  const line = wrapped[at.row];
  if (line === undefined) return 0;
  return columnOfUnits(line.text, at.offset);
}

/** 落到目标那一行的同一显示列（答案恒是**原串**里的下标） */
function landOn(wrapped: readonly WrappedRow[], row: number, column: number): number {
  const target = wrapped[row]!;
  return target.start + offsetOfColumn(target.text, column);
}

/** 插入符往上移一行、停在同一显示列（⚠️ 按显示列不按字符个数，短行落行末；到顶 `null`） */
export function caretUp(text: string, cursor: number, width: number): number | null {
  const wrapped = wrapInput(text, width);
  const at = caretRowOf(wrapped, cursor);
  if (at.row === 0) return null;
  return landOn(wrapped, at.row - 1, columnAt(wrapped, cursor));
}

/**
 * 插入符往下移一行、停在同一显示列（`null` = 已在最后一行；与 {@link caretUp} 同一份算式）
 * @description 目标行太短时同样落到行末 —— 与上一行是**同一个**判据，不许两处各写一遍。
 */
export function caretDown(text: string, cursor: number, width: number): number | null {
  const wrapped = wrapInput(text, width);
  const at = caretRowOf(wrapped, cursor);
  if (at.row >= wrapped.length - 1) return null;
  return landOn(wrapped, at.row + 1, columnAt(wrapped, cursor));
}

/** 插入符**在不在第一行**（判据是 {@link caretUp} 会不会给 `null` —— 两处各判一次就会有一处判错） */
export function caretAtFirstRow(text: string, cursor: number, width: number): boolean {
  return caretRowOf(wrapInput(text, width), cursor).row === 0;
}

/** 插入符**在不在最后一行**（判据是 {@link caretDown} 会不会给 `null`） */
export function caretAtLastRow(text: string, cursor: number, width: number): boolean {
  const wrapped = wrapInput(text, width);
  return caretRowOf(wrapped, cursor).row === wrapped.length - 1;
}

/** 提交一行进历史（⚠️ **提交时才入**；空串不入；与最近一条逐字相同的不重复入） */
export function pushHistory(entries: readonly string[], line: string): readonly string[] {
  if (line.trim() === "") return entries;
  if (entries.length > 0 && entries[entries.length - 1] === line) return entries;
  const next = [...entries, line];
  // ⚠️ **从最早那一条开始丢**：最新在末尾，于是超限时被丢的恒是最前面那些
  // （空行会骗走 `↑`，重复行会让 `↓` 要按两遍才回来）
  return next.length > INPUT_HISTORY ? next.slice(next.length - INPUT_HISTORY) : next;
}

/** 从历史里取上一条（更旧的）填回输入行（`null` = 没有更旧的了，按键不动） */
export function historyPrev(entries: readonly string[], currentInput: string): HistoryStep | null {
  if (entries.length === 0) return null;
  // ⚠️ 判据是「这行是不是历史里某一条的那一次出现」：连按 `↑` 自然取更旧，
  // 而用户改过的输入行（不在历史里）取**最新**那一条
  const here = entries.lastIndexOf(currentInput);
  const next = here < 0 ? entries.length - 1 : here - 1;
  if (next < 0) return null;
  const line = entries[next]!;
  return { line, cursor: line.length, at: next };
}

/** 从历史里取下一条（更新的；`↓`）—— 恒**不**给 `null`：到头了本身就是答案（清空输入行） */
export function historyNext(entries: readonly string[], at: number): HistoryStep {
  if (entries.length === 0) return { line: "", cursor: 0, at: -1 };
  const newest = entries.length - 1;
  // ⚠️ `at = -1`（刚清空过）落在**最新那条**上，而不是「往下再走一格」（那会永远停在最新那条）
  const next = Math.min(at, newest) + 1;
  if (next > newest) return { line: "", cursor: 0, at: -1 };
  const line = entries[next]!;
  return { line, cursor: line.length, at: next };
}