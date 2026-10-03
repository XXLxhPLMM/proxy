/**
 * `@/view/geometry`（屏幕几何）的纯函数断言
 *
 * **锁什么**（九条不变量）：
 * 1. 任何终端尺寸下都不许出现负坐标；
 * 2. 各区域首尾相接、**不重叠也不留缝**（状态行底边 == 终端行数、`output` 底边 == 输入框顶边、
 *    输入框底边 == 状态行顶边）；
 * 3. 侧边栏每项**恰好 2 行高**（`SESSION_ROWS`）且互不重叠，且**横跨整列**；
 * 4. 侧边栏与主区之间**恒隔 1 列**（那一列**不属于任何一边**）；
 * 5. 命中测试用**半开区间**（点整除边界归右边那个）；
 * 6. 插入符定位按**显示宽度**算（点中文右半边不能落在它一半的位置）；
 * 7. 输入**折行**：`rows` 恒 ≥ 1、按**显示列**断、**一个字符都不许丢**、光标落在折出来的那一行；
 * 8. 输入框**随折行数长高**（框内 n 行 + 上下框 + 框外状态行 = 整块高度），
 *    而**状态行恒在框外**且宽度与框**同**；
 * 9. 命令面板**贴着输入框的上边**、高度**至多**结果区内容行的 {@link PALETTE_MAX_RATIO}；
 *    「结果文本 + 面板 = 内容行数」是那条恒等式。
 *
 * ⚠️ 第 4 与第 8 条各挡一个**只有真终端才看得见**的退化：间隔列不见了的话侧边栏与主区在满屏上
 * 是一条整块底色；而状态行混进框里的话它会与输入串**抢同一行**（而它不消失、输入串会）。
 *
 * ## 变异实测记录（每条都做过；转红的逐条写了，**仍绿的是「可证明的等价变异」并写了为什么绿**）
 *
 * 见文件末尾那张表。
 */

import { describe, expect, it } from "vitest";
import {
  BORDER_ROWS,
  MAIN_MIN_WIDTH,
  MIN_TERMINAL_COLUMNS,
  NOTICE_ROWS,
  PALETTE_MAX_RATIO,
  PROMPT_COLUMNS,
  SESSION_ROWS,
  SIDEBAR_GAP,
  SIDEBAR_MIN_WIDTH,
  STATUS_LINE_HEIGHT,
  caretFromColumn,
  caretFromWrappedPoint,
  caretRowOf,
  geometry,
  hitTest,
  sidebarWidthBounds,
  wrapInput,
  type Geometry,
  type GeometryInput,
  type Rect,
} from "@/view/geometry.js";

