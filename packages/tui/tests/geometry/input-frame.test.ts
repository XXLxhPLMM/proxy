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
 * 九条不变量与「判据为什么这么写」见本目录 `AGENTS.md`。
 *
 * @module tests/geometry
 */

import { describe, expect, it } from "vitest";
import {
  BORDER_ROWS,
  MODEL_STATUS_ROWS,
  NOTICE_ROWS,
  PALETTE_MAX_RATIO,
  PROMPT_COLUMNS,
  STATUS_LINE_HEIGHT,
  geometry,
  type Geometry,
  type GeometryInput,
} from "@/lib/geometry.js";
import { spec } from "./_shared.js";
describe("不变量 ⑧：状态行在框外，宽度与框同", () => {
  // ⚠️ **底部状态行与输入框之间还夹着「提供商 · 推理强度」那一行**，故「输入框底 == 状态行顶」
  // 那一档的判据是**经那一行**的：直接比输入框底边与状态行顶边的话，中间隔一行也判不出来
  // —— 而那一行正是「屏上忽然看不见模型与推理强度」这件事的坐标。
  it("状态行顶边 == 模型状态行底边，而模型状态行顶边 == 输入框底边（两者宽度与框同）", () => {
    const g = geometry(spec({ columns: 100, rows: 30, input: "/status" }));
    expect(g.modelStatus!.y).toBe(g.input!.y + g.input!.height);
    expect(g.statusLine!.y).toBe(g.modelStatus!.y + g.modelStatus!.height);
    expect(g.modelStatus!.width).toBe(g.input!.width);
    expect(g.modelStatus!.x).toBe(g.input!.x);
    expect(g.statusLine!.width).toBe(g.input!.width);
    expect(g.statusLine!.x).toBe(g.input!.x);
    expect(g.statusLine!.height).toBe(STATUS_LINE_HEIGHT);
    expect(g.modelStatus!.height).toBe(MODEL_STATUS_ROWS);
  });

  it("⚠️ 那一行**吃输入区的总高度**（加一格输入内容 ⇒ 输入区往上长，而底下两行钉在最底）", () => {
    const short = geometry(spec({ columns: 100, rows: 30, input: "/status" }));
    const long = geometry(spec({ columns: 100, rows: 30, input: "a\nb\nc" }));
    expect(long.inputRows).toBeGreaterThan(short.inputRows);
    // ⚠️ 判据是**底下那两行不动**：模型状态行恒在倒数第二行、底部状态行恒在最后一行，
    // 多折一行只把输入区往上顶 —— 只看「输入框 y 变小了」的话，实现把它盖住（漏算那一格）
    // 也照样过，而那正是「换了模型屏上什么也没变」这一类静默退化
    expect(long.modelStatus!.y + long.modelStatus!.height).toBe(long.statusLine!.y);
    expect(long.statusLine!.y + long.statusLine!.height).toBe(30);
    expect(long.modelStatus!.y).toBe(short.modelStatus!.y);
    expect(long.input!.y).toBeLessThan(short.input!.y);
    expect(long.input!.y + long.input!.height).toBe(long.modelStatus!.y);
  });

  it("⚠️ 极矮的屏上那一行给 `null` 而不是 0 高的矩形（呈现层只按「是不是 null」决定画不画）", () => {
    // ⚠️ **判据带正向对照**：同一份入参在放得下的屏上那一行恒存在，
    // 而「永远给 `null`」的实现只会在下过重的那几档里蒙混过关
    expect(geometry(spec({ columns: 100, rows: 30, input: "/status" })).modelStatus).not.toBeNull();
    for (const rows of [0, 1]) {
      expect(geometry(spec({ columns: 100, rows, input: "/status" })).modelStatus).toBeNull();
    }
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
    const g = geometry(spec({ columns: 100, rows: 3, input: "/status" }));
    expect(g.inputFramed).toBe(false);
    // 三行屏：底部状态行 1 + 模型状态行 1 + 输入区 1，而输入行**画得下**
    // （⚠️ 模型状态行是最后才被丢的那一格：先丢它的话两行屏上输入行就没了）
    expect(g.inputTextRows).toHaveLength(1);
  });

  it("⚠️ **模型状态行吃输入区的总高度**（不参与「框画不画得下」那个判据）", () => {
    // ⚠️ 判据是**框的判据没变**：屏高三行时框照旧画，而模型状态行让位 ——
    // 顺序反了的话矮一档的屏上会出现「框没了但那一行还在」（框比一行正文还不值钱）
    expect(geometry(spec({ columns: 100, rows: 3, input: "/status" })).inputFramed).toBe(false);
    for (const rows of [6, 7, 10, 30]) {
      const g = geometry(spec({ columns: 100, rows, input: "/status" }));
      expect(g.inputFramed, `rows=${String(rows)}`).toBe(true);
      expect(g.modelStatus, `rows=${String(rows)}`).not.toBeNull();
    }
  });

  it("框画得下的判据是「屏高 ≥ 框外状态行 1 + 上下框 2 + 1 行内容」（模型状态行不参与）", () => {
    for (const rows of [4, 5, 10]) {
      expect(geometry(spec({ columns: 100, rows, input: "/status" })).inputFramed).toBe(true);
    }
    // 3 行屏：底部状态行恒占 1 行，于是框只剩 2 行 —— 画不下就**不画框**（那一帧画的是输入行）
    expect(geometry(spec({ columns: 100, rows: 3, input: "/status" })).inputFramed).toBe(false);
    // ⚠️ **极矮的屏上先丢的是模型状态行而不是框**：框里那一行是「正在敲的东西」，
    // 而模型状态行是常驻信息 —— 判据带正向对照（30 行那一档两样都在）
    const roomy = geometry(spec({ columns: 100, rows: 30, input: "/status" }));
    expect(roomy.inputFramed).toBe(true);
    expect(roomy.modelStatus).not.toBeNull();
    for (const rows of [3, 4, 5]) {
      const g = geometry(spec({ columns: 100, rows, input: "/status" }));
      expect(g.modelStatus, `rows=${String(rows)}`).toBeNull();
      expect(g.inputTextRows.length).toBeGreaterThan(0);
    }
  });

  it("⚠️ **硬换行让框长一行**（`\\n` 不是显示列折出来的，而是用户自己敲的行边界）", () => {
    // ⚠️ 判据是**行数**而不是坐标：坐标那一档在 30 行的屏上恒成立，而这一条问的是
    // 「换行有没有真的多占一行」—— 而多折一行 ⇒ 整块往上长一行
    const one = geometry(spec({ columns: 100, rows: 30, input: "/status" }));
    const two = geometry(spec({ columns: 100, rows: 30, input: "/status\n" }));
    expect(two.inputRows).toBe(one.inputRows + 1);
    expect(two.input!.y).toBe(one.input!.y - 1);
    expect(two.inputContent!.height).toBe(one.inputContent!.height + 1);
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
    // ⚠️ 屏高那一档是**现算**的（结果区 2 + 底部状态行 + 模型状态行 + 框：内 2 + 上下 2），不是写死 7：
    // 写死的话「块里多了一行」这条算术改动会与这一档一起变，于是恒绿
    const rows = 2 + STATUS_LINE_HEIGHT + MODEL_STATUS_ROWS + (1 + NOTICE_ROWS + BORDER_ROWS);
    const g = geometry(spec({ columns: 100, rows, paletteCount: 19 }));
    expect(g.output!.height).toBe(2);
    expect(g.paletteRows).toHaveLength(0);
    expect(g.paletteFooterRow).toBeNull();
  });

  it("面板开着时输入区整块还在屏上（不越界）", () => {
    for (const rows of [8, 10, 14, 20, 30]) {
      const g = geometry(spec({ columns: 100, rows, paletteCount: 19 }));
      // ⚠️ 底下**两行**（模型状态行 + 底部状态行）恒在屏内，故输入区不许越过它们
      expect(g.input!.y + g.input!.height).toBeLessThanOrEqual(rows - MODEL_STATUS_ROWS - 1);
    }
  });
});
