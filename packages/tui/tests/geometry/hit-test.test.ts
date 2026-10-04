/**
 * 落点 ↔ 下标：命中测试的半开区间，与插入符按**显示宽度**定位。
 *
 * @description
 * 两件事共用同一个前提 —— **屏幕上那一点换算成一个下标**：
 *
 * - **`hitTest` 用半开区间** `[x, x+w)` × `[y, y+h)`：点整除边界归**右边那个**，真重叠时**后来者赢**
 *   （调用方给的下标序就是绘制序）。非整数坐标返回 `-1`（除法 / 取整写错的后果是一次静默无响应）。
 * - **插入符按显示宽度算**：一个汉字占两列，点在它右半边落在它**之后**而不是中间。
 *
 * ⚠️ 侧边栏那几项两行高 ⇒「行 → 窗口内项」不必除法；而**项 → 会话**必须加上 `sessionFirst`。
 *
 * 九条不变量与变异实测表见本目录 `AGENTS.md`。
 *
 * @module tests/geometry
 */

import { describe, expect, it } from "vitest";
import { SESSION_STRIDE, caretFromColumn, geometry, hitTest, type Rect } from "@/lib/geometry.js";
import { spec } from "./_shared.js";
describe("不变量 ⑤：命中测试用半开区间", () => {
  const rects: Rect[] = [
    { x: 0, y: 0, width: 10, height: 2 },
    { x: 10, y: 0, width: 10, height: 2 },
  ];

  it("边界那一列归右边那个", () => {
    expect(hitTest(9, 0, rects)).toBe(0);
    expect(hitTest(10, 0, rects)).toBe(1);
  });

  it("边界那一行归下面那个", () => {
    expect(hitTest(0, 1, rects)).toBe(0);
    expect(hitTest(0, 2, rects)).toBe(-1);
  });

  it("非整数坐标直接 -1（除法 / 取整写错的后果是一次静默无响应）", () => {
    expect(hitTest(1.5, 0, rects)).toBe(-1);
    expect(hitTest(0, Number.NaN, rects)).toBe(-1);
  });

  it("重叠时后一个赢（调用方给的下标序就是绘制序）", () => {
    const stacked: Rect[] = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 2, y: 2, width: 4, height: 4 },
    ];
    expect(hitTest(3, 3, stacked)).toBe(1);
  });

  it("侧边栏那几项两行高 ⇒ 命中下标是**窗口内**下标，会话下标要加 `sessionFirst`", () => {
    const g = geometry(spec({ rows: 10, sidebarWidth: 22, sessionCount: 9, sessionsTop: 3 }));
    expect(g.sessionFirst).toBe(3);
    // ⚠️ 每一项两行高 ⇒「行 → 窗口内项」不必除法；而**项 → 会话**必须加上 `sessionFirst`
    expect(hitTest(3, 0, g.sidebarRows)).toBe(0);
    expect(hitTest(3, 1, g.sidebarRows)).toBe(0);
    expect(hitTest(3, SESSION_STRIDE, g.sidebarRows)).toBe(1);
    expect(hitTest(3, SESSION_STRIDE + 1, g.sidebarRows)).toBe(1);
    // ⚠️ 而两项**之间**那一行点不中（它不属于任何一项）
    expect(hitTest(3, 2, g.sidebarRows)).toBe(-1);
  });
});

describe("不变量 ⑥：插入符按显示宽度定位", () => {
  const at = (col: number, text: string, x = 0): number => caretFromColumn(col, { x, y: 0, width: 80, height: 1 }, text);

  it("点中文字的右半边落在它之后（不是中间）", () => {
    // 「账」占两列：第 0 列在它之前，第 2 列在它之后
    expect(at(0, "账上")).toBe(0);
    expect(at(1, "账上")).toBe(0);
    expect(at(2, "账上")).toBe(1);
  });

  it("点在右侧留白上落在行末，点在行首左侧落在行首", () => {
    expect(at(999, "/status")).toBe(7);
    expect(at(-5, "/status")).toBe(0);
  });

  it("x 偏移照进（那一行的矩形不一定从第 0 列起）", () => {
    const text = { x: 25, y: 0, width: 40, height: 1 };
    expect(caretFromColumn(25, text, "/status")).toBe(0);
    expect(caretFromColumn(31, text, "/status")).toBe(6);
  });
});
