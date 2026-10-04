/**
 * 模态窗口：居中的一块**无框卡片** + 右上角那枚 `esc` 提示。
 *
 * @description
 * 盯的是这块卡片与终端、与输入区的三组关系：
 *
 * - **居中且留在屏内**：四边的余量差不超过一列/一行；⚠️ 装不下时**按屏高截断**（不是整个不画 ——
 *   没有窗口等于那条命令什么都没发生），而屏太矮（放不下标题与分隔）才**整个不画**。
 * - **宽只由整屏宽决定**（拖侧边栏不该让窗口变形）：宽 = 整屏宽 × 70%，⚠️ **下限赢过比例**
 *   （70% 装不下「标题 + esc」时让位给 `WINDOW_MIN_WIDTH`，而不是缩到装不下），比下限还窄时占满整屏宽。
 * - ⚠️ **高恒为屏高的一半，与内容行数无关**（少一档就长高的那种窗不是模态）。
 * - **卡内分段**：padding 1 ⇒ 内容矩形与卡片**分叉**；标题恒高 1，内容紧接在它下面；内容区
 *   **第一行是分隔**，可选行从它下面起算；空台账那一句**占一行**，于是可点行少一行。
 * - ⚠️ **模态就是压在东西上面的**：屏矮到必须压住输入区是对的，不是不变量被破坏。
 *
 * ⚠️ 判据里写的是**字面量**（`padding 1`、缩进 3、`esc` 宽 9）而不是那几个常量：拿常量当期望值的话，
 * 改常量与改实现同时发生 ⇒ 恒绿。
 *
 * 九条不变量与变异实测表见本目录 `AGENTS.md`。
 *
 * @module tests/geometry
 */

