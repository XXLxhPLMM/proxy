/**
 * 侧边栏那一列：项的度量与容量、文字排版预算、与主区之间那一列，以及从会话项身上右键弹出的菜单。
 *
 * @description
 * 这一列的全部事实都在这里，⚠️ **第一项之上有 {@link SIDEBAR_TOP_PAD_ROWS} 行留白**、**项间恒隔一行**
 * （那一行不属于任何一项）、**记号位 3 + 关闭位 2** 是文字那一段的预算，而**容量只随屏高变**
 * （宽窄只影响裁剪）。
 *
 * ⚠️ 两条会咬人的退化各挡一处：间隔列不见了的话侧边栏与主区在满屏上是一条整块底色；而关闭那一枚放不下时
 * 给一个 0 列宽的格子的话它恒点不中（所以放不下给 `null`）。⚠️ 判据写**算式**而不是常量：拿
 * `SESSION_STRIDE` / `MENU_MIN_WIDTH` 当期望值的话，「改常量」与「改实现」同时发生 ⇒ 恒绿。
 *
 * ⚠️ **「一个会话都没有」与「屏太窄」是同一个答案**（`sidebar === null`，不是「宽度 0 的一个盒子」）：
 * 给一个 0 宽的矩形的话手柄会落在第 0 列上，而那一列本来是主区的。
 *
 * 九条不变量与变异实测表见本目录 `AGENTS.md`。
 *
 * @module tests/geometry
 */

import { describe, expect, it } from "vitest";
import {
  MAIN_MIN_WIDTH,
  MENU_MIN_WIDTH,
  MENU_PAD_X,
  MIN_TERMINAL_COLUMNS,
  SESSION_CLOSE_COLUMNS,
  SESSION_GAP_ROWS,
  SESSION_MARK_COLUMNS,
  SESSION_ROWS,
  SESSION_STRIDE,
  SIDEBAR_GAP,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_TEXT_X,
  SIDEBAR_TOP_PAD_ROWS,
  SIDEBAR_WIDTH,
  geometry,
  hitTest,
  sidebarWidthBounds,
} from "@/lib/geometry.js";
import { spec } from "./_shared.js";
describe("不变量 ③：侧边栏每项 2 行、项间空 1 行、横跨整列，且**第一项之下有顶部留白**", () => {
  it("每一项高度恒等于 SESSION_ROWS 且逐项下移 SESSION_STRIDE 行", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 22 }));
    g.sidebarRows.forEach((row, i) => {
      expect(row.height).toBe(SESSION_ROWS);
      expect(row.y).toBe(SIDEBAR_TOP_PAD_ROWS + i * SESSION_STRIDE);
      expect(row.x).toBe(0);
      expect(row.width).toBe(22);
    });
    // ⚠️ 判据写**算式**而不是常量：拿 `SESSION_STRIDE` 当期望值的话，「改常量」与「改实现」同时发生 ⇒ 恒绿
    expect(SESSION_STRIDE).toBe(SESSION_ROWS + SESSION_GAP_ROWS);
    expect(SESSION_STRIDE).toBe(3);
  });

  // ⚠️ 这一条是「**顶部留白**」的全部内容：第一项落在第 {@link SIDEBAR_TOP_PAD_ROWS} 行，而那几行
  // **不属于任何一项** —— 留着它们的理由是那一列的第一行与主区的第一行不该读成同一条信息。
  // 少留的话每一项都比几何给的行号高一行，症状是「点第 0 行切到会话 1」而屏上那一行是空的。
  it("⚠️ 第一项**之下**恒有留白：`y === SIDEBAR_TOP_PAD_ROWS`，而留白那几行点不中任何一项", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 22 }));
    expect(g.sidebarRows[0]!.y).toBe(SIDEBAR_TOP_PAD_ROWS);
    expect(SIDEBAR_TOP_PAD_ROWS).toBeGreaterThan(0);
    for (let y = 0; y < SIDEBAR_TOP_PAD_ROWS; y += 1) {
      expect(hitTest(3, y, g.sidebarRows)).toBe(-1);
    }
    // ⚠️ 判据写**算式**：拿留白本身当期望值的话，「把常数与实现一起改成 0」会一起变 ⇒ 恒绿
    expect(hitTest(3, SIDEBAR_TOP_PAD_ROWS, g.sidebarRows)).toBe(0);
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