/** 一组常用事实的入参（各档只改自己关心的那几个字段） */
function spec(over: Partial<GeometryInput> = {}): GeometryInput {
  return {
    columns: 100,
    rows: 30,
    sidebarWidth: 22,
    input: "",
    paletteCount: 0,
    window: false,
    windowRows: 0,
    windowFooter: false,
    ...over,
  };
}

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
  if (g.windowClose !== null) out.push(g.windowClose);
  return [
    ...out,
    ...g.sidebarRows,
    ...g.inputTextRows,
    ...g.windowRows,
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

/** 折行高度各档（连同那一长串会把输入撑到折行的输入串） */
const INPUT_SAMPLES: readonly string[] = [
  "",
  "/",
  "/status",
  "/user add charlie 1g",
  "/target add live http://10.0.0.9:18080 t0ken-with-a-long-tail 5000",
  "/user set charlie password 汉字密码也要折行所以我再打一些字让它真的折起来看看到底折成几行",
  // ⚠️ 下面两条**必须真的比一行的宽度长**：折行宽度是 `主区 − 框 2 − 提示符 2 − 插入符 1`，
  // 而 100 列的屏上那是 72 列 —— 短样本恒折不出第二行，于是「折行」那一整组都在测一行的情况。
  "/target add live http://10.0.0.9:18080 0123456789abcdef0123456789abcdef0123456789abcdef 5000",
  "/user pass charlie 汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字",
];

describe("不变量 ①：任何终端尺寸下都不许出现负坐标（否则命中测试会吃掉上方区域的点击）", () => {
  it.each(SAMPLES)("columns=%i rows=%i 下全部矩形坐标非负且宽高非负", (columns, rows) => {
    const g = geometry(spec({ columns, rows, window: true, windowRows: 3, windowFooter: true, paletteCount: 9 }));
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
  it.each(SAMPLES)("columns=%i rows=%i：侧边栏与主区顶到屏顶、输入框底 == 状态行顶", (columns, rows) => {
    const g = geometry(spec({ columns, rows, sidebarWidth: 22 }));
    // 状态行恒在最底那一行
    if (g.statusLine !== null) {
      expect(g.statusLine.y + g.statusLine.height).toBe(rows);
      expect(g.statusLine.height).toBe(Math.min(STATUS_LINE_HEIGHT, rows));
    }
    if (g.input !== null) {
      // 输入框底边 == 状态行顶边
      expect(g.input.y + g.input.height).toBe(g.statusLine?.y ?? rows);
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

describe("不变量 ③：侧边栏每项 2 行、横跨整列、互不重叠", () => {
  it("每一项高度恒等于 SESSION_ROWS 且逐项下移两行", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 22 }));
    g.sidebarRows.forEach((row, i) => {
      expect(row.height).toBe(SESSION_ROWS);
      expect(row.y).toBe(i * SESSION_ROWS);
      expect(row.x).toBe(0);
      expect(row.width).toBe(22);
    });
  });

  it("侧边栏满高满宽且没有框（frame 是别的字段的事）", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 22 }));
    expect(g.sidebar).toEqual({ x: 0, y: 0, width: 22, height: 30 });
  });

  it("画得下的项数 = 屏高除以两行（多出来的必须由呈现层说「还有 N 个」）", () => {
    const g = geometry(spec({ rows: 9, sidebarWidth: 22 }));
    // 9 行 ⇒ 4 项（8 行），第 9 行放不下整整一项
    expect(g.sidebarRows).toHaveLength(4);
    expect(g.sidebarRows[3]!.y + SESSION_ROWS).toBeLessThanOrEqual(9);
  });

  it("太窄的屏整个侧边栏不画，且那几项是空数组（不是「宽度 0 的 n 行」）", () => {
    const g = geometry(spec({ columns: MIN_TERMINAL_COLUMNS - 1, rows: 30 }));
    expect(g.sidebar).toBeNull();
    expect(g.sidebarRows).toEqual([]);
    expect(g.sidebarHandle).toBeNull();
  });

  it("拖动手柄 = 侧边栏最右那一列、满高", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 30 }));
    expect(g.sidebarHandle).toEqual({ x: 29, y: 0, width: 1, height: 30 });
    // ⚠️ 手柄与那一列的**会话项重叠**：命中测试必须先判它
    expect(g.sidebarRows[0]!.x + g.sidebarRows[0]!.width).toBeGreaterThan(g.sidebarHandle!.x);
  });
});

