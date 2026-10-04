/**
 * `@/lib/geometry`（屏幕几何）的纯函数断言
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
  MENU_MIN_WIDTH,
  MENU_PAD_X,
  MIN_TERMINAL_COLUMNS,
  NOTICE_ROWS,
  PALETTE_MAX_RATIO,
  PROMPT_COLUMNS,
  SESSION_CLOSE_COLUMNS,
  SESSION_GAP_ROWS,
  SESSION_MARK_COLUMNS,
  SESSION_ROWS,
  SESSION_STRIDE,
  SIDEBAR_GAP,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_TEXT_X,
  SIDEBAR_WIDTH,
  STATUS_LINE_HEIGHT,
  WINDOW_CLOSE_INSET,
  WINDOW_FULL_WIDTH_BELOW,
  WINDOW_HEADER_INDENT,
  WINDOW_HEIGHT_RATIO,
  WINDOW_MIN_ROWS,
  WINDOW_MIN_WIDTH,
  WINDOW_PADDING,
  WINDOW_WIDTH_RATIO,
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
} from "@/lib/geometry.js";

/** 一组常用事实的入参（各档只改自己关心的那几个字段） */
function spec(over: Partial<GeometryInput> = {}): GeometryInput {
  return {
    columns: 100,
    rows: 30,
    sidebarWidth: 22,
    sessionCount: 4,
    sessionsTop: 0,
    input: "",
    paletteCount: 0,
    window: false,
    windowRows: 0,
    windowNote: false,
    menu: null,
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
  if (g.windowHeader !== null) out.push(g.windowHeader);
  if (g.windowNoteRow !== null) out.push(g.windowNoteRow);
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
    const g = geometry(spec({ columns, rows, window: true, windowRows: 3, windowNote: false, paletteCount: 9 }));
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

describe("不变量 ③：侧边栏每项 2 行、项间空 1 行、横跨整列，且**第一项就贴着顶边**", () => {
  it("每一项高度恒等于 SESSION_ROWS 且逐项下移 SESSION_STRIDE 行", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 22 }));
    g.sidebarRows.forEach((row, i) => {
      expect(row.height).toBe(SESSION_ROWS);
      expect(row.y).toBe(i * SESSION_STRIDE);
      expect(row.x).toBe(0);
      expect(row.width).toBe(22);
    });
    // ⚠️ 判据写**算式**而不是常量：拿 `SESSION_STRIDE` 当期望值的话，「改常量」与「改实现」同时发生 ⇒ 恒绿
    expect(SESSION_STRIDE).toBe(SESSION_ROWS + SESSION_GAP_ROWS);
    expect(SESSION_STRIDE).toBe(3);
  });

  // ⚠️ 这一条是「顶部**不留白**」的全部内容：第一项落在**第 0 行**。顶部留一行的实现会让
  // 「点第 0 行切到会话 1」这件事命中不了任何一项 —— 而屏上那一行是空的，看着像「点空了」。
  it("⚠️ 第一项**贴着顶边**（顶部没有留白）：`y === 0`，而第 0 行点得中", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 22 }));
    expect(g.sidebarRows[0]!.y).toBe(0);
    expect(hitTest(3, 0, g.sidebarRows)).toBe(0);
  });

  it("⚠️ 相邻两项之间**恒隔一行**，而那一行不属于任何一项（点它切不到任何会话）", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 22 }));
    for (let i = 0; i < g.sidebarRows.length - 1; i += 1) {
      const gapTop = g.sidebarRows[i]!.y + SESSION_ROWS;
      expect(hitTest(3, gapTop, g.sidebarRows)).toBe(-1);
      expect(g.sidebarRows[i + 1]!.y - gapTop).toBe(SESSION_GAP_ROWS);
    }
    expect(SESSION_GAP_ROWS).toBe(1);
  });

  it("侧边栏满高满宽且没有框（frame 是别的字段的事）", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 22 }));
    expect(g.sidebar).toEqual({ x: 0, y: 0, width: 22, height: 30 });
  });

  it("太窄的屏整个侧边栏不画，且那几项是空数组（不是「宽度 0 的 n 行」）", () => {
    const g = geometry(spec({ columns: MIN_TERMINAL_COLUMNS - 1, rows: 30 }));
    expect(g.sidebar).toBeNull();
    expect(g.sidebarRows).toEqual([]);
    expect(g.sidebarHandle).toBeNull();
  });

  // ⚠️ **「一个会话都没有」与「屏太窄」是同一个答案**（`sidebar === null`，不是「宽度 0 的一个盒子」）：
  // 给一个 0 宽的矩形的话手柄会落在第 0 列上（`x = width - 1` 被夹成 0），而那一列本来是主区的。
  it("⚠️ **一个会话都没有 ⇒ 整个侧边栏不存在**（`null`，而手柄与各项也是空/null）", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 32, sessionCount: 0 }));
    expect(g.sidebar).toBeNull();
    expect(g.sidebarRows).toEqual([]);
    expect(g.sidebarCloseRows).toEqual([]);
    expect(g.sidebarHandle).toBeNull();
    expect(g.sidebarOverflowRow).toBeNull();
    expect(g.sessionViewportRows).toBe(0);
    // ⚠️ 而主区**顶上去了**：那一列宽度归 0，于是主区从第 1 列起（与「屏太窄」那一档同一个数）
    expect(g.output!.x).toBe(SIDEBAR_GAP);
    expect(g.output!.width).toBe(100 - SIDEBAR_GAP);
  });

  it("拖动手柄 = 侧边栏最右那一列、满高", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 30 }));
    expect(g.sidebarHandle).toEqual({ x: 29, y: 0, width: 1, height: 30 });
    // ⚠️ 手柄与那一列的**会话项重叠**：命中测试必须先判它
    expect(g.sidebarRows[0]!.x + g.sidebarRows[0]!.width).toBeGreaterThan(g.sidebarHandle!.x);
  });
});

