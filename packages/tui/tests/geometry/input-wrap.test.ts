/**
 * 输入串的折行：绘制与命中测试**共用的那一个出口**。
 *
 * @description
 * `wrapInput` 是「一行字 → 若干行」的**唯一**出口（绘制按它画、点击按它回原串），故这一档盯四件：
 *
 * - `rows` **恒 ≥ 1**（空串返回一行而不是零行 —— 零行的话框在清空那一帧塌成一条边）。
 * - 按**显示列**断（一个汉字占两列；按 `String.length` 折的那一档会超宽）。
 * - **一个字符都不许丢**（把折出来的行接起来必须逐字等于原文），且每行的 `start` 就是它第一个字在
 *   原串里的下标（点第二行要靠它回原串）。
 * - **光标落在折出来的那一行**（不是恒在第一行）：`caretRowOf` 从**后**往前扫，而行末的光标算
 *   **这一行**的末尾；越界的光标夹在最后一行的末尾（不给 `-1` —— 那会被拿去索引）。
 *
 * ⚠️ `caretFromWrappedPoint` 的判据刻意构造成「第 0 行塞满 72 列、且第 1 行以汉字开头」：那才是
 * 「点击落点按显示列算」能被验到的形状。⚠️ **下标一律是 UTF-16 code unit**，与 `input-line.ts` /
 * `@/commands/complete.js` / `CaretRow` 四处必须逐字一致。
 *
 * 九条不变量与变异实测表见本目录 `AGENTS.md`。
 *
 * @module tests/geometry
 */

import { describe, expect, it } from "vitest";
import { caretFromWrappedPoint, caretRowOf, geometry, wrapInput } from "@/lib/geometry.js";
import { INPUT_SAMPLES, spec } from "./_shared.js";
describe("不变量 ⑦：折行（绘制与命中测试共用的那一个出口）", () => {
  it("空串返回一行（不是零行）", () => {
    expect(wrapInput("", 10)).toEqual([{ text: "", start: 0 }]);
  });

  it("放得下就一行", () => {
    expect(wrapInput("/status", 40)).toEqual([{ text: "/status", start: 0 }]);
  });

  it("按显示列断：一个 CJK 占两列，故第三列就折行（按 String.length 折的那一档会超宽）", () => {
    const rows = wrapInput("账上", 2);
    expect(rows).toEqual([
      { text: "账", start: 0 },
      { text: "上", start: 1 },
    ]);
  });

  it("一个字符都不许丢（把折出来的行接起来必须逐字等于原文）", () => {
    for (const text of INPUT_SAMPLES) {
      for (const width of [1, 2, 3, 7, 13, 40]) {
        const rows = wrapInput(text, width);
        expect(rows.map((r) => r.text).join("")).toBe(text);
      }
    }
  });

  it("每一行的 start 就是它第一个字在原串里的下标（点第二行要靠它回原串）", () => {
    const rows = wrapInput("/user add charlie 1g", 8);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      expect(row.text).toBe("/user add charlie 1g".slice(row.start, row.start + row.text.length));
    }
  });

  it("单字符比整行还宽时它自己占一行（绝不丢字符，也不多出一行空行）", () => {
    const rows = wrapInput("aa账bb", 2);
    expect(rows.map((r) => r.text).join("")).toBe("aa账bb");
    expect(rows.some((r) => r.text === "账")).toBe(true);
    // ⚠️ **不许在它前面多出一个空行**：折行判据里的 `index > start` 那个半边挡的正是这个 ——
    // 去掉它的话「账」会被推进一个空行里，于是屏上第一行是空的、而框按行数长高了一行。
    expect(wrapInput("账", 1)).toEqual([{ text: "账", start: 0 }]);
    expect(wrapInput("a账", 1)).toEqual([
      { text: "a", start: 0 },
      { text: "账", start: 1 },
    ]);
  });

  it("width ≤ 0 按 1 处理（不是除零、也不是零宽矩形）", () => {
    expect(wrapInput("abc", 0)).toEqual(wrapInput("abc", 1));
    expect(wrapInput("abc", -9)).toEqual(wrapInput("abc", 1));
  });

  it("光标落在折出来的那一行（不是恒在第一行）", () => {
    const rows = wrapInput("/user add charlie 1g", 8);
    expect(caretRowOf(rows, 0)).toEqual({ row: 0, offset: 0 });
    expect(caretRowOf(rows, 8).row).toBe(1);
    expect(caretRowOf(rows, 9).row).toBe(1);
  });

  it("行末的光标算**这一行**的末尾（从后往前扫的结果）", () => {
    const rows = wrapInput("abcd", 2);
    // 两行：ab / cd。光标 2 = 第 0 行末尾，也就是第 1 行开头。
    expect(caretRowOf(rows, 2)).toEqual({ row: 1, offset: 0 });
  });

  it("越界的光标夹在最后一行的末尾（不给 -1 —— 那会被拿去索引）", () => {
    const rows = wrapInput("abcd", 2);
    expect(caretRowOf(rows, 999)).toEqual({ row: 1, offset: 2 });
    expect(caretRowOf(rows, -5)).toEqual({ row: 0, offset: 0 });
  });

  it("点第二行 ⇒ 落点按那一行的**行内**位置换算回**原串**下标", () => {
    // ⚠️ **刻意构造成「第 0 行塞满 72 列、且第 1 行以汉字开头」**：那才是
    // 「点击落点按显示列算」这件事能被验到的形状（真实的一行命令里 CJK 与 ASCII 混排）。
    const text = `${"a".repeat(20)}${"汉".repeat(40)}`;
    const g = geometry(spec({ columns: 100, rows: 30, input: text }));
    expect(g.inputRows).toBeGreaterThan(1);
    const second = g.inputTextRows[1]!;
    const start = g.inputWrapped[1]!.start;
    // 点第二行的第 0 列 ⇒ 原串下标 = 第二行的 start
    expect(caretFromWrappedPoint(second.x, second.y, g.inputTextRows, g.inputWrapped)).toBe(start);
    // ⚠️ 点第二行的第 4 列 ⇒ start + **2**（不是 +4）：第二行头两个字符是汉字，
    // 一个占两列。按字符个数算的那一档会给出 +4，而插入符于是落在第三个字之前两格 ——
    // 症状是「点某一列，光标跳过了一个字」。
    expect(g.inputWrapped[1]!.text.startsWith("汉")).toBe(true);
    expect(caretFromWrappedPoint(second.x + 4, second.y, g.inputTextRows, g.inputWrapped)).toBe(
      start + 2,
    );
  });

  it("点在框内但不属于任何一行文本 ⇒ null（调用方据此什么都不做）", () => {
    const g = geometry(spec({ columns: 100, rows: 30, input: "/status" }));
    // 输入框上方那一行：既不是文本行也不是消息行
    expect(caretFromWrappedPoint(30, g.input!.y - 1, g.inputTextRows, g.inputWrapped)).toBeNull();
  });
});
