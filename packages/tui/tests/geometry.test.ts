/**
 * `@/console/geometry`（屏幕几何）的纯函数断言
 *
 * **锁什么**：五条不变量 —— ①**任何终端尺寸下都不许出现负坐标**；②各区域首尾相接、**不重叠也不留缝**
 * （`input` 底边 == 终端行数、`output` 底边 == `input` 顶边）；③侧边栏那几行**恰好 1 行高且互不重叠**；
 * ④命中测试用**半开区间**（点整除边界归右边那个，否则「点第一行」会去切第二台机器）；
 * ⑤输入行的列 → 插入符下标按**显示宽度**算（点中文右半边不能落在它一半的位置）。
 *
 * **为什么拆掉哪一处会红**：
 * - `rect` 里去掉 `Math.max(0, …)` → 「极小终端不产负坐标」那组红。⚠️ 这条**曾经真的发生过**：
 *   `rows = 2` 时 `bottomY = 2 - 3 = -1`，输入框的 y 是 -1，于是命中测试里 `y=0` 落在 `[-1, 2)`
 *   内 —— **第一行的点击会被判成点了输入框**。所以这组不是洁癖。
 * - `hitTest` 的 `<=` 改成闭区间 → 「整除边界归右边」那组红。症状是点 A 行切到 B 机，而 B 机
 *   恰好常用，于是这个 bug「有时是对的」，极难归因。
 * - `caretFromColumn` 里的 `stringWidth` 换成 `ch.length` → 「点中文右半边」那组红（插入符落在
 *   一个宽字符的中间，终端会把它画成半个豆腐块）。⚠️ **纯 ASCII 的用例对两种度量都成立**，
 *   故这组必须带 CJK。
 * - `sidebarWidth` 的窄屏判定去掉 → 「太窄就不画侧边栏」那组红（侧边栏会把结果区挤到十几列，
 *   表全部软换行）。
 *
 * ⚠️ 本档**不测**「画出来的样子」：那要真终端（见 `src/AGENTS.md`「相关测试」）。这里能测的
 * 是「画的与点的读同一份数字」——那才是渲染与命中不会分叉的原因。
 */

import { describe, expect, it } from "vitest";
import {
  BORDER_COLUMNS,
  BORDER_LEFT_COLUMN,
  BORDER_ROWS,
  INPUT_BLOCK_HEIGHT,
  MIN_TERMINAL_COLUMNS,
  caretFromColumn,
  geometry,
  hitTest,
  type Geometry,
  type Rect,
} from "@/console/geometry.js";

/** 遍历全部矩形（含侧边栏那几行） */
function allRects(g: Geometry): Rect[] {
  const out: Rect[] = [];
  if (g.sidebar !== null) out.push(g.sidebar);
  if (g.output !== null) out.push(g.output);
  if (g.input !== null) out.push(g.input);
  return [...out, ...g.sidebarRows];
}

/** 常见尺寸的样本（含正常、极窄、极矮、0×0） */
const SAMPLES: Array<[number, number]> = [
  [120, 40],
  [100, 30],
  [80, 24],
  [MIN_TERMINAL_COLUMNS, 20],
  [MIN_TERMINAL_COLUMNS - 1, 20],
  [50, 30],
  [200, 10],
  [120, 2],
  [120, 1],
  [120, 0],
  [0, 0],
];

