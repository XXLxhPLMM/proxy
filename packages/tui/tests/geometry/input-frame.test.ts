/**
 * 主区下半截的高度恒等式：输入框（框内 n 行）与**贴在它上面的命令面板**。
 *
 * @description
 * 这一档盯的是主区里**下半截**那几块互相咬合的关系：
 *
 * - **状态行恒在框外**且宽度与框**同**：它不占框内高度（框内恒是「折行 + 消息」），而框 = 框内 +
 *   上下那两行。⚠️ 状态行混进框里的话它会与输入串**抢同一行**（而它不消失、输入串会）。
 * - **输入框随折行数长高**：多折一行 ⇒ 整块输入区（含框外那一行）往上长一行。
 * - **屏太矮时如实不画框**（那一帧画的是输入行，不是两条横边），判据是「屏高 ≥ 框外状态行 1 +
 *   上下框 2 + 1 行内容」。
 * - **命令面板贴着输入框的上边**、高度**至多**结果区内容行的 `PALETTE_MAX_RATIO`，而
 *   「结果文本 + 面板 = 内容行数」是那条恒等式（面板与结果区既不重叠也不留缝）。
 * - ⚠️ 内容区只有两行时 40% 是 0 ⇒ **那一帧没有面板**（不给「至少一行」的兜底）。
 *
 * 九条不变量与变异实测表见本目录 `AGENTS.md`。
 *
 * @module tests/geometry
 */

import { describe, expect, it } from "vitest";
import {
  BORDER_ROWS,
  NOTICE_ROWS,
  PALETTE_MAX_RATIO,
  PROMPT_COLUMNS,
  geometry,
  type Geometry,
  type GeometryInput,
} from "@/lib/geometry.js";
import { spec } from "./_shared.js";
describe("不变量 ⑧：状态行在框外，宽度与框同", () => {
  it("状态行顶边 == 输入框底边，且两者宽度相同", () => {
    const g = geometry(spec({ columns: 100, rows: 30, input: "/status" }));
    expect(g.statusLine!.y).toBe(g.input!.y + g.input!.height);
    expect(g.statusLine!.width).toBe(g.input!.width);
    expect(g.statusLine!.x).toBe(g.input!.x);
  });

  it("它**不占**框内高度：框内恒是「折行 + 消息」", () => {
    const g = geometry(spec({ columns: 100, rows: 30, input: "/status" }));
    expect(g.input!.height).toBe(g.inputRows + NOTICE_ROWS + BORDER_ROWS);
    expect(g.inputContent!.height).toBe(g.inputRows + NOTICE_ROWS);
  });

  it("输入多一行 ⇒ 整块输入区（含框外那一行）往上长一行", () => {
    const short = geometry(spec({ columns: 100, rows: 30, input: "/status" }));
    const long = geometry(
      spec({
        columns: 100,
        rows: 30,
        input:
          "/user set charlie password 汉字密码也要折行所以我再打一些字让它真的折起来看看到底折成几行",
      }),
    );
    expect(long.inputRows).toBeGreaterThan(short.inputRows);
    expect(long.input!.y).toBeLessThan(short.input!.y);
    // 状态行恒在最底
    expect(long.statusLine!.y + long.statusLine!.height).toBe(30);
  });

  it("屏太矮时如实**不画框**，而那一帧画的是输入行（不是两条横边）", () => {
    const g = geometry(spec({ columns: 100, rows: 2, input: "/status" }));
    expect(g.inputFramed).toBe(false);
    // 两行屏：状态行 1 行 + 输入区 1 行，而输入行**画得下**
    expect(g.inputTextRows).toHaveLength(1);
  });

  it("框画得下的判据是「屏高 ≥ 框外状态行 1 + 上下框 2 + 1 行内容」", () => {
    for (const rows of [4, 5, 10]) {
      expect(geometry(spec({ columns: 100, rows, input: "/status" })).inputFramed).toBe(true);
    }
    // 3 行屏：状态行恒占 1 行，于是框只剩 2 行 —— 画不下就**不画框**（那一帧画的是输入行）
    expect(geometry(spec({ columns: 100, rows: 3, input: "/status" })).inputFramed).toBe(false);
  });

  it("每一行的 x 都在内容起点 + 提示符那一列（折行与绘制逐字对齐）", () => {
    const g = geometry(spec({ columns: 100, rows: 30, input: "/status /status /status" }));
    for (const row of g.inputTextRows) {
      expect(row.x).toBe(g.inputContent!.x + PROMPT_COLUMNS);
    }
  });
});

describe("不变量 ⑨：命令面板贴着输入框、至多内容行的 40%", () => {
  const panel = (over: Partial<GeometryInput> = {}): Geometry =>
    geometry(spec({ paletteCount: 19, ...over }));

  it("不超过内容行 × 40%", () => {
    const g = panel();
    expect(g.paletteRows.length + (g.paletteFooterRow === null ? 0 : 1)).toBeLessThanOrEqual(
      Math.floor(g.output!.height * PALETTE_MAX_RATIO),
    );
  });

  it("面板**最后一行**（说明行，若有）的下缘 == 输入框的上缘（中间没有空白带）", () => {
    const g = panel();
    const last = g.paletteFooterRow ?? g.paletteRows[g.paletteRows.length - 1]!;
    expect(last.y + last.height).toBe(g.input!.y);
  });

  it("装得下时最后一行候选自己就贴着输入框（没有说明行夹在中间）", () => {
    const g = geometry(spec({ paletteCount: 2 }));
    const last = g.paletteRows[g.paletteRows.length - 1]!;
    expect(last.y + last.height).toBe(g.input!.y);
  });

  it("结果文本 + 面板 = 内容行数（那条恒等式：面板与结果区既不重叠也不留缝）", () => {
    const g = panel();
    expect(g.outputBlockRows + g.paletteRows.length + (g.paletteFooterRow === null ? 0 : 1)).toBe(
      g.output!.height,
    );
  });

  it("候选装得下时按**实际条数**高（不撑满那 40%），且没有说明行", () => {
    const g = geometry(spec({ paletteCount: 2 }));
    expect(g.paletteRows).toHaveLength(2);
    expect(g.paletteFooterRow).toBeNull();
  });

  it("装不下时多出那一条说明行，且它恒是面板的最后一行", () => {
    const g = panel();
    expect(g.paletteFooterRow).not.toBeNull();
    expect(g.paletteFooterRow!.y).toBe(g.input!.y - 1);
  });

  it("内容区只有两行时 40% 是 0 ⇒ 那一帧没有面板（不给「至少一行」的兜底）", () => {
    const g = geometry(spec({ columns: 100, rows: 7, paletteCount: 19 }));
    expect(g.output!.height).toBe(2);
    expect(g.paletteRows).toHaveLength(0);
    expect(g.paletteFooterRow).toBeNull();
  });

  it("面板开着时输入区整块还在屏上（不越界）", () => {
    for (const rows of [8, 10, 14, 20, 30]) {
      const g = geometry(spec({ columns: 100, rows, paletteCount: 19 }));
      expect(g.input!.y + g.input!.height).toBeLessThanOrEqual(rows - 1);
    }
  });
});