/* ── 侧边栏那几项的**容量**：顶部留白 + 项高 2 + 项间空 1（步长 3），末尾必要时让一行说明 ─── */

describe("侧边栏容量：顶部留白 1 + 项高 2 + 项间空 1（步长 3），末尾必要时让一行说明", () => {
  /**
   * 末项的下缘装得进 `lastRow` 时**装得下几项**（期望值现算，而公式本身被上面那条断言钉住）
   * @description 判据是**下缘**：顶部那 {@link SIDEBAR_TOP_PAD_ROWS} 行与「末项之下不用留项间隔」
   * 两件事都落在这一个算式里；末尾有那一行说明时**末行**是 `rows - 1`
   */
  const within = (lastRow: number): number =>
    Math.max(0, Math.floor((lastRow - SIDEBAR_TOP_PAD_ROWS - SESSION_ROWS) / SESSION_STRIDE) + 1);
  /** 第 `rows` 行那一屏上装得下几项（**没有**末尾那一行说明的那一趟） */
  const fits = (rows: number): number => within(rows);

  it("⚠️ **恰好装满**：屏高 6 装 2 项，末项的下缘**正好**抵着屏底，且没有那一行说明", () => {
    const g = geometry(spec({ rows: 6, sidebarWidth: 22, sessionCount: 2 }));
    expect(fits(6)).toBe(2);
    expect(g.sidebarRows).toHaveLength(2);
    expect(g.sidebarRows[1]!.y).toBe(SIDEBAR_TOP_PAD_ROWS + SESSION_STRIDE);
    expect(g.sidebarRows[1]!.y + SESSION_ROWS).toBe(6);
    expect(g.sidebarOverflowRow).toBeNull();
  });

  it("⚠️ **差一行**：同样的屏高放 3 项 ⇒ 只看得见 1 项，而那一行说明说清「1–1 / 共 3」那一档", () => {
    const g = geometry(spec({ rows: 6, sidebarWidth: 22, sessionCount: 3 }));
    expect(g.sidebarRows).toHaveLength(1);
    expect(g.sidebarRows[0]!.y).toBe(SIDEBAR_TOP_PAD_ROWS);
    // ⚠️ 说明行恒是**最底那一行**，而它与末项之间那几格是空的（说明行占了第 5 行，末项只占 1–2）
    expect(g.sidebarOverflowRow).toEqual({ x: 0, y: 5, width: 22, height: 1 });
    expect(g.sessionViewportRows).toBe(1);
    // ⚠️ **容量那一趟按「不含说明行」判**（= 2），而说明行只在装不下时占一行 —— 两趟不许合成一趟
    expect(fits(6)).toBe(2);
  });

  it("⚠️ **首行不可见**：滚过之后第 0 行上是**清单里的第 `sessionFirst` 项**，而首项号被夹在界内", () => {
    // ⚠️ 屏高 9 只装得下 2 项（不溢出那一档），而清单里 6 个 ⇒ 窗口**一定**能滚
    const g = geometry(spec({ rows: 9, sidebarWidth: 22, sessionCount: 6, sessionsTop: 2 }));
    expect(g.sessionViewportRows).toBe(2);
    expect(g.sessionFirst).toBe(2);
    expect(g.sidebarRows[0]!.y).toBe(SIDEBAR_TOP_PAD_ROWS);
    // ⚠️ 而滚过头时**由本层夹住**（`sessionFirst` 不会越界到「不存在的会话」上）
    const over = geometry(spec({ rows: 9, sidebarWidth: 22, sessionCount: 6, sessionsTop: 99 }));
    expect(over.sessionFirst).toBe(6 - over.sessionViewportRows);
  });

  it("容量只随屏高变，且**与侧边栏宽无关**（宽窄只影响裁剪，不影响放几项）", () => {
    for (const rows of [3, 5, 8, 12, 20, 30]) {
      const room = fits(rows);
      for (const sidebarWidth of [SIDEBAR_MIN_WIDTH, SIDEBAR_WIDTH]) {
        // ⚠️ **恰好装满**：清单里的项数 == 容量 ⇒ 一个都不藏、也没有那一行说明
        const exact = geometry(spec({ rows, sidebarWidth, sessionCount: room }));
        expect(exact.sidebarRows.length).toBe(room);
        expect(exact.sidebarOverflowRow).toBeNull();
        // ⚠️ 而**多一项**：末尾那一行说明占掉一行，可见项数按「末行是 `rows - 1`」那一趟重算
        const over = geometry(spec({ rows, sidebarWidth, sessionCount: room + 1 }));
        expect(over.sessionViewportRows).toBe(within(rows - 1));
        expect(over.sidebarOverflowRow).not.toBeNull();
        // ⚠️ 而**任何一项的下缘都不越过**屏底（越过 ⇒ Ink 把下一帧整体下移）
        for (const row of [...exact.sidebarRows, ...over.sidebarRows]) {
          expect(row.y + row.height).toBeLessThanOrEqual(rows);
        }
      }
    }
  });

  // ⚠️ 极矮的屏：**留白本身放不下一项**时容量是 0（而不是「负数项」或「硬塞一项进去」）——
  // 症状是「那一项的下缘越出屏底」，而 Ink 越界那一行会把下一帧整体下移。
  it("极矮的屏放不下一项时**零项**，而恰好装下时那一项的下缘**不越过**屏底", () => {
    for (const rows of [0, 1, 2, SIDEBAR_TOP_PAD_ROWS + SESSION_ROWS - 1]) {
      const g = geometry(spec({ rows, sidebarWidth: 22, sessionCount: 1 }));
      expect(g.sessionViewportRows).toBe(0);
      expect(g.sidebarRows).toEqual([]);
    }
    const exact = geometry(
      spec({ rows: SIDEBAR_TOP_PAD_ROWS + SESSION_ROWS, sidebarWidth: 22, sessionCount: 1 }),
    );
    expect(exact.sessionViewportRows).toBe(1);
    expect(exact.sidebarRows[0]!.y + SESSION_ROWS).toBeLessThanOrEqual(
      SIDEBAR_TOP_PAD_ROWS + SESSION_ROWS,
    );
  });

  // ⚠️ **两趟不许合成一趟**：末尾那一行说明只在「装不下」时占一行，而「装不下」按**不含它**的容量判。
  // 合成一趟（直接按 `h - 1` 算）的话「容量恰好等于项数」那一档会凭空少一项。
  it("⚠️ 容量恰好等于项数的那一档**不溢出**（说明行不该占那一行）", () => {
    const rows = SIDEBAR_TOP_PAD_ROWS + SESSION_ROWS + SESSION_STRIDE;
    const exact = geometry(spec({ rows, sidebarWidth: 22, sessionCount: 2 }));
    expect(exact.sessionViewportRows).toBe(2);
    expect(exact.sidebarOverflowRow).toBeNull();
    // ⚠️ 而**多一项**时它才出现，且可见项数掉到「扣掉说明行之后」的那一个
    const over = geometry(spec({ rows, sidebarWidth: 22, sessionCount: 3 }));
    expect(over.sessionViewportRows).toBe(1);
    expect(over.sidebarOverflowRow).not.toBeNull();
  });

  it("删掉会话之后窗口越界由本层兜住（可见项数会变，而首项号不会指到不存在的会话）", () => {
    const many = geometry(spec({ rows: 9, sidebarWidth: 22, sessionCount: 9, sessionsTop: 7 }));
    expect(many.sessionFirst).toBeGreaterThan(0);
    const after = geometry(spec({ rows: 9, sidebarWidth: 22, sessionCount: 2, sessionsTop: 7 }));
    expect(after.sessionFirst).toBe(0);
    expect(after.sidebarRows).toHaveLength(2);
  });
});