describe("不变量 ①：任何终端尺寸下都不许出现负坐标（否则命中测试会吃掉上方区域的点击）", () => {
  it.each(SAMPLES)("columns=%i rows=%i 下全部矩形坐标非负且宽高非负", (columns, rows) => {
    for (const r of allRects(geometry(columns, rows, 3, 0))) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.width).toBeGreaterThanOrEqual(0);
      expect(r.height).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.x) && Number.isInteger(r.y)).toBe(true);
      expect(Number.isInteger(r.width) && Number.isInteger(r.height)).toBe(true);
    }
  });

  it("rows=2 时输入区**只拿主区剩下的两行**、不越出屏顶", () => {
    // ⚠️ 输入区的高度恒是 `min(3, 主区高度)`，故它**永不越过主区顶边**。它一旦能越过，
    // 两段文字就抢同一行 —— 而 `tsc` / lint / 其余全部测试都不会红。
    const g = geometry(100, 2, 3, 0);
    expect(g.input?.y).toBe(0);
    expect(g.input?.height).toBe(2);
    expect(g.input!.y + g.input!.height).toBe(2);
    // 主区一行都分不出给结果区 —— 那就让它是 0 高，而不是负高
    expect(g.output?.height).toBe(0);
  });
});

describe("不变量 ②：各区域首尾相接（不重叠、不留缝）", () => {
  it("120×40：两个框从第 0 行起、铺到第 40 行，**顶部没有横向区域**", () => {
    const g = geometry(120, 40, 3, 0);
    expect(g.output!.y).toBe(0);
    expect(g.sidebar!.y).toBe(0);
    expect(g.output!.y + g.output!.height).toBe(g.input!.y);
    expect(g.input!.y + g.input!.height).toBe(40);
    expect(g.input!.height).toBe(INPUT_BLOCK_HEIGHT);
  });

  it("侧边栏与主区横向不重叠、且横向铺满", () => {
    const g = geometry(120, 40, 3, 0);
    expect(g.sidebar!.x + g.sidebar!.width).toBe(g.output!.x);
    expect(g.output!.x + g.output!.width).toBe(120);
  });

  it("极窄屏（< 阈值）时侧边栏整个不存在，而主区仍铺满", () => {
    const g = geometry(50, 30, 3, 0);
    expect(g.sidebar).toBeNull();
    expect(g.sidebarRows).toHaveLength(0);
    expect(g.output!.x).toBe(0);
    expect(g.output!.x + g.output!.width).toBe(50);
  });

  it("结果区的内容宽高按 Ink 边框扣，且视口另留 1 行给滚动提示", () => {
    const g = geometry(120, 40, 3, 0);
    // 宽度：只扣左右框各 1 列（呈现层自己补左边框 + 内边距那一格）
    expect(g.outputWidth).toBe(g.output!.width - BORDER_COLUMNS);
    // 高度：上下框各 1 行，再留 1 行给「下面还有多少」那一行
    expect(g.outputRows).toBe(g.output!.height - BORDER_ROWS - 1);
    // ⚠️ 这两条是**互锁**的：呈现层按 outputRows 画内容区、按 outputWidth 裁每一行。
    // 几何少扣一行 → 最后一行内容撞下框被裁（症状是「状态行看不见」）；
    // 少扣一列 → 每一行都超宽一格 → Ink 静默软换行 → 整屏往下移。
    expect(g.outputRows).toBeGreaterThan(0);
    expect(g.outputWidth).toBeGreaterThan(0);
  });

  it("侧边栏那一行在框内侧（上框之下、右框之左），且不与下框重叠", () => {
    const g = geometry(120, 40, 3, 0);
    const first = g.sidebarRows[0]!;
    // 上框那一行不算内容
    expect(first.y).toBeGreaterThan(g.sidebar!.y);
    // 右框那一列不算可点区域
    expect(first.x + first.width).toBeLessThanOrEqual(g.sidebar!.x + g.sidebar!.width - 1);
  });

  it("侧边栏那几行全都在侧边栏矩形内，且恰好 1 行高", () => {
    const g = geometry(120, 40, 3, 0);
    expect(g.sidebarRows).toHaveLength(3);
    for (const row of g.sidebarRows) {
      expect(row.height).toBe(1);
      expect(row.y).toBeGreaterThanOrEqual(g.sidebar!.y);
      expect(row.y + row.height).toBeLessThanOrEqual(g.sidebar!.y + g.sidebar!.height);
      expect(row.x).toBeGreaterThanOrEqual(g.sidebar!.x);
    }
  });

  it("侧边栏与主区**齐底**（不齐底 = 侧边栏矮三行，它下面那片空白像「没画完」）", () => {
    // ⚠️ 齐底的对象是**输入区**不是结果区：侧边栏那个框画满整段主区高度（`layout.tsx:Sidebar`
    // 给的是 `rect.height`），而结果区只是主区框的**上半段**（输入区从底部往上占 3 行）。
    // 拿结果区的底边当齐平判据，会在一条**正确**的布局上红 —— 而那种红会逼着人把布局改坏。
    // ⚠️ 这条**真的红过**：早前 `bottomY` 是相对整屏算的（`h - INPUT_BLOCK_HEIGHT`），
    // 于是侧边栏高 `h-1-3`、输入区底边在 `h-3`，两个并排的框底边差三行。
    for (const [columns, rows] of SAMPLES) {
      const g = geometry(columns, rows, 3, 0);
      if (g.sidebar === null || g.output === null || g.input === null) continue;
      // 顶边：侧边栏与主区同起（屏顶那一行）
      expect(g.sidebar.y).toBe(g.output.y);
      // 底边：侧边栏与输入区同止
      expect(g.sidebar.y + g.sidebar.height).toBe(g.input.y + g.input.height);
      // ⚠️ 顺带把「结果区正好顶到输入区」也钉住：中间留一行的缝，屏幕上就是一条没人解释的空白带
      expect(g.output.y + g.output.height).toBe(g.input.y);
    }
  });

  it("侧边栏宽度 + 主区宽度 = 终端总列数（少一列会被 Ink 的 flex 压窄 → 静默软换行）", () => {
    for (const [columns, rows] of SAMPLES) {
      const g = geometry(columns, rows, 3, 0);
      // ⚠️ `output` 是可空的（`columns = 0` 时没有主区可画），所以判据必须**整条跳过**而不是
      // 拿 `!` 断言「它不是 null」—— 那在一个正确的极窄样本上直接抛 TypeError，
      // 于是这条护栏对「0 列」这一档**从来没跑过**。
      if (g.output === null) {
        expect(g.sidebar).toBeNull();
        continue;
      }
      const sidebarWidth = g.sidebar === null ? 0 : g.sidebar.width;
      expect(sidebarWidth + g.output.width).toBe(g.columns);
    }
  });

  it("侧边栏那几行互不重叠（相邻行的 y 差恰好 1）", () => {
    const g = geometry(120, 40, 5, 0);
    for (let i = 1; i < g.sidebarRows.length; i += 1) {
      expect(g.sidebarRows[i]!.y - g.sidebarRows[i - 1]!.y).toBe(1);
    }
  });

  it("侧边栏能画下几行目标 = 框内高 − 标题行数（标题占一行 → 37 行）", () => {
    // ⚠️ 判据落在一个**算出来的字面量**上：40 行 − 上下框 2 行 = 38 行内容，减去**一行**标题
    // 得 37。写成 `sidebarContentHeight - SIDEBAR_HEADER_HEIGHT` 会是**恒绿** —— 两边读同一个
    // 常量，标题多一行时两边一起变，断言照绿。而「标题多一行」的正后果正是「少画一行目标」，
    // 那在屏上表现为「台账里有 38 个却只列出 37 个，且没有任何地方说还差一个」。
    expect(geometry(120, 40, 100, 0).sidebarRows).toHaveLength(37);
    // 同理：第一行目标紧跟在**一行**标题之下（0 + 上框 1 + 标题 1）
    expect(geometry(120, 40, 3, 0).sidebarRows[0]!.y).toBe(2);
  });

  it("目标比装得下的还多时只画装得下的那些（不画到输入区里去）", () => {
    const g = geometry(120, 8, 50, 0);
    const fit = g.sidebar!.height - 2;
    expect(g.sidebarRows.length).toBeLessThanOrEqual(fit);
    for (const row of g.sidebarRows) {
      expect(row.y + row.height).toBeLessThanOrEqual(g.sidebar!.y + g.sidebar!.height);
    }
  });
});

