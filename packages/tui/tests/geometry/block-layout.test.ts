/**
 * 整屏的分区算术：各区域首尾相接、不重叠不留缝，且各区高度之和恒等于终端行数。
 *
 * @description
 * 盯的是**跨区域**的那几条恒等式，逐条在十几档终端尺寸上现算（正常 / 极窄 / 极矮 / 0×0）：
 *
 * - **不许出现负坐标**（负的 `y` 会让命中测试吃掉上方区域的点击）。
 * - **首尾相接**：状态行底边 == 终端行数、结果区底边 == 输入框顶边、输入框底边 == 状态行顶边。
 * - **各区高度之和 == 终端行数**：结果块 + 面板 + 输入框 + 状态行。少一行的话 Ink 的列向 flex
 *   会把整屏内容往上顶，而症状是「状态行画在了输入框上面那一行、最底那一行空着」。
 *
 * ⚠️ 判据一律**现算**（按 `columns` / `rows` 算期望值，而不是写死一个数）：写死的话改实现与改档
 * 一起发生就恒绿。九条不变量与变异实测表见本目录 `AGENTS.md`。
 *
 * @module tests/geometry
 */

import { describe, expect, it } from "vitest";
import {
  BORDER_ROWS,
  MIN_TERMINAL_COLUMNS,
  MODEL_STATUS_ROWS,
  NOTICE_ROWS,
  PROMPT_COLUMNS,
  STATUS_LINE_HEIGHT,
  geometry,
  type Geometry,
  type Rect,
} from "@/lib/geometry.js";
import { INPUT_SAMPLES, spec } from "./_shared.js";

/** 遍历全部矩形（含侧边栏那几项与窗口那几块） */
function allRects(g: Geometry): Rect[] {
  const out: Rect[] = [];
  if (g.sidebar !== null) out.push(g.sidebar);
  if (g.sidebarHandle !== null) out.push(g.sidebarHandle);
  if (g.output !== null) out.push(g.output);
  if (g.input !== null) out.push(g.input);
  if (g.inputNotice !== null) out.push(g.inputNotice);
  if (g.statusLine !== null) out.push(g.statusLine);
  if (g.windowBox !== null) out.push(g.windowBox);
  if (g.windowHeader !== null) out.push(g.windowHeader);
  if (g.windowClose !== null) out.push(g.windowClose);
  if (g.inputGutter !== null) out.push(g.inputGutter);
  if (g.modelStatus !== null) out.push(g.modelStatus);
  // ⚠️ **`input` 槽那两个投影是数组**：逐项扫（而不是只扫第 0 个），否则「第 2 个字段那一格没被量到」
  // 在本格零鉴别力 —— 而表单有五个字段，第 0 个装得下不代表后面几个装得下
  out.push(...g.windowInputs.filter((one): one is Rect => one !== null));
  out.push(...g.windowInputTexts.filter((one): one is Rect => one !== null));
  // ⚠️ 逐槽扫一遍而不是把四个投影各扫一遍：那四个是**这一份**的投影，各扫一次的话
  // 「投影漏了某一种槽位」这一类回归在本格零鉴别力（症状还只是「那一格没被量到」）
  return [
    ...out,
    ...g.sidebarRows,
    ...g.inputTextRows,
    ...g.windowSlots.filter((one): one is Rect => one !== null),
    ...g.windowChecks,
    ...g.windowSelects,
    ...g.paletteRows,
  ];
}

/** 常见尺寸的样本（含正常、极窄、极矮、0×0） */
const SAMPLES: Array<[number, number]> = [
  [200, 60],
  [120, 40],
  [100, 30],
  [80, 24],
  [MIN_TERMINAL_COLUMNS, 20],
  [MIN_TERMINAL_COLUMNS - 1, 20],
  [50, 30],
  [200, 10],
  [120, 6],
  [120, 5],
  [120, 4],
  [120, 3],
  [120, 2],
  [120, 1],
  [120, 0],
  [0, 0],
];