/* ── 侧边栏那几项的**容量**：恰好装满 / 差一行 / 首行不可见 ────────────────── */

describe("侧边栏容量：项高 2 + 项间空 1（步长 3），末尾必要时让一行说明", () => {
  /** 第 `rows` 行那一屏上**装得下几项**（期望值现算，而公式本身被上面那条断言钉住） */
  const fits = (rows: number): number => Math.floor((rows - SESSION_ROWS) / SESSION_STRIDE) + 1;

  it("⚠️ **恰好装满**：屏高 5 装 2 项，末项的下缘**正好**抵着屏底，且没有那一行说明", () => {
    const g = geometry(spec({ rows: 5, sidebarWidth: 22, sessionCount: 2 }));
    expect(fits(5)).toBe(2);
    expect(g.sidebarRows).toHaveLength(2);
    expect(g.sidebarRows[1]!.y).toBe(3);
    expect(g.sidebarRows[1]!.y + SESSION_ROWS).toBe(5);
    expect(g.sidebarOverflowRow).toBeNull();
  });

  it("⚠️ **差一行**：同样的屏高放 3 项 ⇒ 只看得见 1 项，而那一行说明说清「1–1 / 共 3」那一档", () => {
    const g = geometry(spec({ rows: 5, sidebarWidth: 22, sessionCount: 3 }));
    expect(g.sidebarRows).toHaveLength(1);
    expect(g.sidebarRows[0]!.y).toBe(0);
    // ⚠️ 说明行恒是**最底那一行**，而它与末项之间那一格是空的（说明行占了第 4 行，末项只占 0–1）
    expect(g.sidebarOverflowRow).toEqual({ x: 0, y: 4, width: 22, height: 1 });
    expect(g.sessionViewportRows).toBe(1);
  });

  it("⚠️ **首行不可见**：滚过之后第 0 行上是**清单里的第 `sessionFirst` 项**，而首项号被夹在界内", () => {
    // ⚠️ 屏高 8 只装得下 2 项（不溢出那一档），而清单里 6 个 ⇒ 窗口**一定**能滚
    const g = geometry(spec({ rows: 8, sidebarWidth: 22, sessionCount: 6, sessionsTop: 2 }));
    expect(g.sessionViewportRows).toBe(2);
    expect(g.sessionFirst).toBe(2);
    expect(g.sidebarRows[0]!.y).toBe(0);
    // ⚠️ 而滚过头时**由本层夹住**（`sessionFirst` 不会越界到「不存在的会话」上）
    const over = geometry(spec({ rows: 8, sidebarWidth: 22, sessionCount: 6, sessionsTop: 99 }));
    expect(over.sessionFirst).toBe(6 - over.sessionViewportRows);
  });

  it("容量只随屏高变，且**与侧边栏宽无关**（宽窄只影响裁剪，不影响放几项）", () => {
    for (const rows of [3, 5, 8, 12, 20, 30]) {
      const narrow = geometry(spec({ rows, sidebarWidth: SIDEBAR_MIN_WIDTH, sessionCount: 2 }));
      const wide = geometry(spec({ rows, sidebarWidth: SIDEBAR_WIDTH, sessionCount: 2 }));
      expect(narrow.sidebarRows.length).toBe(Math.min(2, fits(rows)));
      expect(wide.sidebarRows.length).toBe(narrow.sidebarRows.length);
    }
  });

  it("删掉会话之后窗口越界由本层兜住（可见项数会变，而首项号不会指到不存在的会话）", () => {
    const many = geometry(spec({ rows: 8, sidebarWidth: 22, sessionCount: 9, sessionsTop: 7 }));
    expect(many.sessionFirst).toBeGreaterThan(0);
    const after = geometry(spec({ rows: 8, sidebarWidth: 22, sessionCount: 2, sessionsTop: 7 }));
    expect(after.sessionFirst).toBe(0);
    expect(after.sidebarRows).toHaveLength(2);
  });
});