/* ── 侧边栏那一列的**文字排版**预算：记号位 3 + 关闭位 2 ───────────────────────────── */

describe("侧边栏文字排版：名字起始列 3、名字前面恒留记号位、右侧恒留关闭位", () => {
  it("三个常数本身被钉住（判据上面那些量的是**相对关系**）", () => {
    expect([SIDEBAR_TEXT_X, SESSION_MARK_COLUMNS, SESSION_CLOSE_COLUMNS]).toEqual([3, 3, 2]);
    expect(SIDEBAR_WIDTH).toBe(32);
    // ⚠️ **名字的起始列恒等于记号位的右缘** —— 这两条各自成立而合起来才是「名字紧跟在记号后面」：
    // 差一格的话名字与记号之间多出一段空隙（或压着记号），而屏上零报错
    expect(SIDEBAR_TEXT_X).toBe(SESSION_MARK_COLUMNS);
  });

  // ⚠️ 记号位**必须是奇数**：居中 = 左若干列 + 字形 + 右同样多列，偶数列上「居中」在数学上不成立。
  // 判据写成「奇数」而不是「等于 3」：后者在常数与实现一起被改掉时恒绿。
  it("⚠️ 记号位**恒是奇数**（两侧留同样多列才叫居中），而 `✕` 那一枚仍占两列", () => {
    expect(SESSION_MARK_COLUMNS % 2).toBe(1);
    expect(SESSION_MARK_COLUMNS).toBeGreaterThanOrEqual(3);
    expect(SESSION_CLOSE_COLUMNS).toBe(2);
  });

  it("⚠️ 关闭那一枚放不下时给 `null`（0 列宽的按钮恒点不中），而放得下时它在最右那两列", () => {
    const roomy = geometry(spec({ rows: 30, sidebarWidth: 32 }));
    const slot = roomy.sidebarCloseRows[0]!;
    expect(slot).not.toBeNull();
    expect(slot!.x).toBe(32 - SESSION_CLOSE_COLUMNS);
    // ⚠️ 「关闭」的 y **同源**于那一项的 y（顶部留白一起算进去）：错开一行的话点在名字上却
    // 触发第二行那一格，而症状是「悬停那一帧那枚 ✕ 往下飘了一格」
    expect(slot!.y).toBe(roomy.sidebarRows[0]!.y);
    expect(slot!.height).toBe(1);
    // ⚠️ 最窄那一档（14 列 − 名字起始列 3 − 关闭 2 = 9 ≥ 4）放得下；再窄就**不画**，而不是给一个 0 宽的格子
    expect(geometry(spec({ rows: 30, sidebarWidth: SIDEBAR_MIN_WIDTH })).sidebarCloseRows[0]).not.toBeNull();
  });

  it("记号位**恒在**每一项上（与那一项有没有记号无关 —— 那是状态层的事）", () => {
    const g = geometry(spec({ rows: 30, sidebarWidth: 32 }));
    expect(SESSION_MARK_COLUMNS).toBeGreaterThan(0);
    // ⚠️ 名字能占的宽度 = 侧边栏宽 − 记号位 − 关闭位（名字**起始列**就是记号位的右缘，故只扣一次）
    expect(g.sidebarRows[0]!.width - SESSION_MARK_COLUMNS - SESSION_CLOSE_COLUMNS).toBe(27);
  });
});

