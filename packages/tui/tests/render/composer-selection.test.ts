/**
 * 需求 1 §1.2 / §1.4：输入区那一段选区是**真反色**（底色与字色两档**明暗相反**），
 * 而**插入符仍是反底色块** —— 两者是两个通道，恒不同时出现。
 *
 * @description
 * ⚠️ 这一档守的是「同色就看不见」那一条：同色底与字的那个实现在**类型上完全合法**（两格都是 `Tone`）
 * ⇒ 屏上选中的那段一个字都读不出来，而**没有任何一条断言会红**。⚠️ 判据因此必须**两个通道都问**
 * （`bgAtColumn` 与 `sgrColorAt(.., "fg")`），而「两个事实不许渲染成同一个东西」要求它们**两两可分**。
 *
 * @module tests/render
 */

import { describe, expect, it, vi } from "vitest";

// ⚠️ 必须在 ink（因而 chalk）被 import 之前设好，否则着色判据恒为「没有序列」—— 见本目录 `AGENTS.md`
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { geometry } from "@/lib/geometry.js";
import { selectionInk, themeOf, toneColor, type Theme } from "@/theme/index.js";
import {
  bgAtColumn,
  bgSgrOf,
  fgSgrOf,
  geoInput,
  indexOfText,
  props,
  rawIndexOfColumn,
  renderRaw,
  sgrColorAt,
} from "./_harness.js";

/** **不盖遮罩**时的那份主题（输入区吃的就是它 ⇒ 找色必须按它取，拿遮罩态那一档去搜恒搜不到） */
const card = (): Theme => themeOf({ color: true, scrimmed: false });

/** 那一行里「前景与背景**都是** `selected`」那一格的显示列（`-1` = 一个都没有） */
function reverseBlockIn(line: string, columns: number): number {
  const block = bgSgrOf(toneColor("selected", card())!);
  const glyph = fgSgrOf(toneColor("selected", card())!);
  for (let x = 0; x < columns; x += 1) {
    if (bgAtColumn(line, x) !== block) continue;
    const at = rawIndexOfColumn(line, x);
    // ⚠️ **探针先自检**：那一列没有格子时 `rawIndexOfColumn` 给 `-1`，而 `sgrColorAt` 在 `-1` 上恒给 `null`
    if (at >= 0 && sgrColorAt(line, at, "fg") === glyph) return x;
  }
  return -1;
}

describe("需求 1 §1.4：选区是**真反色**，而插入符仍是反底色块", () => {
  it("⚠️ 选中的那一段**底色与字色两档不同**（同色 = 一个字都读不出来）", async () => {
    const ink = selectionInk();
    // ⚠️ **两档真的不同**：否则下面那几条是「两处取到了同一个值」上的恒绿
    expect(toneColor(ink.background, card())).not.toBe(toneColor(ink.foreground, card()));
    const p = props({ color: true, input: "hello world", cursor: 11, inputSelection: { start: 6, end: 11 } });
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    const line = raw[g.inputTextRows[0]!.y] ?? "";
    // ⚠️ **反向自检**：那一段**真的在屏上**（探针找不到的话下面那几条恒假，
    // 而症状与「实现压根没画选区」一模一样）
    const at = indexOfText(line, "world");
    expect(at).toBeGreaterThanOrEqual(0);
    const wantBg = bgSgrOf(toneColor(ink.background, card())!);
    const wantFg = fgSgrOf(toneColor(ink.foreground, card())!);
    const x0 = g.inputTextRows[0]!.x + 6;
    // ⚠️ **逐格**量那五个字符：少一格的话选区看起来是「少了一个字」
    for (let i = 0; i < 5; i += 1) {
      expect(bgAtColumn(line, x0 + i), `第 ${String(i)} 格的底色`).toBe(wantBg);
      const cell = rawIndexOfColumn(line, x0 + i);
      expect(cell, `第 ${String(i)} 格没有格子`).toBeGreaterThanOrEqual(0);
      expect(sgrColorAt(line, cell, "fg"), `第 ${String(i)} 格的字色`).toBe(wantFg);
    }
  });

  it("⚠️ 选区**外面**的那几格不带那一层底色（多画一格就是选中了没选的东西）", async () => {
    const wantBg = bgSgrOf(toneColor(selectionInk().background, card())!);
    const p = props({ color: true, input: "hello world", cursor: 11, inputSelection: { start: 6, end: 11 } });
    const g = geometry(geoInput(p));
    const line = (await renderRaw(p))[g.inputTextRows[0]!.y] ?? "";
    const x0 = g.inputTextRows[0]!.x;
    for (const offset of [0, 5, 11]) {
      expect(bgAtColumn(line, x0 + offset), `第 ${String(offset)} 格`).not.toBe(wantBg);
    }
  });

  it("⚠️ 选区与插入符是**两个通道**：有选区时屏上没有一个格子是「同色反底色块」", async () => {
    const p = props({ color: true, input: "hello world", cursor: 11, inputSelection: { start: 6, end: 11 } });
    const g = geometry(geoInput(p));
    const on = await renderRaw(p);
    // ⚠️ **反向自检**：同一份输入、**没有选区**时那个块**必须**在（否则下面那一条是恒真，
    // 而症状与「实现压根不画插入符」一模一样）
    const off = await renderRaw(props({ color: true, input: "hello world", cursor: 11 }));
    expect(reverseBlockIn(off[g.inputTextRows[0]!.y] ?? "", p.columns)).toBeGreaterThanOrEqual(0);
    // ⚠️ 而有选区时它**整个不在**（有选区时按任何可打印键都会替换整段 ⇒ 两个块同时在屏上是假的）
    expect(reverseBlockIn(on[g.inputTextRows[0]!.y] ?? "", p.columns)).toBe(-1);
  });

  // ⚠️ 选区那两端是**原串**的下标，而每一视觉行只是它的一段 ⇒ 两端必须**各自夹进那一行**。
  // 少夹一处的话每行都从第 0 个字开始吃（症状是「只选了三个字，前面的全没了」）。
  it("⚠️ **跨行**的选区在每一行都被夹住（不多吃也不少吃）", async () => {
    const wantBg = bgSgrOf(toneColor(selectionInk().background, card())!);
    const p = props({ color: true, input: "aaa\nbbb", cursor: 0, inputSelection: { start: 1, end: 5 } });
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    expect(g.inputRows).toBe(2);
    const first = raw[g.inputTextRows[0]!.y] ?? "";
    const second = raw[g.inputTextRows[1]!.y] ?? "";
    const x0 = g.inputTextRows[0]!.x;
    const x1 = g.inputTextRows[1]!.x;
    // 「aaa」那一行吃掉原串下标 1..3（两个字符），「bbb」那一行吃掉 4..5（一个字符）
    expect(bgAtColumn(first, x0 + 0), "第一行的第 0 格").not.toBe(wantBg);
    expect(bgAtColumn(first, x0 + 1), "第一行的第 1 格").toBe(wantBg);
    expect(bgAtColumn(first, x0 + 2), "第一行的第 2 格").toBe(wantBg);
    expect(bgAtColumn(first, x0 + 3), "第一行的第 3 格").not.toBe(wantBg);
    expect(bgAtColumn(second, x1 + 0), "第二行的第 0 格").toBe(wantBg);
    expect(bgAtColumn(second, x1 + 1), "第二行的第 1 格").not.toBe(wantBg);
  });
});