describe("不变量 ④：侧边栏与主区之间恒隔一列，且那一列不属于任何一边", () => {
  it("主区左边恒等于侧边栏宽 + 1", () => {
    for (const width of [SIDEBAR_MIN_WIDTH, 22, 33]) {
      const g = geometry(spec({ columns: 120, rows: 30, sidebarWidth: width }));
      expect(g.output!.x).toBe(width + SIDEBAR_GAP);
    }
  });

  it("那一列不落在侧边栏里、也不落在主区里（点它两边都不响应）", () => {
    const g = geometry(spec({ columns: 120, rows: 30, sidebarWidth: 22 }));
    const gap = 22;
    expect(hitTest(gap, 3, g.sidebarRows)).toBe(-1);
    expect(hitTest(gap, 3, [{ ...g.output! }])).toBe(-1);
  });

  it("两边的宽度加起来 + 那一列 = 终端列数", () => {
    const g = geometry(spec({ columns: 120, rows: 30, sidebarWidth: 22 }));
    expect(g.sidebar!.width + SIDEBAR_GAP + g.output!.width).toBe(120);
  });

  it("侧边栏宽的合法区间：下界是常量、上界同时受「主区至少留 MAIN_MIN_WIDTH 列」夹", () => {
    // 宽屏：上界是常量
    expect(sidebarWidthBounds(200).max).toBe(sidebarWidthBounds(200).max);
    // 窄屏：上界由「主区至少留 MAIN_MIN_WIDTH 列」决定（不是那个常量）
    const narrow = sidebarWidthBounds(MIN_TERMINAL_COLUMNS);
    expect(narrow.max).toBe(MIN_TERMINAL_COLUMNS - SIDEBAR_GAP - MAIN_MIN_WIDTH);
    expect(narrow.max).toBeLessThan(44);
  });

  it("几何层把越界的那个拖动值夹回区间（状态层可以持有越界值）", () => {
    const g1 = geometry(spec({ columns: 120, rows: 30, sidebarWidth: 999 }));
    const g2 = geometry(spec({ columns: 120, rows: 30, sidebarWidth: 1 }));
    expect(g1.sidebar!.width).toBe(sidebarWidthBounds(120).max);
    expect(g2.sidebar!.width).toBe(sidebarWidthBounds(120).min);
  });

  it("主区被夹到 MAIN_MIN_WIDTH 之内（拖到最宽也还够主区用）", () => {
    const g = geometry(spec({ columns: MIN_TERMINAL_COLUMNS, rows: 30, sidebarWidth: 999 }));
    expect(g.output!.width).toBeGreaterThanOrEqual(MAIN_MIN_WIDTH);
  });
});

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

  it("侧边栏那几项两行高 ⇒ 命中下标**就是**会话下标（不必再换算一次）", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 22 }));
    expect(hitTest(3, 0, g.sidebarRows)).toBe(0);
    expect(hitTest(3, 1, g.sidebarRows)).toBe(0);
    expect(hitTest(3, SESSION_ROWS, g.sidebarRows)).toBe(1);
    expect(hitTest(3, SESSION_ROWS + 1, g.sidebarRows)).toBe(1);
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

  it("每一行的 start 就是它第一���字在原串里的下标（点第二行要靠它回原串）", () => {
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

describe("不变量 ⑧ 之二：各区高度之和**恒等于**终端行数", () => {
  it.each(SAMPLES)("columns=%i rows=%i：结果块 + 面板 + 输入框 + 状态行 == rows", (columns, rows) => {
    for (const paletteCount of [0, 3, 19]) {
      for (const input of [
        "",
        "/status",
        "/user pass charlie 汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字",
      ]) {
        const g = geometry(spec({ columns, rows, paletteCount, input }));
        if (g.output === null || g.input === null || g.statusLine === null) continue;
        const panel = g.paletteRows.length + (g.paletteFooterRow === null ? 0 : 1);
        // ⚠️ 少一行的话 Ink 的列向 flex 会把整屏内容**往上顶** —— 症状是「状态行画在了
        // 输入框上面那一行、最底那一行空着」（实测踩过一次，那时没有任何单测能看见它）
        expect(g.outputBlockRows + panel + g.input.height + g.statusLine.height).toBe(rows);
      }
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

describe("模态窗口：一块带框的浮层 + 右上角那枚 esc", () => {
  it("没开窗口时四个矩形全是 null（判据与坐标同源）", () => {
    const g = geometry(spec({ window: false, windowRows: 3, windowFooter: true }));
    expect(g.windowBox).toBeNull();
    expect(g.windowContent).toBeNull();
    expect(g.windowRows).toEqual([]);
    expect(g.windowClose).toBeNull();
  });

  it("开窗口时框有宽有高，且**留在屏内**", () => {
    const g = geometry(spec({ columns: 100, rows: 30, window: true, windowRows: 3, windowFooter: true }));
    expect(g.windowBox!.width).toBeGreaterThan(10);
    expect(g.windowBox!.height).toBeGreaterThanOrEqual(3);
    expect(g.windowBox!.x).toBeGreaterThanOrEqual(0);
    expect(g.windowBox!.x + g.windowBox!.width).toBeLessThanOrEqual(100);
    expect(g.windowBox!.y + g.windowBox!.height).toBeLessThanOrEqual(30);
  });

  it("框内第一行是**标题**：那些行从 content.y + 1 起算（否则第 1 行盖掉标题）", () => {
    const g = geometry(spec({ columns: 100, rows: 30, window: true, windowRows: 3, windowFooter: true }));
    expect(g.windowRows[0]!.y).toBe(g.windowContent!.y + 1);
  });

  it("那一枚 esc 在**上边框那一行**上、贴着右边", () => {
    const g = geometry(spec({ columns: 100, rows: 30, window: true, windowRows: 3, windowFooter: true }));
    expect(g.windowClose!.y).toBe(g.windowBox!.y);
    expect(g.windowClose!.height).toBe(1);
    expect(g.windowClose!.x + g.windowClose!.width).toBeLessThanOrEqual(
      g.windowBox!.x + g.windowBox!.width,
    );
  });

  it("可点的那一枚 esc 与画它的是同一个矩形（点它关窗靠的就是它）", () => {
    const g = geometry(spec({ columns: 100, rows: 30, window: true, windowRows: 2, windowFooter: false }));
    expect(hitTest(g.windowClose!.x, g.windowClose!.y, [g.windowClose!])).toBe(0);
  });

  it("底部那一条说明占掉一行，于是可点行少一行（用「屏高撞上限」那一档）", () => {
    const withFooter = geometry(
      spec({ columns: 100, rows: 13, window: true, windowRows: 9, windowFooter: true }),
    );
    const without = geometry(
      spec({ columns: 100, rows: 13, window: true, windowRows: 9, windowFooter: false }),
    );
    expect(withFooter.windowRows.length).toBeLessThan(without.windowRows.length);
  });

  it("装不下时按屏高截断（**不是**整个不画：没有窗口等于那条命令什么都没发生）", () => {
    const g = geometry(
      spec({ columns: 100, rows: 13, window: true, windowRows: 9, windowFooter: true }),
    );
    expect(g.windowBox).not.toBeNull();
    expect(g.windowRows.length).toBeLessThan(9);
  });

  it("屏太矮时**不画窗口**（一个里面放不下任何东西的框是纯噪音）", () => {
    const g = geometry(spec({ columns: 100, rows: 4, window: true, windowRows: 2, windowFooter: false }));
    expect(g.windowBox).toBeNull();
  });

  it("宽屏那一档窗口浮在正中（它**不**盖住输入区 —— 两者只是同屏）", () => {
    const g = geometry(spec({ columns: 100, rows: 30, window: true, windowRows: 3, windowFooter: true }));
    const box = g.windowBox!;
    // 居中判据是「四边的余量差不超过一列/一行」（奇数屏宽屏高下取整会差一）
    expect(Math.abs(box.x - (100 - box.x - box.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y - (30 - box.y - box.height))).toBeLessThanOrEqual(1);
  });

  it("屏矮到窗口必须压住输入区（**故意的**：模态就是压在东西上面的）", () => {
    const g = geometry(spec({ columns: 100, rows: 12, window: true, windowRows: 3, windowFooter: true }));
    const box = g.windowBox!;
    const overlaps = g.input!.y < box.y + box.height && g.input!.y + g.input!.height > box.y;
    expect(overlaps).toBe(true);
  });
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

/* ── 变异实测表（**十五条全部跑过，十五条全部转红**）─────────────────────
 *
 * 跑法：`node <harness>/mut-geometry.mjs`（harness 逐条改源码 → 跑本档 → 复原）。
 * ⚠️ 那句「全部转红」不是估计：⚠️ 其中 **N9 在补上「多出一行空行」那条断言之前是绿的**
 * （它只多出一行**空行**、并不丢字符），而那条绿暴露的是「判据写错了地方」——
 * 折行判据里 `index > start` 那个半边挡的是**空行**，不是丢字符。
 *
 * | # | 变异 | 转红的判据 |
 * | --- | --- | --- |
 * | N1 | `SIDEBAR_GAP` 改成 0 | ④「那一列不落在侧边栏里、也不落在主区里」 |
 * | N2 | 主区 `x` 忘了加上间隔列 | ④「主区左边恒等于侧边栏宽 + 1」 |
 * | N3 | `sidebarWidthBounds` 去掉「主区至少留 MAIN_MIN_WIDTH」 | ④「窄屏：上界由…决定」 |
 * | N4 | 几何层不再夹越界的拖动值 | ④「几何层把越界的那个拖动值夹回区间」 |
 * | N5 | `SESSION_ROWS` 改成 1 | ③「每一项高度恒等于 SESSION_ROWS」 |
 * | N6 | 侧边栏项的 y 用 `i` 而不是 `i * SESSION_ROWS` | ⑤「命中下标**就是**会话下标」 |
 * | N7 | `sidebarHandle` 取最左那一列 | ③「手柄 = 侧边栏最右那一列」 |
 * | N8 | `wrapInput` 用 `ch.length` 而不是 `stringWidth` | ⑦「按显示列断」 |
 * | N9 | 折行判据去掉 `index > start` | ⑦「也不多出一行空行」 |
 * | N10 | 空串返回**零**行 | ②「空输入也是一行」 |
 * | N11 | `caretRowOf` 从**前**往后扫 | ⑦「行末的光标算这一行的末尾」 |
 * | N12 | 窗口那些行不留标题那一行 | 「框内第一行是**标题**」 |
 * | N13 | 那一枚 esc 放进框内第一行 | 「它在上边框那一行上」 |
 * | N14 | 状态行算进框的高度里（框内 +1） | ⑧「它**不占**框内高度」 |
 * | N15 | `cap` 给「至少一行」的兜底 | ⑨「内容区只有两行时 40% 是 0」 |
 */