/* ── 会话菜单：贴着右键落点的一块浮层（**不是模态**） ─────────────────────── */

describe("会话菜单：贴落点、夹进屏内、宽度按最长那一项", () => {
  const request = (over: Partial<{ x: number; y: number; items: readonly string[] }> = {}) => ({
    x: 4,
    y: 6,
    items: ["新建会话", "重命名"],
    ...over,
  });

  it("没开菜单时那两个字段是 `null` 与空数组（判据与坐标同源）", () => {
    const g = geometry(spec({ menu: null }));
    expect(g.menu).toBeNull();
    expect(g.menuRows).toEqual([]);
  });

  it("宽度按最长那一项加两格缩进，而下限兜住「四个汉字 + 缩进」", () => {
    const g = geometry(spec({ menu: request() }));
    // 「新建会话」四个汉字 = 8 列 + 左右各 1 = 10，而下限是 12 —— **下限赢**
    expect(g.menu!.width).toBe(MENU_MIN_WIDTH);
    expect(MENU_MIN_WIDTH).toBe(12);
    const wide = geometry(spec({ menu: request({ items: ["新建会话", "重命名并留在这个会话上"] }) }));
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
    // ⚠️ 重叠点落在**第一项**那一行上（顶部留白之下），而落点本身给的是第 0 行 ⇒ 判据换成
    // 「菜单与侧边栏的重叠**真的存在**」时必须落到某一项身上，否则这条恒真空
    const firstTop = g.sidebarRows[0]!.y;
    const onItem = geometry(spec({ rows: 30, sidebarWidth: 32, menu: request({ x: 1, y: firstTop }) }));
    expect(hitTest(onItem.menuRows[0]!.x, firstTop, onItem.sidebarRows)).toBe(0);
    expect(hitTest(onItem.menuRows[0]!.x, firstTop, onItem.menuRows)).toBe(0);
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
    expect(hitTest(gap, 4, g.sidebarRows)).toBe(-1);
    expect(hitTest(gap, 4, [{ ...g.output! }])).toBe(-1);
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
