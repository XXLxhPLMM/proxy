/**
 * 模态窗口：居中的一块**无框卡片** + 右上角那枚 `esc` 提示 + **按内容槽位**分配的那些行。
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
 *   **第一行是分隔**，槽位从它下面起铺。
 * - ⚠️ **槽位分配**：内容区由入参那串 {@link WindowSlot} **逐槽**铺，每槽高 1 行、装不下的给 `null`
 *   而**长度不变**；`windowRows` / `windowGroups` / `windowChecks` / `windowSelects` 四个**可选面**与
 *   `windowInputs` / `windowInputTexts` 两个**输入面**这六个投影**由同一趟循环**给出
 *   （⚠️ 单数投影表达不了表单：那一档有五个字段）。
 * - ⚠️ **右上角那枚 `esc` 画不画与它占不占列是同一件事**（`windowCloseHint === false` ⇒ 两处都没有）。
 *
 * ⚠️ 判据里写的是**字面量**（`padding 1`、缩进 3、`esc` 宽 9、提示符 2）而不是那几个常量：拿常量当期望值的话，
 * 改常量与改实现同时发生 ⇒ 恒绿。
 *
 * 九条不变量与「判据为什么这么写」见本目录 `AGENTS.md`。
 *
 * @module tests/geometry
 */

import { describe, expect, it } from "vitest";
import {
  MAIN_TEXT_X,
  MIN_TERMINAL_COLUMNS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  WINDOW_CLOSE_COLUMNS,
  WINDOW_CLOSE_INSET,
  WINDOW_FULL_WIDTH_BELOW,
  WINDOW_HEADER_INDENT,
  WINDOW_HEIGHT_RATIO,
  WINDOW_INPUT_PROMPT_COLUMNS,
  WINDOW_MIN_ROWS,
  WINDOW_MIN_WIDTH,
  WINDOW_PADDING,
  WINDOW_WIDTH_RATIO,
  geometry,
  hitTest,
  type Geometry,
  type GeometryInput,
  type WindowSlot,
} from "@/lib/geometry.js";
import { spec } from "./_shared.js";

/** 一台 100×30 的屏、开着三个可选行（几何档的缺省形状） */
const rowSlots = (n: number): WindowSlot[] => Array.from({ length: n }, () => ({ kind: "row" as const }));