import { describe, expect, it } from "vitest";
import {
  MIN_TERMINAL_COLUMNS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  WINDOW_CLOSE_INSET,
  WINDOW_FULL_WIDTH_BELOW,
  WINDOW_HEADER_INDENT,
  WINDOW_HEIGHT_RATIO,
  WINDOW_MIN_ROWS,
  WINDOW_MIN_WIDTH,
  WINDOW_PADDING,
  WINDOW_WIDTH_RATIO,
  geometry,
  hitTest,
  type Geometry,
  type GeometryInput,
} from "@/lib/geometry.js";
import { spec } from "./_shared.js";
describe("模态窗口：居中的一块**无框卡片** + 右上角那枚 esc 提示", () => {
  /** 一台 100×30 的屏、开着窗口（几何档的缺省形状） */
  const open = (over: Partial<GeometryInput> = {}): Geometry =>
    geometry(spec({ window: true, windowRows: 3, ...over }));

  it("没开窗口时**全部**窗口矩形是 null（判据与坐标同源）", () => {
    const g = geometry(spec({ window: false, windowRows: 3, windowNote: false }));
    expect(g.windowBox).toBeNull();
    expect(g.windowHeader).toBeNull();
    expect(g.windowContent).toBeNull();
    expect(g.windowNoteRow).toBeNull();
    expect(g.windowRows).toEqual([]);
    expect(g.windowTitle).toBeNull();
    expect(g.windowClose).toBeNull();
  });

  it("开窗口时卡片有宽有高，且**留在屏内**", () => {
    const box = open().windowBox!;
    expect(box.width).toBeGreaterThan(10);
    expect(box.height).toBeGreaterThanOrEqual(WINDOW_MIN_ROWS);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(100);
    expect(box.y + box.height).toBeLessThanOrEqual(30);
  });

  // ⚠️ 这一条是「padding 1」这条不变式的**全部**内容：卡片与内容矩形**恒不相等**（旧版没有内边距，
  // 两者是同一个矩形）。少扣 padding 的话卡片右缘那一列会被行的底色顶掉，而症状是「看着没毛病」。
  // ⚠️ **判据里写的是字面量而不是那几个常量**：拿常量当期望值的话，改常量与改实现同时发生 ⇒ 恒绿。
  it("⚠️ **padding 1**：内容矩形与卡片**分叉**（四边各缩一格，再让掉标题那一行）", () => {
    const g = open();
    const box = g.windowBox!;
    expect(g.windowHeader!.x).toBe(box.x + 1);
    expect(g.windowHeader!.y).toBe(box.y + 1);
    expect(g.windowHeader!.width).toBe(box.width - 2);
    expect(g.windowContent!.x).toBe(g.windowHeader!.x);
    expect(g.windowContent!.width).toBe(g.windowHeader!.width);
    expect(g.windowContent!.y).toBe(g.windowHeader!.y + g.windowHeader!.height);
    expect(g.windowContent!.height).toBe(box.height - 2 - g.windowHeader!.height);
    expect(g.windowContent).not.toEqual(box);
    // ⚠️ 而那三个常数**本身**也被钉住（判据上面那几行只钉「相对关系」）
    expect([WINDOW_PADDING, WINDOW_HEADER_INDENT, WINDOW_CLOSE_INSET]).toEqual([1, 3, 3]);
  });

  it("⚠️ 窗拆成**标题 + 内容**两段：标题恒高 1，内容紧接在它下面", () => {
    const g = open();
    expect(g.windowHeader!.height).toBe(1);
    expect(g.windowContent!.y).toBe(g.windowHeader!.y + 1);
    expect(g.windowContent!.y + g.windowContent!.height).toBe(g.windowBox!.y + g.windowBox!.height - 1);
  });

  it("⚠️ 内容区**第一行是分隔**，可选行从它下面起算（少这一行 = 第 1 行盖掉分隔）", () => {
    const g = open({ windowRows: 3 });
    expect(g.windowRows[0]!.y).toBe(g.windowContent!.y + 1);
    // 要几行给几行时，**容量恒等于**内容区扣掉分隔那一行
    const full = open({ windowRows: 99 });
    expect(full.windowRows).toHaveLength(full.windowContent!.height - 1);
  });

  it("⚠️ 标题左起 3 列、`esc` 提示右起 3 列（都从**卡片**的边算起）", () => {
    const g = open();
    const box = g.windowBox!;
    // ⚠️ 字面量而非常量（理由同上：期望值与实现读同一个数 ⇒ 恒绿）
    expect(g.windowTitle!.x).toBe(box.x + 1 + 3);
    const chip = g.windowClose!;
    expect(chip.x + chip.width).toBe(box.x + box.width - 1 - 3);
    expect(chip.width).toBe(9);
    // 而两枚**恒在同一行**（窗口没有上边框可坐）
    expect(chip.y).toBe(g.windowTitle!.y);
    expect(chip.height).toBe(1);
  });

  it("⚠️ 标题的预算**恒**让开 esc 那一枚（两处各减一次 = 长标题压住它）", () => {
    const title = open().windowTitle!;
    const chip = open().windowClose!;
    expect(title.x + title.width).toBeLessThanOrEqual(chip.x);
    expect(title.height).toBe(1);
    // ⚠️ 窄到连标题都放不下时那一格宽度夹 0（而不是负数 —— 负宽度会让 `ellipsis` 走出怪结果）
    expect(open({ columns: 24 }).windowTitle!.width).toBeGreaterThanOrEqual(0);
  });

  it("可点的那一枚 esc 与画它的是同一个矩形（点它关窗靠的就是它）", () => {
    const chip = open({ windowRows: 2 }).windowClose!;
    expect(hitTest(chip.x, chip.y, [chip])).toBe(0);
    expect(hitTest(chip.x + chip.width - 1, chip.y, [chip])).toBe(0);
    // ⚠️ 而**卡片之外**那一列点不中（它是卡片的最后一格，不多不少）
    const g = open({ windowRows: 2 });
    expect(hitTest(g.windowBox!.x + g.windowBox!.width, chip.y, [chip])).toBe(-1);
  });

  /** 空台账那一句**占一行**（分隔下面那一行），于是可点行少一行（用「屏高撞上限」那一档） */
  it("⚠️ 空台账那一句**占一行**，于是可点行少一行", () => {
    const withNote = open({ columns: 100, rows: 20, windowRows: 9, windowNote: true });
    const without = open({ columns: 100, rows: 20, windowRows: 9, windowNote: false });
    expect(withNote.windowNoteRow).not.toBeNull();
    expect(without.windowNoteRow).toBeNull();
    expect(withNote.windowRows.length).toBe(without.windowRows.length - 1);
    // ⚠️ 而它**就在分隔下面那一行**（几何层给的位置 ⇒ 绘制与命中测试不会错开一行）
    expect(withNote.windowNoteRow!.y).toBe(withNote.windowContent!.y + 1);
    expect(withNote.windowRows[0]!.y).toBe(withNote.windowContent!.y + 2);
  });

  it("装不下时按屏高截断（**不是**整个不画：没有窗口等于那条命令什么都没发生）", () => {
    const g = open({ columns: 100, rows: 9, windowRows: 9 });
    expect(g.windowBox).not.toBeNull();
    expect(g.windowRows.length).toBeLessThan(9);
  });

  it("屏太矮时**不画窗口**（一个里面放不下标题与分隔的东西是纯噪音）", () => {
    for (const rows of [1, 2, 3, 4, 5, 6]) {
      expect(open({ columns: 100, rows, windowRows: 2 }).windowBox).toBeNull();
    }
    // ⚠️ 而**刚好够**的那一档画得下（判据是 `height ≥ WINDOW_MIN_ROWS`，不是「屏高 ≥ 某常数」）
    expect(open({ columns: 100, rows: 8, windowRows: 2 }).windowBox!.height).toBe(WINDOW_MIN_ROWS);
  });

  it("浮在正中（四边的余量差不超过一列/一行）", () => {
    const box = open().windowBox!;
    expect(Math.abs(box.x - (100 - box.x - box.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y - (30 - box.y - box.height))).toBeLessThanOrEqual(1);
  });

  it("⚠️ 宽 = 整屏宽 × 70%（按整屏算而不是按主区：模态是「这一屏」的事）", () => {
    for (const columns of [100, 150, 200, 400]) {
      expect(open({ columns }).windowBox!.width).toBe(Math.round(columns * WINDOW_WIDTH_RATIO));
    }
    expect(WINDOW_WIDTH_RATIO).toBe(0.7);
  });

  // ⚠️ **下限赢过比例**：70% 装不下「标题 + esc」时让位给 {@link WINDOW_MIN_WIDTH}，而不是缩到装不下。
  // 判据把**两档**都钉死：100 列上 70%（= 70）大于下限，于是比例赢；70 列上 70%（= 49）小于下限，于是下限赢。
  it("⚠️ 70% 与 {@link WINDOW_MIN_WIDTH} 撞上时**下限赢**（窄屏上不许缩到装不下）", () => {
    expect(open({ columns: 100 }).windowBox!.width).toBe(Math.round(100 * WINDOW_WIDTH_RATIO));
    for (const columns of [60, 66, 70]) {
      const box = open({ columns }).windowBox!;
      expect(box.width).toBe(WINDOW_MIN_WIDTH);
      expect(Math.round(columns * WINDOW_WIDTH_RATIO)).toBeLessThan(WINDOW_MIN_WIDTH);
    }
  });

  it("⚠️ 视口比 {@link WINDOW_FULL_WIDTH_BELOW} 还窄时窗口**占满整屏宽**（70% 与下限都太窄）", () => {
    for (const columns of [20, 40, 55, 59]) {
      const box = open({ columns }).windowBox!;
      expect(box.width).toBe(columns);
      expect(box.x).toBe(0);
      expect(Math.round(columns * WINDOW_WIDTH_RATIO)).toBeLessThan(WINDOW_MIN_WIDTH);
    }
    expect(WINDOW_FULL_WIDTH_BELOW).toBe(MIN_TERMINAL_COLUMNS);
  });

  it("⚠️ 宽度**不越过**屏宽（屏比下限还窄时窗口让位给屏宽）", () => {
    for (const columns of [20, 40, 80, 100, 140, 200, 400]) {
      const box = open({ columns }).windowBox!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(columns);
      expect(box.width).toBeLessThanOrEqual(Math.max(WINDOW_MIN_WIDTH, columns));
    }
  });

  // ⚠️ **高恒为屏高的一半**（唯一的一项）：内容行数与期望下限都不参与，故 46 行内容也只给一半屏高。
  it("⚠️ 高恒为屏高的一半，**与内容行数无关**（少一档就长高的那种窗不是模态）", () => {
    for (const rows of [16, 18, 27, 30, 50]) {
      expect(open({ columns: 100, rows, windowRows: 2 }).windowBox!.height).toBe(
        Math.round(rows * WINDOW_HEIGHT_RATIO),
      );
    }
    expect(open({ columns: 100, rows: 50, windowRows: 46 }).windowBox!.height).toBe(25);
    expect(open({ columns: 100, rows: 50, windowRows: 46 }).windowRows.length).toBeLessThan(46);
    expect(WINDOW_HEIGHT_RATIO).toBe(0.5);
  });

  it("⚠️ 宽度**只**由整屏宽决定（拖侧边栏不该让窗口变形）", () => {
    const thin = open({ columns: 140, sidebarWidth: SIDEBAR_MIN_WIDTH }).windowBox!;
    const fat = open({ columns: 140, sidebarWidth: SIDEBAR_MAX_WIDTH }).windowBox!;
    expect(thin.width).toBe(fat.width);
    expect(thin.x).toBe(fat.x);
  });

  it("屏矮到窗口必须压住输入区（**故意的**：模态就是压在东西上面的）", () => {
    const g = open({ columns: 100, rows: 12 });
    const box = g.windowBox!;
    const overlaps = g.input!.y < box.y + box.height && g.input!.y + g.input!.height > box.y;
    expect(overlaps).toBe(true);
  });
});