describe("不变量 ③：命中测试用半开区间", () => {
  const two: Rect[] = [
    { x: 0, y: 0, width: 5, height: 1 },
    { x: 5, y: 0, width: 5, height: 1 },
  ];

  it("横向：点整除边界（x=5）归右边那个，不是左边", () => {
    expect(hitTest(4, 0, two)).toBe(0);
    expect(hitTest(5, 0, two)).toBe(1);
  });

  it("横向：最后一个元素的右边界之外不命中", () => {
    expect(hitTest(9, 0, two)).toBe(1);
    expect(hitTest(10, 0, two)).toBe(-1);
    expect(hitTest(-1, 0, two)).toBe(-1);
  });

  it("纵向：侧边栏那几行的边界同理", () => {
    const rows: Rect[] = [
      { x: 0, y: 3, width: 20, height: 1 },
      { x: 0, y: 4, width: 20, height: 1 },
      { x: 0, y: 5, width: 20, height: 1 },
    ];
    expect(hitTest(2, 3, rows)).toBe(0);
    expect(hitTest(2, 4, rows)).toBe(1);
    expect(hitTest(2, 5, rows)).toBe(2);
    expect(hitTest(2, 6, rows)).toBe(-1);
  });

  it("点侧边栏右边界之外落到别处而不是第一行（闭区间 bug 的原始形状）", () => {
    const rows: Rect[] = [{ x: 0, y: 3, width: 20, height: 1 }];
    expect(hitTest(20, 3, rows)).toBe(-1);
  });

  it("空候选表返回 -1（而不是抛错或返回 0）", () => {
    expect(hitTest(0, 0, [])).toBe(-1);
  });

  it("真实几何上：点侧边栏第一行命中第一条，点结果区不命中侧边栏", () => {
    const g = geometry(120, 40, 3, 0);
    const first = g.sidebarRows[0]!;
    expect(hitTest(first.x, first.y, g.sidebarRows)).toBe(0);
    expect(hitTest(g.output!.x, g.output!.y, g.sidebarRows)).toBe(-1);
  });
});