describe("不变量 ①：任何终端尺寸下都不许出现负坐标（否则命中测试会吃掉上方区域的点击）", () => {
  it.each(SAMPLES)("columns=%i rows=%i 下全部矩形坐标非负且宽高非负", (columns, rows) => {
    // ⚠️ **六种槽位都给上**：只喂 `row` 的话「说明 / 分组标题 / 下拉 / 勾选 / 输入框」的缩进
    // 在这一档零鉴别力，而少给一种就正好漏掉它那一档的坐标
    const g = geometry(
      spec({
        columns,
        rows,
        window: [
          { kind: "note" },
          { kind: "group" },
          { kind: "row" },
          { kind: "check" },
          { kind: "select" },
          { kind: "input" },
        ],
        paletteCount: 9,
      }),
    );
    for (const r of allRects(g)) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.width).toBeGreaterThanOrEqual(0);
      expect(r.height).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.x) && Number.isInteger(r.y)).toBe(true);
      expect(Number.isInteger(r.width) && Number.isInteger(r.height)).toBe(true);
    }
  });

  it.each(INPUT_SAMPLES)("折行档 %j 下同样不产负坐标", (input) => {
    const g = geometry(spec({ input, paletteCount: 9 }));
    for (const r of allRects(g)) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("不变量 ②：各区首尾相接，不重叠也不留缝", () => {
  it.each(SAMPLES)("columns=%i rows=%i：侧边栏与主区顶到屏顶、输入框底 == 模型状态行顶", (columns, rows) => {
    const g = geometry(spec({ columns, rows, sidebarWidth: 22 }));
    // 状态行恒在最底那一行
    if (g.statusLine !== null) {
      expect(g.statusLine.y + g.statusLine.height).toBe(rows);
      expect(g.statusLine.height).toBe(Math.min(STATUS_LINE_HEIGHT, rows));
    }
    if (g.input !== null) {
      // ⚠️ 输入框底边 == **模型状态行**顶边（那一行夹在框与底部状态行之间，见 `Geometry.modelStatus`）
      expect(g.input.y + g.input.height).toBe(g.modelStatus?.y ?? g.statusLine?.y ?? rows);
    }
    // ⚠️ 而那一行自己恒高 1、坐在框与状态行之间 —— 夹错位置的话两行会重叠
    if (g.modelStatus !== null) {
      expect(g.modelStatus.height).toBe(MODEL_STATUS_ROWS);
      // ⚠️ 紧贴输入框底边（它那一格恒在：框 → 模型状态行 → 底部状态行，三段首尾相接）
      expect(g.modelStatus.y).toBe(g.input === null ? g.modelStatus.y : g.input.y + g.input.height);
      expect(g.modelStatus.y + g.modelStatus.height).toBe(g.statusLine?.y ?? rows);
    }
    if (g.output !== null) {
      // 结果区底边 == 输入框顶边
      expect(g.output.y + g.output.height).toBe(g.input?.y ?? 0);
    }
    // 侧边栏与主区都从第 0 行起，且都到屏底
    if (g.sidebar !== null) {
      expect(g.sidebar.y).toBe(0);
      expect(g.sidebar.y + g.sidebar.height).toBe(rows);
    }
    // 主区宽度 0 时整块是 `null`（不是「宽度 0 的矩形」）—— 命中测试拿着一份
    // 「有一个 0 宽的区域」的数据时，点下去会静默无响应
    expect(g.output?.y ?? 0).toBe(0);
  });

  it("输入框的框内高度 = 折行数 + 瞬时消息行（且框只多上下那两行）", () => {
    const g = geometry(
      spec({
        input: "/target add live http://10.0.0.9:18080 0123456789abcdef0123456789abcdef 5000",
      }),
    );
    expect(g.inputRows).toBeGreaterThan(1);
    // 框 = 框内 + 上下框
    expect(g.input!.height).toBe(g.inputRows + NOTICE_ROWS + BORDER_ROWS);
    expect(g.inputContent!.height).toBe(g.inputRows + NOTICE_ROWS);
  });

  it("框画得下时框内恰好是「折行 + 一条消息」，而消息行恒在最后一行之下", () => {
    const g = geometry(spec({ input: "/user add charlie" }));
    expect(g.inputFramed).toBe(true);
    expect(g.inputTextRows).toHaveLength(g.inputRows);
    // 文本行逐行紧挨着，消息行紧接在最后一行文本之下
    g.inputTextRows.forEach((row, i) => {
      expect(row.y).toBe(g.inputContent!.y + i);
      expect(row.height).toBe(1);
    });
    expect(g.inputNotice!.y).toBe(g.inputContent!.y + g.inputRows);
  });

  it("空输入也是一行（否则框在清空那一帧塌成一条边）", () => {
    const g = geometry(spec({ input: "" }));
    expect(g.inputRows).toBe(1);
    expect(g.inputTextRows).toHaveLength(1);
  });
});


describe("不变量 ⑧ 之二：各区高度之和**恒等于**终端行数", () => {
  // ⚠️ **硬换行的输入也在样本里**：它是「按了换行框要多长一行」那条算术的输入侧，
  // 而那一档（折行 + 硬换行 + 模型状态行）三样叠在一起时最容易算错一次
  it.each(SAMPLES)("columns=%i rows=%i：结果块 + 面板 + 输入框 + 模型状态行 + 状态行 == rows", (columns, rows) => {
    for (const paletteCount of [0, 3, 19]) {
      for (const input of [
        "",
        "/status",
        "/user pass charlie 汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字",
        "/status\n硬换行的第二行也要占高度",
      ]) {
        const g = geometry(spec({ columns, rows, paletteCount, input }));
        if (g.output === null || g.input === null || g.statusLine === null) continue;
        const panel = g.paletteRows.length + (g.paletteFooterRow === null ? 0 : 1);
        // ⚠️ **模型状态行是这条恒等式的一格**（它夹在框与状态行之间）：少算它的话
        // Ink 的列向 flex 会把整屏内容**往上顶** —— 症状是「底部状态行画在了输入框上面那一行、
        // 最底那一行空着」（实测踩过一次，那时没有任何单测能看见它）
        const model = g.modelStatus === null ? 0 : g.modelStatus.height;
        expect(g.outputBlockRows + panel + g.input.height + model + g.statusLine.height).toBe(rows);
      }
    }
  });
});


describe("输入区**左侧那一列箭头槽**：贯穿整个框内内容高度", () => {
  it.each(SAMPLES)(
    "columns=%i rows=%i：箭头槽紧贴内容左缘、宽 PROMPT_COLUMNS、高度 == 框内高度",
    (columns, rows) => {
      const g = geometry(spec({ columns, rows, input: "第一行\n第二行\n第三行", paletteCount: 0 }));
      // ⚠️ **判据形状有正有反**：放得下的样本上箭头槽必须在（正向），
      // 而主区宽度为 0 那一档它必须整个不存在（0 宽的矩形恒不命中 ——
      //「不画」必须是 `null`，见本目录 `AGENTS.md`「判据为什么这么写」那一条）
      const fits =
        g.input !== null && g.inputContent !== null && g.inputContent.width >= PROMPT_COLUMNS;
      if (fits) {
        expect(g.inputGutter).not.toBeNull();
        expect(g.inputGutter!.x).toBe(g.inputContent!.x);
        expect(g.inputGutter!.y).toBe(g.inputContent!.y);
        expect(g.inputGutter!.width).toBe(PROMPT_COLUMNS);
        expect(g.inputGutter!.height).toBe(g.inputContent!.height);
      } else {
        expect(g.inputGutter).toBeNull();
      }
      // ⚠️ 而**它右缘就是每一行文字的起点**：少这两列的话续行顶格画，
      // 硬换行之后第一个字与第一行的字差着两列（症状是「按了换行字就串到左边去了」）
      for (const row of g.inputTextRows) expect(row.x).toBe(g.inputContent!.x + PROMPT_COLUMNS);
    },
  );
});

describe("结果区的内容宽度：一个列都不多扣（主区与侧边栏都没有框）", () => {
  it("outputWidth == 主区宽度", () => {
    const g = geometry(spec({ columns: 120, rows: 30, sidebarWidth: 25 }));
    expect(g.outputWidth).toBe(g.output!.width);
  });

  it("outputRows 比那一块少一行（滚动提示那一行）", () => {
    const g = geometry(spec({ columns: 120, rows: 30 }));
    expect(g.outputBlockRows).toBe(g.outputRows + 1);
  });
});