/* ── 侧边栏那一列的**文字排版**预算：缩进 3 + 记号 2 + 关闭 2 ───────────────── */

describe("侧边栏文字排版：左缩进 3 列、名字前面恒留记号位、右侧恒留关闭位", () => {
  it("三个常数本身被钉住（判据上面那些量的是**相对关系**）", () => {
    expect([SIDEBAR_TEXT_X, SESSION_MARK_COLUMNS, SESSION_CLOSE_COLUMNS]).toEqual([3, 2, 2]);
    expect(SIDEBAR_WIDTH).toBe(32);
  });

  it("⚠️ 关闭那一枚放不下时给 `null`（0 列宽的按钮恒点不中），而放得下时它在最右那两列", () => {
    const roomy = geometry(spec({ rows: 30, sidebarWidth: 32 }));
    const slot = roomy.sidebarCloseRows[0]!;
    expect(slot).not.toBeNull();
    expect(slot!.x).toBe(32 - SESSION_CLOSE_COLUMNS);
    expect(slot!.y).toBe(0);
    expect(slot!.height).toBe(1);
    // ⚠️ 最窄那一档（14 列 − 缩进 3 − 关闭 2 = 9 ≥ 4）放得下；再窄就**不画**，而不是给一个 0 宽的格子
    expect(geometry(spec({ rows: 30, sidebarWidth: SIDEBAR_MIN_WIDTH })).sidebarCloseRows[0]).not.toBeNull();
  });

  it("记号位**恒在**每一项上（与那一项有没有记号无关 —— 那是状态层的事）", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 32 }));
    expect(SESSION_MARK_COLUMNS).toBeGreaterThan(0);
    // ⚠️ 记号与名字都在缩进右边，故它们能占的宽度是「侧边栏宽 − 缩进 − 记号 − 关闭」
    expect(g.sidebarRows[0]!.width - SIDEBAR_TEXT_X - SESSION_MARK_COLUMNS - SESSION_CLOSE_COLUMNS).toBe(25);
  });
});

/* ── 会话菜单：贴着右键落点的一块浮层（**不是模态**） ─────────────────────── */

describe("会话菜单：贴落点、夹进屏内、宽度按最长那一项", () => {
  const request = (over: Partial<{ x: number; y: number; items: readonly string[] }> = {}) => ({
    x: 4,
    y: 6,
    items: ["删除会话", "重命名"],
    ...over,
  });

  it("没开菜单时那两个字段是 `null` 与空数组（判据与坐标同源）", () => {
    const g = geometry(spec({ menu: null }));
    expect(g.menu).toBeNull();
    expect(g.menuRows).toEqual([]);
  });

  it("宽度按最长那一项加两格缩进，而下限兜住「四个汉字 + 缩进」", () => {
    const g = geometry(spec({ menu: request() }));
    // 「删除会话」四个汉字 = 8 列 + 左右各 1 = 10，而下限是 12 —— **下限赢**
    expect(g.menu!.width).toBe(MENU_MIN_WIDTH);
    expect(MENU_MIN_WIDTH).toBe(12);
    const wide = geometry(spec({ menu: request({ items: ["删除会话", "重命名并留在这个会话上"] }) }));
    // 11 个汉字 = 22 列 + 左右缩进 —— **期望值现算**（按汉字写死一个数的话，改文案就红）
    expect(wide.menu!.width).toBe(11 * 2 + MENU_PAD_X * 2);
  });

  it("⚠️ 每一项**恒一行**、与卡片同宽减两格缩进，且落点就是那个 `x` / `y`", () => {
    const g = geometry(spec({ menu: request() }));
    expect(g.menuRows).toHaveLength(2);
    g.menuRows.forEach((row, i) => {
      expect(row.y).toBe(g.menu!.y + i);
      expect(row.height).toBe(1);
      expect(row.x).toBe(g.menu!.x + MENU_PAD_X);
      expect(row.width).toBe(g.menu!.width - MENU_PAD_X * 2);
    });
    expect(g.menu!.x).toBe(4);
    expect(g.menu!.y).toBe(6);
    expect(g.menu!.height).toBe(2);
  });

  it("⚠️ 贴着右下角的一次右键 ⇒ 整块菜单**留在屏内**（不然最后那几项点不着）", () => {
    const g = geometry(spec({ menu: request({ x: 99, y: 29 }) }));
    expect(g.menu!.x + g.menu!.width).toBeLessThanOrEqual(100);
    expect(g.menu!.y + g.menu!.height).toBeLessThanOrEqual(30);
    const low = geometry(spec({ menu: request({ x: -5, y: -5 }) }));
    expect(low.menu!.x).toBe(0);
    expect(low.menu!.y).toBe(0);
  });

  it("⚠️ 一项都不给 ⇒ **没有菜单**（0 行矩形恒不命中，而它还会白吃掉一次点击）", () => {
    const g = geometry(spec({ menu: request({ items: [] }) }));
    expect(g.menu).toBeNull();
    expect(g.menuRows).toEqual([]);
  });

  it("⚠️ 菜单与侧边栏那些项**重叠**时命中测试必须先判菜单（判据是这个重叠真的存在）", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 32, menu: request({ x: 1, y: 0 }) }));
    expect(g.menuRows[0]!.y).toBe(0);
    expect(hitTest(g.menuRows[0]!.x, 0, g.sidebarRows)).toBe(0);
    expect(hitTest(g.menuRows[0]!.x, 0, g.menuRows)).toBe(0);
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