describe("不变量 ③b：命中测试的另外四条（倒序边界 / 嵌套 / 零宽零高 / 非整数）", () => {
  const twoCells: Rect[] = [
    { x: 0, y: 0, width: 2, height: 1 },
    { x: 2, y: 0, width: 2, height: 1 },
  ];

  it("两格宽的相邻矩形：点在整除边界上归**右边那个**", () => {
    expect(hitTest(2, 0, twoCells)).toBe(1);
    expect(hitTest(0, 0, twoCells)).toBe(0);
    expect(hitTest(1, 0, twoCells)).toBe(0);
    expect(hitTest(3, 0, twoCells)).toBe(1);
  });

  it("边界归属由**几何**决定，与下标顺序无关（判据若掺进顺序，闭区间 + 「最后一个赢」会点错行）", () => {
    // ⚠️ 这一组必须**倒序**给矩形：正序时「两格宽相邻 + 最后一个赢」恰好与闭区间的结果一致，
    // 于是上面那条断言对「半开 vs 闭」是**恒绿**的 —— 而一个右对齐 / 反向绘制的调用方（顺序由
    // 绘制序决定，不由左到右决定）在边界列上会拿到左边那一格。倒过来给，闭区间立刻给出 0。
    const reversed = [...twoCells].reverse();
    expect(hitTest(2, 0, reversed)).toBe(0);
    expect(hitTest(0, 0, reversed)).toBe(1);
    expect(hitTest(1, 0, reversed)).toBe(1);
  });

  it("最后一个元素在**外**（宽度不越界到下一个元素）", () => {
    expect(hitTest(4, 0, twoCells)).toBe(-1);
  });

  it("最后一行含 `y + height - 1`、不含 `y + height`", () => {
    const rects: Rect[] = [{ x: 0, y: 2, width: 4, height: 3 }];
    expect(hitTest(0, 2, rects)).toBe(0);
    expect(hitTest(0, 4, rects)).toBe(0);
    expect(hitTest(0, 5, rects)).toBe(-1);
    expect(hitTest(0, 1, rects)).toBe(-1);
  });

  it("真重叠时**后一个赢**（下标序就是绘制序，上层先拿到这次点击）", () => {
    const nested: Rect[] = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 2, y: 2, width: 2, height: 2 },
    ];
    expect(hitTest(1, 1, nested)).toBe(0);
    expect(hitTest(2, 2, nested)).toBe(1);
  });

  it("零宽 / 零高 / 空列表一律 `-1`", () => {
    expect(hitTest(0, 0, [])).toBe(-1);
    expect(hitTest(0, 0, [{ x: 0, y: 0, width: 0, height: 4 }])).toBe(-1);
    expect(hitTest(0, 0, [{ x: 0, y: 0, width: 4, height: 0 }])).toBe(-1);
  });

  it("坐标非整数一律 `-1`（半个格子不是一格终端）", () => {
    expect(hitTest(0.5, 0, twoCells)).toBe(-1);
    expect(hitTest(Number.NaN, 0, twoCells)).toBe(-1);
    expect(hitTest(Number.POSITIVE_INFINITY, 0, twoCells)).toBe(-1);
  });
});