describe("模态窗口：居中的一块**无框卡片** + 右上角那枚 esc 提示", () => {
  const open = (over: Partial<GeometryInput> = {}): Geometry =>
    geometry(spec({ window: rowSlots(3), ...over }));

  it("没开窗口时**全部**窗口矩形是 null（判据与坐标同源）", () => {
    // ⚠️ 「没开」的唯一写法是 `window: []`（可选字段会分出「忘了传」与「没开」两种状态）
    const g = geometry(spec());
    expect(g.windowBox).toBeNull();
    expect(g.windowHeader).toBeNull();
    expect(g.windowContent).toBeNull();
    expect(g.windowTitle).toBeNull();
    expect(g.windowClose).toBeNull();
    expect(g.windowSlots).toEqual([]);
    expect(g.windowRows).toEqual([]);
    expect(g.windowGroups).toEqual([]);
    expect(g.windowChecks).toEqual([]);
    expect(g.windowSelects).toEqual([]);
    // ⚠️ 那两个**数组**投影是**空数组**而不是 `null`：它们与 `windowSlots` 同序同长，
    // 而「同长」在「一个槽都没有」时就是 0（给 `null` 会让「第 i 槽」这一问有两种空形状）
    expect(g.windowInputs).toEqual([]);
    expect(g.windowInputTexts).toEqual([]);
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

  it("⚠️ 内容区**第一行是分隔**，槽位从它下面起铺（少这一行 = 第 1 槽盖掉分隔）", () => {
    const g = open({ window: rowSlots(3) });
    expect(g.windowSlots[0]!.y).toBe(g.windowContent!.y + 1);
    // 要几槽给几槽时，**容量恒等于**内容区扣掉分隔那一行
    const full = open({ window: rowSlots(99) });
    expect(full.windowSlots).toHaveLength(99);
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

  // ⚠️ **画不画与占不占列是同一件事**：只判「`windowClose` 是 `null`」的话，「留了空列」会整条绿过去。
  it("⚠️ `windowCloseHint: false` ⇒ `windowClose` 是 null **且** 标题宽出那几列（同一个判据）", () => {
    const on = geometry(spec({ window: rowSlots(2), windowCloseHint: true }));
    const off = geometry(spec({ window: rowSlots(2), windowCloseHint: false }));
    expect(on.windowClose).not.toBeNull();
    expect(off.windowClose).toBeNull();
    // 标题左缘与高度两档相同，**只有宽度**变（而它恰好是「整行宽 − 缩进」）
    expect(off.windowTitle!.x).toBe(on.windowTitle!.x);
    expect(off.windowTitle!.height).toBe(on.windowTitle!.height);
    expect(off.windowTitle!.width).toBe(off.windowHeader!.width - 3);
    expect(on.windowTitle!.width).toBe(on.windowClose!.x - on.windowHeader!.x - 3);
    // ⚠️ 空出来的是 `esc` 那 9 列**加**它离右缘的那 3 列 —— 「宽出 9 列」是它的下界，不是全部
    expect(off.windowTitle!.width - on.windowTitle!.width).toBe(9 + 3);
  });

  it("⚠️ `windowCloseHint: false` **不**把最小行数降一档（`note` / `input` 顶上那一行）", () => {
    for (const rows of [1, 3, 6]) {
      expect(geometry(spec({ rows, window: rowSlots(1), windowCloseHint: true })).windowBox).toBeNull();
      expect(geometry(spec({ rows, window: rowSlots(1), windowCloseHint: false })).windowBox).toBeNull();
    }
    expect(geometry(spec({ rows: 7, window: rowSlots(1), windowCloseHint: false })).windowBox!.height).toBe(4);
    expect(WINDOW_MIN_ROWS).toBe(4);
  });

  it("可点的那一枚 esc 与画它的是同一个矩形（点它关窗靠的就是它）", () => {
    const chip = open({ window: rowSlots(2) }).windowClose!;
    expect(hitTest(chip.x, chip.y, [chip])).toBe(0);
    expect(hitTest(chip.x + chip.width - 1, chip.y, [chip])).toBe(0);
    // ⚠️ 而**卡片之外**那一列点不中（它是卡片的最后一格，不多不少）
    const g = open({ window: rowSlots(2) });
    expect(hitTest(g.windowBox!.x + g.windowBox!.width, chip.y, [chip])).toBe(-1);
  });

  // ── 槽位分配 ──────────────────────────────────────────────────────────────

  it("⚠️ `windowSlots` 与入参那串槽位**同序同长**（长度相等是一条独立判据，不是顺带的）", () => {
    // ⚠️ 「装不下也照样给一个 `null` 占位」是那条同长的**理由**：少了占位，呈现层按下标问
    // 「第 i 槽画不画」就会与命中测试错开一位，而屏上完全看不出异常
    for (const [columns, rows, count] of [
      [100, 30, 3],
      [100, 30, 40],
      [100, 10, 5],
      [100, 8, 7],
      [24, 30, 2],
    ] as const) {
      const window: WindowSlot[] = [
        ...rowSlots(1),
        { kind: "group" },
        ...rowSlots(count),
        { kind: "input" },
      ];
      const g = geometry(spec({ columns, rows, window }));
      expect(g.windowSlots).toHaveLength(window.length);
      expect(g.windowSlots.length).toBe(count + 3);
    }
  });

  it("⚠️ `windowRows` **只**含 `row` 槽，且与 `windowSlots` 同序（夹心序列证明没把标题当行）", () => {
    const window: WindowSlot[] = [
      { kind: "note" },
      { kind: "group" },
      { kind: "row" },
      { kind: "group" },
      { kind: "row" },
    ];
    const g = geometry(spec({ window }));
    expect(g.windowSlots).toHaveLength(5);
    expect(g.windowRows).toHaveLength(2);
    expect(g.windowGroups).toHaveLength(2);
    // ⚠️ **同一批对象**（不是「坐标相同的两份」）：投影若各算一遍，改动时两处会错开而行数照旧对
    expect(g.windowRows[0]).toBe(g.windowSlots[2]);
    expect(g.windowRows[1]).toBe(g.windowSlots[4]);
    expect(g.windowGroups[0]).toBe(g.windowSlots[1]);
    expect(g.windowGroups[1]).toBe(g.windowSlots[3]);
    // ⚠️ 「没把 group 当 row」的另一半：两个投影的**并**恰是那两个 `row` 槽，各一个都不多
    expect([...g.windowRows, ...g.windowGroups].sort((a, b) => a.y - b.y)).toEqual([
      g.windowSlots[1],
      g.windowSlots[2],
      g.windowSlots[3],
      g.windowSlots[4],
    ]);
  });

  it("⚠️ 每一槽恒高 1 行、逐槽下移一行（槽位序 = 屏上顺序 = 命中下标）", () => {
    const window: WindowSlot[] = [{ kind: "group" }, { kind: "note" }, ...rowSlots(3)];
    const g = geometry(spec({ window }));
    g.windowSlots.forEach((one, i) => {
      expect(one).not.toBeNull();
      expect(one!.height).toBe(1);
      expect(one!.y).toBe(g.windowContent!.y + 1 + i);
    });
  });

  it("⚠️ 三档缩进（历史那一档：可选行 / 标题与说明 / 输入框）", () => {
    const g = geometry(
      spec({
        window: [{ kind: "row" }, { kind: "group" }, { kind: "note" }, { kind: "input" }],
      }),
    );
    const inner = g.windowContent!;
    // ⚠️ 字面量而非常量（`MAIN_TEXT_X` 有别的判据钉着它 = 2）
    expect([MAIN_TEXT_X, WINDOW_INPUT_PROMPT_COLUMNS]).toEqual([2, 2]);
    // 可选行：缩进 2 **加**记号 2 ⇒ 左边让开 4、宽度少掉同样那 4
    expect(g.windowSlots[0]!.x).toBe(inner.x + 4);
    expect(g.windowSlots[0]!.width).toBe(inner.width - 4);
    // 标题与说明：让开缩进而**没有**记号
    expect(g.windowSlots[1]!.x).toBe(inner.x + 2);
    expect(g.windowSlots[1]!.width).toBe(inner.width - 2);
    expect(g.windowSlots[2]!.x).toBe(inner.x + 2);
    expect(g.windowSlots[2]!.width).toBe(inner.width - 2);
    // 输入框：满宽（它自己那一格要画提示符）
    expect(g.windowSlots[3]!.x).toBe(inner.x);
    expect(g.windowSlots[3]!.width).toBe(inner.width);
  });

  it("⚠️ 每个 `input` 槽各有**一对**整行/文字格，且文字那一格恒让开两列", () => {
    for (const columns of [24, 59, 100, 200]) {
      // ⚠️ **三个 `input` 槽**（表单那一档就是五格）：单数投影答不出「第 2 个字段点哪落插入符」，
      // 而这一档问的正是「每一格都对齐自己的整行」
      const g = geometry(
        spec({ columns, window: [{ kind: "input" }, { kind: "row" }, { kind: "input" }] }),
      );
      expect(g.windowInputs).toHaveLength(3);
      expect(g.windowInputs[0]).toBe(g.windowSlots[0]);
      expect(g.windowInputs[1]).toBeNull();
      expect(g.windowInputs[2]).toBe(g.windowSlots[2]);
      for (const at of [0, 2]) {
        const whole = g.windowInputs[at]!;
        const text = g.windowInputTexts[at]!;
        expect(text).not.toBeNull();
        expect(text.x).toBe(whole.x + WINDOW_INPUT_PROMPT_COLUMNS);
        expect(text.y).toBe(whole.y);
        expect(text.height).toBe(whole.height);
        expect(text.width).toBe(whole.width - WINDOW_INPUT_PROMPT_COLUMNS);
      }
    }
  });

  it("⚠️ 没有 `input` 槽时那两个投影**整份都是** null（不是 0 宽的矩形）", () => {
    const g = open({ window: [...rowSlots(2), { kind: "note" }] });
    expect(g.windowInputs).toEqual([null, null, null]);
    expect(g.windowInputTexts).toEqual([null, null, null]);
    // ⚠️ 反向自检：给一个 `input` 槽时它**不是** null（否则上面那两条是「什么都没渲染」的恒绿）
    expect(geometry(spec({ window: [{ kind: "input" }] })).windowInputs[0]).not.toBeNull();
  });

  it("⚠️ 那两个投影**与 `windowSlots` 同序同长**（下标 i 就是第 i 个槽位）", () => {
    const window: WindowSlot[] = [
      { kind: "input" },
      { kind: "note" },
      { kind: "select" },
      { kind: "input" },
      { kind: "check" },
      { kind: "row" },
    ];
    const g = geometry(spec({ window }));
    expect(g.windowInputs).toHaveLength(window.length);
    expect(g.windowInputTexts).toHaveLength(window.length);
    expect(g.windowInputs.map((one) => one !== null)).toEqual([true, false, false, true, false, false]);
    expect(g.windowInputs[0]).toBe(g.windowSlots[0]);
    expect(g.windowInputs[3]).toBe(g.windowSlots[3]);
  });

  it("⚠️ `check` / `select` 各自成一个投影，且与 `row` 那一档**不混**（三种可选面的命中测试各读自己那份）", () => {
    const window: WindowSlot[] = [
      { kind: "row" },
      { kind: "check" },
      { kind: "group" },
      { kind: "select" },
      { kind: "check" },
    ];
    const g = geometry(spec({ window }));
    expect(g.windowRows).toEqual([g.windowSlots[0]]);
    expect(g.windowChecks).toEqual([g.windowSlots[1], g.windowSlots[4]]);
    expect(g.windowGroups).toEqual([g.windowSlots[2]]);
    expect(g.windowSelects).toEqual([g.windowSlots[3]]);
    // ⚠️ **反向自检**（带正向对照）：四个投影的**并**恰是那五个槽位，各一个都不多不少 ——
    // 一个「把 check 也塞进 windowRows」的实现会在上面第一条就红，而这一条是它的另一半
    expect(
      [...g.windowRows, ...g.windowChecks, ...g.windowGroups, ...g.windowSelects].sort(
        (a, b) => a.y - b.y,
      ),
    ).toEqual([
      g.windowSlots[0],
      g.windowSlots[1],
      g.windowSlots[2],
      g.windowSlots[3],
      g.windowSlots[4],
    ]);
  });

  it("⚠️ 四档缩进：可选行与勾选行让开**记号**、标题与说明让开缩进、文本框与下拉**满宽**", () => {
    const g = geometry(
      spec({
        window: [
          { kind: "row" },
          { kind: "check" },
          { kind: "group" },
          { kind: "note" },
          { kind: "select" },
          { kind: "input" },
        ],
      }),
    );
    const inner = g.windowContent!;
    // ⚠️ 字面量而非常量（`MAIN_TEXT_X` 有别的判据钉着它 = 2）
    expect([MAIN_TEXT_X, WINDOW_INPUT_PROMPT_COLUMNS]).toEqual([2, 2]);
    // 可选行与勾选行：缩进 2 **加**记号 2 ⇒ 左边让开 4、宽度少掉同样那 4
    expect(g.windowSlots[0]!.x).toBe(inner.x + 4);
    expect(g.windowSlots[0]!.width).toBe(inner.width - 4);
    expect(g.windowSlots[1]!.x).toBe(inner.x + 4);
    expect(g.windowSlots[1]!.width).toBe(inner.width - 4);
    // 标题与说明：让开缩进而**没有**记号
    expect(g.windowSlots[2]!.x).toBe(inner.x + 2);
    expect(g.windowSlots[2]!.width).toBe(inner.width - 2);
    expect(g.windowSlots[3]!.x).toBe(inner.x + 2);
    expect(g.windowSlots[3]!.width).toBe(inner.width - 2);
    // 文本框与下拉：满宽（表单里五个字段的左缘必须一样，而那一格要画提示符）
    expect(g.windowSlots[4]!.x).toBe(inner.x);
    expect(g.windowSlots[4]!.width).toBe(inner.width);
    expect(g.windowSlots[5]!.x).toBe(inner.x);
    expect(g.windowSlots[5]!.width).toBe(inner.width);
  });

  // ⚠️ 边界那一组：屏高 × 槽位组合。期望值**现算**（容量取自那次 `geometry` 自己给的内容区高度），
  // 故「改容量算式」与「改这份表」不会同时发生。
  describe("⚠️ 分配边界：容量由屏高决定，装不下的槽是 `null` 而**长度不变**", () => {
    /** 这一台屏上装得下几个槽（内容区高度扣掉分隔那一行；⚠️ 得先**开着**窗口，否则没有内容区可量） */
    const capacityOf = (rows: number): number =>
      geometry(spec({ rows, window: rowSlots(1) })).windowContent!.height - 1;

    it("全部装得下：零个 `null`，而 `windowRows` 恒等于 `row` 槽数", () => {
      const rows = 30;
      const capacity = capacityOf(rows);
      expect(capacity).toBe(11);
      const g = geometry(spec({ rows, window: rowSlots(5) }));
      expect(g.windowSlots.filter((one) => one === null)).toHaveLength(0);
      expect(g.windowRows).toHaveLength(5);
      expect(g.windowGroups).toHaveLength(0);
      expect(g.windowChecks).toEqual([]);
      expect(g.windowSelects).toEqual([]);
      expect(g.windowInputs).toEqual([null, null, null, null, null]);
    });

    it("恰好装满：零个 `null`，最后一行压在内容区**最后那一行**上", () => {
      const rows = 30;
      const capacity = capacityOf(rows);
      const g = geometry(spec({ rows, window: rowSlots(capacity) }));
      expect(g.windowSlots.filter((one) => one === null)).toHaveLength(0);
      expect(g.windowRows).toHaveLength(capacity);
      expect(g.windowRows[capacity - 1]!.y).toBe(g.windowContent!.y + g.windowContent!.height - 1);
    });

    it("差一行：末尾恰好一个 `null`，而 `windowRows` 比槽数少一（呈现层按 `null` 判画不画）", () => {
      const rows = 30;
      const capacity = capacityOf(rows);
      const g = geometry(spec({ rows, window: rowSlots(capacity + 1) }));
      expect(g.windowSlots).toHaveLength(capacity + 1);
      expect(g.windowSlots.filter((one) => one === null)).toHaveLength(1);
      expect(g.windowSlots[capacity]).toBeNull();
      expect(g.windowRows).toHaveLength(capacity);
    });

    it("装不下任何 `row`（标题那一行还装得下）：`windowRows` 空、`windowGroups` 有一个", () => {
      const rows = 10;
      expect(capacityOf(rows)).toBe(1);
      const g = geometry(spec({ rows, window: [{ kind: "group" }, ...rowSlots(2)] }));
      expect(g.windowSlots).toHaveLength(3);
      expect(g.windowSlots.filter((one) => one === null)).toHaveLength(2);
      expect(g.windowRows).toHaveLength(0);
      expect(g.windowGroups).toHaveLength(1);
      expect(g.windowInputs).toEqual([null, null, null]);
    });

    it("容量为 0（刚好等于最小行数那一档）：**每一槽**都是 `null`，卡片照旧画", () => {
      const g = geometry(spec({ rows: 8, window: [...rowSlots(2), { kind: "input" }] }));
      expect(g.windowBox!.height).toBe(WINDOW_MIN_ROWS);
      expect(g.windowSlots).toHaveLength(3);
      expect(g.windowSlots).toEqual([null, null, null]);
      expect(g.windowRows).toHaveLength(0);
      expect(g.windowGroups).toHaveLength(0);
      // ⚠️ 输入框那两个投影也读「装不装得下」而不是「入参里有没有」
      expect(g.windowInputs).toEqual([null, null, null]);
      expect(g.windowInputTexts).toEqual([null, null, null]);
    });

    it("有 `input` 而它没装下：那两个投影在**那一个下标**上是 null（入参里有那一槽也不作数）", () => {
      const g = geometry(spec({ rows: 10, window: [{ kind: "row" }, { kind: "input" }] }));
      expect(g.windowSlots).toHaveLength(2);
      expect(g.windowSlots[1]).toBeNull();
      expect(g.windowRows).toHaveLength(1);
      expect(g.windowInputs).toEqual([null, null]);
      expect(g.windowInputTexts).toEqual([null, null]);
      // ⚠️ 而**只挪一格**它就装得下（判据是容量而不是「有没有 `input` 槽」）
      const fits = geometry(spec({ rows: 10, window: [{ kind: "input" }] }));
      expect(fits.windowInputs[0]).not.toBeNull();
      expect(fits.windowInputTexts[0]!.x).toBe(fits.windowInputs[0]!.x + WINDOW_INPUT_PROMPT_COLUMNS);
    });

    it("⚠️ `check` / `select` 装不下时也不进那两个投影（**长度不变，值是 `null`**）", () => {
      // 判据形状带**正向对照**：同一台上屏放得下 `check` / `select` 时两个投影**各有一个非 null**
      const fits = geometry(
        spec({ rows: 30, window: [{ kind: "check" }, { kind: "select" }] }),
      );
      expect(fits.windowChecks).toHaveLength(1);
      expect(fits.windowSelects).toHaveLength(1);
      expect(fits.windowInputs).toEqual([null, null]);
      const capped = geometry(spec({ rows: 10, window: [{ kind: "row" }, { kind: "check" }] }));
      expect(capped.windowSlots[1]).toBeNull();
      expect(capped.windowChecks).toEqual([]);
      expect(capped.windowSelects).toEqual([]);
      expect(capped.windowInputs).toEqual([null, null]);
      expect(capped.windowInputTexts).toEqual([null, null]);
    });
  });

  it("装不下时按屏高截断（**不是**整个不画：没有窗口等于那条命令什么都没发生）", () => {
    const g = open({ columns: 100, rows: 9, window: rowSlots(9) });
    expect(g.windowBox).not.toBeNull();
    expect(g.windowSlots).toHaveLength(9);
    expect(g.windowRows.length).toBeLessThan(9);
  });

  it("屏太矮时**不画窗口**（一个里面放不下标题与分隔的东西是纯噪音）", () => {
    for (const rows of [1, 2, 3, 4, 5, 6]) {
      expect(open({ columns: 100, rows, window: rowSlots(2) }).windowBox).toBeNull();
    }
    // ⚠️ 而**刚好够**的那一档画得下（判据是 `height ≥ WINDOW_MIN_ROWS`，不是「屏高 ≥ 某常数」）
    expect(open({ columns: 100, rows: 8, window: rowSlots(2) }).windowBox!.height).toBe(WINDOW_MIN_ROWS);
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
      expect(open({ columns: 100, rows, window: rowSlots(2) }).windowBox!.height).toBe(
        Math.round(rows * WINDOW_HEIGHT_RATIO),
      );
    }
    expect(open({ columns: 100, rows: 50, window: rowSlots(46) }).windowBox!.height).toBe(25);
    expect(open({ columns: 100, rows: 50, window: rowSlots(46) }).windowRows.length).toBeLessThan(46);
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

  it("⚠️ 关掉提示那一枚时 `esc` 的 9 列常数**恒**是 9（字面量钉住，不拿常量当期望值）", () => {
    const off = geometry(spec({ window: rowSlots(1), windowCloseHint: false }));
    expect(off.windowClose).toBeNull();
    // 判据：标题的右缘**就是**内区右缘减去缩进（真的没有为提示留出空列）
    expect(off.windowTitle!.x + off.windowTitle!.width).toBe(
      off.windowHeader!.x + off.windowHeader!.width,
    );
    expect(WINDOW_CLOSE_COLUMNS).toBe(9);
  });
});
