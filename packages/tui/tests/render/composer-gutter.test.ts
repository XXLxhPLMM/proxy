/**
 * 需求 1 §1.5：输入框左边**那一列箭头**贯穿整个输入内容高度，字形**恒在最上面那一格**，
 * 下面每一格是一竖线；而每一行文字恒从 `inputContent.x + PROMPT_COLUMNS` 起（悬挂缩进）。
 *
 * @description
 * ⚠️ 这一档守的是**硬换行**那一条（旧版只有第 0 行有 `❯ `、续行是空格 ⇒ 换行之后第一个字符
 * 与输入区左缘不对齐）。⚠️ **软折**（一个长串自动折开）走的是同一条路，故两条都验 ——
 * 只喂硬换行的话「按显示列软折」那个分支零鉴别力。
 *
 * @module tests/render
 */

import { describe, expect, it, vi } from "vitest";

// ⚠️ 必须在 ink（因而 chalk）被 import 之前设好，否则着色判据恒为「没有序列」—— 见本目录 `AGENTS.md`
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { PROMPT_COLUMNS, geometry } from "@/lib/geometry.js";
import {
  columnOfIndex,
  geoInput,
  indexOfText,
  props,
  rawIndexOfColumn,
  renderRaw,
  stripAnsi,
} from "./_harness.js";

/** 那个箭头字形与那一竖列（⚠️ 与 `Composer` 里那两个常量**逐字同源**才叫「同一枚」） */
const ARROW = "❯";
const BAR = "│";

/** 那一帧里 `needle` 出现在第几行（`-1` = 没有） */
function rowOfNeedle(raw: readonly string[], needle: string): number {
  return raw.findIndex((line) => stripAnsi(line).includes(needle));
}

describe("需求 1 §1.5：箭头槽是一整列，字形恒在最上面那一格", () => {
  it("⚠️ 硬换行之后**每一行的第一个字落在同一列**（旧版那个 bug 就是续行顶格画）", async () => {
    const p = props({ input: "abc\ndef", cursor: 0 });
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    expect(g.inputRows).toBe(2);
    // ⚠️ **期望值从几何层取**而不是写死：那些矩形**就是**「点输入行落点」用的列
    const firstAt = columnOfIndex(raw[g.inputTextRows[0]!.y] ?? "", indexOfText(raw[g.inputTextRows[0]!.y] ?? "", "abc"));
    const secondAt = columnOfIndex(raw[g.inputTextRows[1]!.y] ?? "", indexOfText(raw[g.inputTextRows[1]!.y] ?? "", "def"));
    // ⚠️ **探针先自检**：给 `-1` 时「两者相等」对两个 `-1` 恒成立，而症状与「实现没对齐」一模一样
    expect(firstAt).toBeGreaterThanOrEqual(0);
    expect(secondAt).toBeGreaterThanOrEqual(0);
    expect(firstAt).toBe(g.inputTextRows[0]!.x);
    expect(secondAt).toBe(g.inputTextRows[1]!.x);
    expect(secondAt).toBe(firstAt);
  });

  it("⚠️ 第 0 格是**那一个箭头**、下面每一格是**一竖列**，而箭头整帧只出现一次", async () => {
    const p = props({ input: "abc\ndef\nghi", cursor: 0 });
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    expect(g.inputRows).toBe(3);
    for (let i = 0; i < g.inputRows; i += 1) {
      const line = raw[g.inputTextRows[i]!.y] ?? "";
      // ⚠️ **按显示列取那一格**（`rawIndexOfColumn`）而不是按字符下标切：这一行上有侧边栏与边框，
      // 而中文一个字占两列 ⇒ 按下标切会落在半个字上，而症状是「量到的是上面那一格」。
      const slot = g.inputGutter!;
      const at = rawIndexOfColumn(line, slot.x);
      expect(at, `第 ${String(i)} 行那一列没有格子`).toBeGreaterThanOrEqual(0);
      expect(line[at], `第 ${String(i)} 行的箭头槽`).toBe(i === 0 ? ARROW : BAR);
    }
    // ⚠️ **反向自检**：整帧里那枚箭头**只出现一次**（每一行都重复它的话是「每行一个提示符」，
    // 而那样续行那个箭头与文字之间就没有竖线了 ⇒ 气泡左边参差不齐）
    const arrows = raw.filter((line) => stripAnsi(line).includes(ARROW)).length;
    expect(arrows).toBe(1);
    // ⚠️ **紧跟着的那一行（框内的瞬时消息）头上没有那一竖列**：它是消息不是「敲的字」，
    // 而它上面悬一竖线会读成「这一行也在输入框里」⇒ 那一列**只覆盖文本行**。
    const noticeAt = rawIndexOfColumn(raw[g.inputContent!.y + g.inputRows] ?? "", g.inputGutter!.x);
    expect(noticeAt).toBeGreaterThanOrEqual(0);
    expect((raw[g.inputContent!.y + g.inputRows] ?? "")[noticeAt]).toBe(" ");
  });

  it("⚠️ **软折**那一条路也一样：续行顶格的那个字与第一行的字在同一列", async () => {
    // ⚠️ 长度按几何层给的折行宽度现算（抄一份行宽的话改几何不改断言 ⇒ 恒绿）
    const g0 = geometry(geoInput(props()));
    const textWidth = g0.inputTextRows[0]!.width;
    const long = "y".repeat(textWidth + 5);
    const p = props({ input: long, cursor: 0 });
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    expect(g.inputRows).toBe(2);
    expect(rowOfNeedle(raw, "y")).toBe(g.inputTextRows[0]!.y);
    // 折出来的那几行**整行等宽**（几何层给了同一个 x），而屏上第二行的字仍落在那一列
    expect(g.inputTextRows[0]!.x).toBe(g.inputTextRows[1]!.x);
    const second = raw[g.inputTextRows[1]!.y] ?? "";
    const at = rawIndexOfColumn(second, g.inputTextRows[1]!.x);
    expect(at, "折出来那一行那一列没有格子").toBeGreaterThanOrEqual(0);
    expect(second.slice(at, at + 5)).toBe("yyyyy");
  });

  it("⚠️ 箭头槽那一列恒是 {@link PROMPT_COLUMNS} 列，而它**紧贴**输入框内区左缘", async () => {
    const p = props({ input: "a\nb", cursor: 0 });
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    const slot = g.inputGutter!;
    // ⚠️ **期望值取字面量**而不是那个常量：拿常量当期望值的话，改常量与改实现同时发生 ⇒ 恒绿
    expect(PROMPT_COLUMNS).toBe(2);
    expect(slot.width).toBe(2);
    expect(slot.x).toBe(g.inputContent!.x);
    // ⚠️ 而**它那一列真的落在屏上**（几何给了而呈现层没画的话，下面那句 `includes` 恒假）
    const line = stripAnsi(raw[slot.y] ?? "");
    expect(line).toContain(ARROW);
    // ⚠️ **反向自检**：那一行上**不止一个**箭头槽字形 —— 只有一个的话「整帧只出现一次」是恒真的
    expect(line).toContain(BAR);
  });
});