describe("不变量 ④：输入行的列 → 插入符下标按显示宽度算", () => {
  const box: Rect = { x: 10, y: 37, width: 20, height: 1 };

  it("「a中b」：列 0/1/2/3 → 下标 0/1/1/2（中文占两列，点它不能落在它一半）", () => {
    const text = "a中b";
    expect(caretFromColumn(10, box, text)).toBe(0);
    expect(caretFromColumn(11, box, text)).toBe(1);
    expect(caretFromColumn(12, box, text)).toBe(1);
    expect(caretFromColumn(13, box, text)).toBe(2);
  });

  it("点中文右半边落在这个字之后（判别式：按字符数算会给出别的结果）", () => {
    // 「中文」占列 0-3；点列 2（第二字的第一列）→ 下标 1；点列 4（末尾留白）→ 下标 2
    expect(caretFromColumn(box.x + 2, box, "中文")).toBe(1);
    expect(caretFromColumn(box.x + 4, box, "中文")).toBe(2);
  });

  it("点输入行右侧留白落在末尾（终端的常态行为；不回 -1）", () => {
    expect(caretFromColumn(99, box, "abc")).toBe(3);
  });

  it("点输入行左侧落在开头", () => {
    expect(caretFromColumn(0, box, "abc")).toBe(0);
    expect(caretFromColumn(10, box, "abc")).toBe(0);
  });

  it("空输入时任何一列都落在 0", () => {
    expect(caretFromColumn(15, box, "")).toBe(0);
  });

  it("ASCII 对照组：按显示宽度与按字符数一致，故上面那组才是判别式", () => {
    expect(caretFromColumn(box.x + 2, box, "abc")).toBe(2);
  });
});

/* ── ⑥ 命令面板：它**复用结果区**，且几何层知道一共有几行 ────────────────── */

