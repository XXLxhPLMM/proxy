/**
 * 本目录各档共用的入参工厂：一格「工具结果」与一条 `LogEntry`
 *
 * ⚠️ 收件门槛是「**两个以上档真用到**」，不是「看起来通用」：`entry` / `toolTurn` 被 `layout` 与
 * `entry` 两档用着，而 `textsOf` 只有 `layout` 用 —— 它仍留在本目录是因为它是这三个里唯一带
 * 「摊平 + 比对」这层语义的，而摊平那一批用例全在 `layout` 那一档。
 *
 * ⚠️ **零 IO、零 `describe`**：本模块只造数据，判据一律留在各档 —— 于是 import 它不会注册任何 hook。
 *
 * @module tests/log
 */

import { flatten, type LogEntry, type LogRow, type Turn } from "@/lib/log/index.js";

/**
 * 一格「工具结果」—— ⚠️ **结果区那一格装的是 `Turn` 而不是 `LogRow`**（`@/lib/log/turn.js`）。
 * @description 摊平那一批用例要验的是**排版算术**（折行 / 不折行 / 截断），而那些判据的对象是
 * `LogRow`；故这里把行装进 `tool-result` 那一档，于是每一组原有判据**逐字不变**，
 * 而「每个 `Turn` 变体各一例」那条钉的是变体清单本身，不归摊平这批。
 */
export function toolTurn(rows: readonly LogRow[]): Turn {
  return { kind: "tool-result", rows };
}

export function entry(id: number, rows: readonly LogRow[]): LogEntry {
  return { id, at: 0, turns: [toolTurn(rows)] };
}

/** 摊平后的行文本（去掉空行不是必要的，但便于逐字比对） */
export function textsOf(entries: readonly LogEntry[], width: number): string[] {
  return flatten(entries, width).lines.map((l) => l.text);
}