/* ── 变异实测表（**十八条全部跑过，十八条全部转红**）─────────────────────
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
 * | N12 | 窗口那些行不留分隔那一行 | 「内容区**第一行是分隔**」 |
 * | N13 | 那一枚 esc 放进第二行 | 「`esc` 与**标题同一行**」+ 布局档「标题与 `esc` 同一行」 |
 * | N14 | 状态行算进框的高度里（框内 +1） | ⑧「它**不占**框内高度」 |
 * | N15 | `cap` 给「至少一行」的兜底 | ⑨「内容区只有两行时 40% 是 0」 |
 * | N16 | 窗口宽度改成常量（不再按整屏比例） | 「宽 = 整屏宽 × 70%」+ 布局档「背后**整屏铺上遮罩**」（卡片变宽 → 更多格子落在它之外） |
 * | N17 | 窗口改成按**主区**算（`windowRect(h, w)` → `windowRect(h, mainWidth)`，即「模态是内容区里的东西」） | 「浮在正中」+「宽 = 整屏宽 × 70%」+「宽度**只**由整屏宽决定」—— **三条同时转红** |
 * | N18 | 高度那一项改成 `Math.max(WINDOW_MIN_ROWS, 屏高 − 2)`（**有下限无比例**） | 「高恒为屏高的一半，**与内容行数无关**」（16/18/27/30/50 五档逐档不同，只有比例项全对） |
 *
 * ⚠️ **N18 的判据一开始是绿的**：它原先用 28 行的屏，而那一档「屏高一半 = 14」与「最小 15 行」
 * 同值 ⇒ 把比例那一项删掉它照样绿。改用 50 行（比例 25 > 下限 15）之后转红。
 *
 * ## 会话栏那一轮新增的四条（逐条实测，**四条全部转红**）
 * @description 这一轮把侧边栏的度量整个换掉了（顶部不留白 + 项间空一行 + 缩进 3 + 缺省宽 32），
 * 于是「步长」与「容量」这两处算式必须**各自**有判据 —— 否则「常数改成 2」与「实现跟着改」会一起变。
 *
 * | # | 变异 | 转红的判据 |
 * | --- | --- | --- |
 * | P1 | 第一项之下移一行（顶部加一格留白） | ③「逐项下移 SESSION_STRIDE 行」+「**贴着顶边**」+「恰好装满」+「差一行」+「首行不可见」+「关闭那一枚」—— **六条同时转红** |
 * | P2 | 项的 y 用 `SESSION_ROWS` 而不是 `SESSION_STRIDE` | ③「逐项下移 SESSION_STRIDE 行」+「恒隔一行」+「恰好装满」+ ⑤「命中下标就是会话下标」—— **四条同时转红** |
 * | P3 | `sessionCount === 0` 时仍给一个宽 32 的矩形 | ③「**一个会话都没有 ⇒ 整个侧边栏不存在**」+「太窄的屏整个侧边栏不画」—— **两条同时转红**（后者顺带逮到：`sidebar` 一旦不再是 `null`，那条判据的探针也变了） |
 * | P4 | `menuRect` 不夹进屏内（去掉那两个 `Math.min`） | 「贴着右下角的一次右键 ⇒ 整块菜单**留在屏内**」 |
 */