describe("不变量 ⑥：面板的行与结果区首尾相接，且「装不下」时留一行说清楚", () => {
  /** 面板开着时的样本：给几组「候选数 × 屏高」，含装得下与装不下两种 */
  const CASES: Array<[number, number, number]> = [
    // [终端列, 终端行, 候选数]
    [120, 40, 19],
    [120, 40, 4],
    [120, 12, 19],
    [120, 8, 19],
    [120, 6, 19],
    [120, 3, 19],
    [120, 1, 19],
    [0, 0, 19],
    [59, 20, 19],
  ];

  it.each(CASES)("列=%i 行=%i 候选=%i：每一行都在结果区之内，且**互不重叠**", (c, r, n) => {
    const g = geometry(c, r, 1, n);
    for (const row of g.paletteRows) {
      expect(row.height).toBe(1);
      expect(row.width).toBeGreaterThanOrEqual(0);
      expect(row.x).toBeGreaterThanOrEqual(0);
      expect(row.y).toBeGreaterThanOrEqual(0);
      // ⚠️ **全部**落在结果区之内：面板是「接管结果区」，不是「另开一块」——
      // 越界的那一档症状是「面板的某几行压在输入框的边框上」
      if (g.output !== null) {
        expect(row.y).toBeGreaterThanOrEqual(g.output.y);
        expect(row.y).toBeLessThan(g.output.y + g.output.height);
        expect(row.x + row.width).toBeLessThanOrEqual(g.output.x + g.output.width);
      }
    }
    // 互不重叠（否则命中测试对相邻两行的判断互相打架）
    for (let i = 1; i < g.paletteRows.length; i += 1) {
      expect(g.paletteRows[i]!.y).toBeGreaterThan(g.paletteRows[i - 1]!.y);
    }
  });

  it.each(CASES)(
    "列=%i 行=%i 候选=%i：画出来的行数 + 说明行恰好等于内容高度（装不下才留说明行）",
    (c, r, n) => {
      const g = geometry(c, r, 1, n);
      const avail = g.output === null ? 0 : Math.max(0, g.output.height - BORDER_ROWS);
      // ⚠️ 判据是「视口 + 说明行 == 内容高度」**两边都成立**：写成「装得下时说明行不存在」
      // 的话，一个「永远留一行」的实现在候选很少时也绿，而那会让面板凭空少显示一条命令。
      // ⚠️ `avail === 0`（屏矮到内容区一行都没有）时**连说明行也没有**：它是内容区里的**一**行。
      expect(g.paletteViewportRows).toBe(Math.max(0, n > avail ? avail - 1 : avail));
      expect(g.paletteRows.length).toBe(Math.min(n, g.paletteViewportRows));
    },
  );

  it("⚠️ 候选数 = 0 时一个矩形都不给（面板没开）", () => {
    // ⚠️ 少给几条 ⇒ 命中测试拿着一份「有 n 行可点」的数据，而屏上一个面板都没有，
    // 点下去静默无响应（与侧边栏「没有就空数组」同一条纪律）
    for (const [c, r] of SAMPLES) {
      expect(geometry(c, r, 3, 0).paletteRows).toEqual([]);
    }
  });

  it("⚠️ 面板**复用**结果区的那一块（不是另开一块 ⇒ 开面板不会让结果区重排）", () => {
    // 判据是「开面板时 `output` 那一格**逐字相同**」：另开一块的实现要么改 `output`，
    // 要么让面板落在输入区里 —— 而两者都会让「敲一个字符结果区就矮一行」。
    const closed = geometry(120, 40, 1, 0);
    const open = geometry(120, 40, 1, 19);
    expect(open.output).toEqual(closed.output);
    expect(open.input).toEqual(closed.input);
    expect(open.outputRows).toBe(closed.outputRows);
  });

  it("面板第一行在**上框之下**（少跳一行会让第一条候选骑在边框上）", () => {
    const g = geometry(120, 40, 1, 19);
    expect(g.paletteRows[0]!.y).toBe(g.output!.y + 1);
    // ⚠️ **对照**：若把它写成 `output.y`，就骑在边框上；而这条断言对「`+ 0`」恒绿，
    // 所以必须配上面那条「都落在结果区之内」—— 它对骑框那一支是红的。
    expect(g.paletteRows[0]!.y).not.toBe(g.output!.y);
  });

  it("第一列 = 结果区内容列（左边框之内），宽度 = 内容宽度", () => {
    const g = geometry(120, 40, 3, 19);
    expect(g.paletteRows[0]!.x).toBe(g.output!.x + BORDER_LEFT_COLUMN);
    expect(g.paletteRows[0]!.width).toBe(g.outputWidth);
  });
});
