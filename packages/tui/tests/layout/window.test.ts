/**
 * 模态窗口：一张**无框**卡片浮在**极暗遮罩**上，标题与右上角那一枚 `esc` 同一行，
 * 而卡片那一块之外**整屏**都被压暗。
 *
 * @description
 * ⚠️ 这一组守的是「遮罩」，而遮罩的历史教训是：**它可以在屏上看着没毛病而其实漏了两块** ——
 * 侧边栏那一列**自己带底色**（Ink 后画 ⇒ 它盖在整屏那层遮罩上），而输入框**上下框那两行**里 Ink
 * 只读节点自己的 `borderBackgroundColor`（不继承祖先底色 ⇒ 边框一画就把那两行重写成「没有底色」）。
 * 两条都不会让任何一条 `includes` 断言变红，故判据是**逐格**比两帧的底色。
 *
 * ⚠️ **Ink 没有半透明**：遮罩是「重新铺一层不透明的底色」，而**任何自己带底色或带边框的盒子都会盖在
 * 它上面或把它挖空** —— 症状是「整屏压暗了而侧边栏没压暗」「屏最底下横着两条亮线」。
 *
 * 这一条的完整说明与变异实测表见本目录 `AGENTS.md`。
 *
 * @module tests/layout
 */

import { describe, expect, it, vi } from "vitest";

// ⚠️ 必须在 ink（因而 chalk）被 import 之前设好，否则每一档的着色判据恒为「没有序列」—— 见 `AGENTS.md`
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { widthOf } from "@/lib/format.js";
import { geometry } from "@/lib/geometry.js";
import { MARK_SELECTED, type ModalView } from "@/components/index.js";
import { themeOf, toneColor, type Theme } from "@/theme/index.js";
import type { LayoutProps } from "@/app.js";
import { geoInput, props, renderFrame, renderRaw, renderScreen, stripAnsi } from "./_harness.js";
import {
  bgAtColumn,
  bgRgbAt,
  bgSgrOf,
  columnOfIndex,
  depthOf,
  fgSgrOf,
  indexOfText,
  paintedColumns,
  rawIndexOfColumn,
  restColumns,
  rowRawOf,
  screenRowOf,
  sgrColorAt,
} from "./_probe.js";

describe("不变量 ⑥：模态是一张**无框**卡片浮在**极暗遮罩**上，标题与 `esc` 提示同一行", () => {
  const window = {
    kind: "targets" as const,
    title: "控制面（2）",
    rows: [
      { id: "a", name: "live-ok", detail: "http://10.0.0.9:18080 · 超时 5000ms", state: "connected" as const, current: true, pending: false },
      { id: "b", name: "bad-token", detail: "http://10.0.0.1:18081 · 超时 5000ms", state: "unauthorized" as const, current: false, pending: false },
    ],
    at: 0,
    note: null,
    closeHint: true,
  };
  /** 空台账那一档（`note` 非空 ⇒ 内容区第一行是它） */
  const empty = { ...window, title: "控制面（0）", rows: [], note: "台账里还没有控制面 · 用 /target add 加一个" };

  it("⚠️ 卡片**没有框**：两个上角是空白，而标题落在**标题那一行**", async () => {
    // ⚠️ **必须 `color: true`**：无色档里 Ink 把行尾空白 `trimEnd` 掉了，卡片右缘那一列**压根没有
    // 格子**，探针会给 -1 —— 而「那一格是空格」对 -1 恒成立（这条判据就是这么变成恒绿的）。
    const p = props({ color: true, view: window });
    const raw = await renderRaw(p);
    const lines = raw.map((line) => stripAnsi(line));
    const g = geometry(geoInput(p));
    const box = g.windowBox!;
    // ⚠️ 标题在**内区那一行**（没有上边框，而内区离卡片上缘还隔着 1 列 padding）
    expect(screenRowOf(lines, "控制面（2）")).toBe(g.windowHeader!.y);
    expect(g.windowHeader!.y).toBe(box.y + 1);
    // ⚠️ **两个上角那一格是空格**：一圈框线会把一张卡片画成「另一个终端窗口」，而满屏接管之后
    // 屏上并没有别的窗口。⚠️ 判据落在**那两格**而不是「整帧没有 ╭」—— 输入框自己是圆角框，
    // 「整帧没有框线字形」那条对输入框恒红，而它压根不回答「卡片有没有框」。
    for (const column of [box.x, box.x + box.width - 1]) {
      const at = rawIndexOfColumn(raw[box.y] ?? "", column);
      expect(at).toBeGreaterThanOrEqual(0);
      expect((raw[box.y] ?? "")[at]).toBe(" ");
    }
  });

  it("⚠️ **padding 1** 在画面上：标题离卡片左缘 4 列（1 + 3），`esc` 提示离右缘也是 4 列", async () => {
    const p = props({ color: true, view: window });
    const raw = await renderRaw(p);
    const box = geometry(geoInput(p)).windowBox!;
    const row = raw[box.y + 1] ?? "";
    const at = indexOfText(row, "控制面（2）");
    const action = indexOfText(row, "关窗");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(action).toBeGreaterThanOrEqual(0);
    // ⚠️ 判据是**画出来的显示列**：几何对了而呈现层少缩一格时，只有这一条会红
    // ⚠️ 期望值写**字面量**而不是那几个常量：拿常量当期望值的话，改常量与改实现同时发生 ⇒ 恒绿
    expect(columnOfIndex(row, at)).toBe(box.x + 1 + 3);
    // 而那一枚的**右端**离卡片右缘 1 + 3 列（量的是动作文案的右端：它与那一枚同宽，且没有首列空隙）
    expect(columnOfIndex(row, action) + widthOf("关窗")).toBe(box.x + box.width - 1 - 3);
  });

  it("⚠️ 标题与内容之间有一道**可见的分隔**（`MARK_SELECTED` 铺满内区第一行）", async () => {
    const p = props({ color: true, view: window });
    const g = geometry(geoInput(p));
    const screen = await renderScreen(p);
    // ⚠️ **横向**：从**内区左缘**起是内区那么多个 `MARK_SELECTED`，紧跟着是右侧那一列 padding
    const row = stripAnsi(restColumns(screen[g.windowContent!.y] ?? "", g.windowContent!.x));
    expect(row.slice(0, g.windowContent!.width)).toBe(MARK_SELECTED.repeat(g.windowContent!.width));
    expect(row.slice(g.windowContent!.width, g.windowContent!.width + 1)).toBe(" ");
    // ⚠️ **纵向**：它**夹在标题与第一行内容之间** —— 而「第一行内容」的判据必须**从卡片左缘**起切
// （侧边栏那一列上也有一个叫 `live-ok` 的控制面名，而从主区左缘切会把「live-ok」切成「ve-ok」）
    const inCard = (needle: string): number =>
      screen.findIndex((line) => restColumns(stripAnsi(line), g.windowBox!.x).includes(needle));
    expect(g.windowContent!.y).toBe(g.windowHeader!.y + 1);
    expect(inCard("live-ok")).toBe(g.windowRows[0]!.y);
    expect(g.windowRows[0]!.y).toBe(g.windowContent!.y + 1);
    // 反向自检：同一批字形在**内容行**上只占左缘一列 —— 「铺满整行」才是分隔的形状通道
    // （⚠️ 从 `windowSlots[0].x` 起切：几何层已经为**记号**让开两列，而那一行前面还有 1 列 padding）
    const first = stripAnsi(screen[g.windowRows[0]!.y] ?? "").slice(g.windowSlots[0]!.x);
    expect(first.startsWith(MARK_SELECTED)).toBe(true);
    expect(first.slice(1).startsWith(MARK_SELECTED)).toBe(false);
    // ⚠️ 而**记号那一列的位置是几何给的**：现算而不是拿 `MAIN_TEXT_X` 当期望值
    expect(g.windowSlots[0]!.x - g.windowContent!.x).toBe(4);
  });

  it("⚠️ 空台账那一句落在**说明那一槽**，而**不再有**底部说明行", async () => {
    const p = props({ view: empty });
    const g = geometry(geoInput(p));
    const screen = await renderScreen(p);
    // ⚠️ 说明是**第 0 槽**（它排在可选行上面，而槽位从分隔下面起铺）
    expect(g.windowSlots[0]).not.toBeNull();
    expect(screenRowOf(screen, "台账里还没有控制面")).toBe(g.windowSlots[0]!.y);
    expect(g.windowRows).toHaveLength(0);
    // ⚠️ 旧版那一行说明是**贴卡片底边**的键位说明；删掉之后卡片里那两句一个字都不许再出现
    expect(screen.join("\n")).not.toContain("Esc 关窗");
    expect(screen.join("\n")).not.toContain("↑↓ 选");
  });

  it("⚠️ 标题与右上角那一枚 esc **同一行**，且 esc 在卡片右端之内", async () => {
    const p = props({ view: window });
    const raw = await renderRaw(p);
    const g = geometry(geoInput(p));
    const box = g.windowBox!;
    const row = raw[g.windowHeader!.y] ?? "";
    const at = indexOfText(row, "esc");
    expect(at).toBeGreaterThanOrEqual(0);
    const column = columnOfIndex(row, at);
    expect(column).toBeGreaterThan(box.x);
    expect(column).toBeLessThan(box.x + box.width);
    // 而标题在**同一行**（无框 ⇒ 「右上角」只能是标题行的右端）
    expect(row.indexOf("控制面（2）")).toBeGreaterThanOrEqual(0);
  });

  it("窗口里逐行给出链接与状态字形，而「当前会话连的是它」另有记号", async () => {
    const lines = await renderFrame(props({ view: window }));
    const joined = lines.join("\n");
    expect(joined).toContain("live-ok");
    expect(joined).toContain("http://10.0.0.9:18080");
    expect(joined).toContain("●");
    expect(joined).toContain("←当前");
  });

  it("⚠️ 卡片里的字**不**被遮罩压暗（「窗口叫什么」是那一块唯一必须读得出来的东西）", async () => {
    const p = props({ color: true, view: window });
    const on = await renderRaw(p);
    const card = themeOf({ color: true, scrimmed: false });
    const behind = themeOf({ color: true, scrimmed: true });
    const titleRow = on[rowRawOf(on, "控制面（2）")] ?? "";
    const at = indexOfText(titleRow, "控制面（2）");
    expect(at).toBeGreaterThanOrEqual(0);
    // ⚠️ **先自检**：探针给 -1 时 `sgrColorAt` 恒给 `null`，而「null ≠ 那个色」恒成立。
    expect(sgrColorAt(titleRow, at, "fg")).toBe(fgSgrOf(toneColor("accent", card)!));
    // 遮罩态的那一份**必须**与它不同 —— 否则这条断言在「两份主题其实是一份」时恒绿
    expect(toneColor("accent", behind)).not.toBe(toneColor("accent", card));
    // 而**背后**那一层的前景色确实就是遮罩态那一档（两份主题真的被分别用上了）
    const behindRow = on[0] ?? "";
    const behindAt = indexOfText(behindRow, "已改");
    expect(behindAt).toBeGreaterThanOrEqual(0);
    expect(sgrColorAt(behindRow, behindAt, "fg")).toBe(fgSgrOf(toneColor("muted", behind)!));
  });

  it("⚠️ 模态开着时输入框**不画插入符**（按键已被窗口吃掉，屏上不许还留一个焦点块）", async () => {
    const p = props({ color: true, input: "/managers", cursor: 9 });
    const off = await renderRaw(p);
    const on = await renderRaw(props({ ...p, view: window }));
    const caretRow = geometry(geoInput(p)).inputTextRows[0]!.y;
    // ⚠️ 找的那一档**必须按那一帧自己的主题取**：遮罩态的 `selected` 是 `VEIL_TEXT`，
    // 而拿不带遮罩的那一档去搜遮罩态那一帧，**恒搜不到** —— 那条判据就这么变成恒绿的。
    const block = (line: string, theme: Theme): number => {
      const wanted = bgSgrOf(toneColor("selected", theme)!);
      let found = -1;
      for (let x = 0; x < p.columns; x += 1) {
        if (bgAtColumn(line, x) === wanted) found = x;
      }
      return found;
    };
    const plain = themeOf({ color: true, scrimmed: false });
    const behind = themeOf({ color: true, scrimmed: true });
    // ⚠️ **反向自检**：不带遮罩那一帧**必须**找得到那个块（找不到的话下面那条判据恒真，
    // 而症状与「实现没画插入符」一模一样）。
    expect(block(off[caretRow] ?? "", plain)).toBeGreaterThanOrEqual(0);
    // 遮罩开着时那一行**一格都不许**是那个色 —— 反底色是「焦点在这儿」的视觉答案，
    // 而按键已经全被窗口吃掉了（`use-keyboard.ts`），两者不一致的话操作者会先敲字才发现没进去。
    expect(block(on[caretRow] ?? "", behind)).toBe(-1);
  });

  it("⚠️ 卡片底边那一行是**空**的（键位说明不再钉在底边 ⇒ 少一个空盒子也看不出来）", async () => {
    // ⚠️ 旧版那一行说明（`Esc 关窗`）是 `flexGrow` 那个空盒子顶到卡片底边的，而删掉它之后
    // 「卡片里剩下的空间归空盒子」这条不变量**改由这一行回答**：底边那一行必须**没有字**。
    const p = props({ view: window });
    const box = geometry(geoInput(p)).windowBox!;
    const lines = await renderScreen(p);
    const bottom = stripAnsi(restColumns(lines[box.y + box.height - 1] ?? "", box.x));
    expect(bottom.trim()).toBe("");
  });

  // ⚠️ 这条是本档**最贵**的一条断言，而它守着的是一个「屏上看着没毛病、其实遮罩漏了两块」的实现：
  // ① 侧边栏那一列**自己带底色**（`surface`），Ink 后画 ⇒ 它盖在整屏那层遮罩上，于是整屏压暗了它没压暗；
  // ② 输入框**上下框那两行**里 Ink 只读节点自己的 `borderBackgroundColor`（不继承祖先底色），
  //    边框一画就把那两行重写成「没有底色」，于是遮罩在屏最底下被挖掉两条横缝。
  // 两条都不会让任何一条 `includes` 断言变红 —— 故判据是**逐格**比两帧的底色。
  /**
   * `ModalView` 的**七档各一个**（⚠️ 一个都不能少：少一档时那一档整屏不暗，而症状与测过的几档一模一样）
   * @description 「期望表覆盖全部判别值」由 `tests/contract/contract.test.ts` 逐字钉住（它与 `@/store`
   * 的 `WindowState.kind` **现取**比对）⇒ 这里少写一档，那一档在下面那一条里就是**零鉴别力**。
   */
  function everyModalView(): readonly ModalView[] {
    const rows = [{ id: "a", name: "live", detail: "d", state: null, current: false, pending: false }];
    const list = (kind: "targets" | "users" | "providers"): ModalView => ({
      kind,
      title: kind,
      note: "一行说明",
      rows,
      at: 0,
      closeHint: true,
    });
    return [
      list("targets"),
      list("users"),
      list("providers"),
      {
        kind: "sessions",
        title: "sessions",
        note: null,
        rows: [
          { id: "h1", name: "会话 3", header: null, pinned: true, manager: null, pending: false, label: "会话 3" },
        ],
        at: 0,
        closeHint: true,
      },
      {
        kind: "provider-form",
        title: "provider-form",
        note: "地址不合法",
        fields: [
          { kind: "input", label: "地址", value: "https://x", focused: true, cursor: 8 },
          { kind: "select", label: "API 格式", value: "openai", focused: false, cursor: 6, options: ["openai"] },
        ],
        closeHint: true,
      },
      {
        kind: "provider-models",
        title: "provider-models",
        note: "拉取中…",
        at: 0,
        filter: { kind: "input", label: "过滤", value: "cl", focused: true, cursor: 2 },
        rows: [{ id: "p1/a", label: "claude-x", checked: true, pinned: false, pending: false }],
        closeHint: true,
      },
      {
        kind: "models",
        title: "models",
        note: null,
        rows: [{ id: "p1/a", label: "claude-x", header: "openrouter", pinned: true }],
        at: 0,
        closeHint: true,
      },
    ];
  }

  /**
   * 逐格比两帧的底色：卡片那一块之外，每一格都必须与「没开弹窗」那一帧不同
   * @description 抽成函数是因为**七档都要跑这一遍**：遮罩那一层是 `@/app.tsx` 给的（与内容无关），
   * 而「新弹窗忘了压暗整屏」的症状与旧的一样看着没毛病 —— 只测一档的话其余六档是零鉴别力。
   */
  async function scrimCoversScreen(view: unknown): Promise<{ checked: number; missed: string[] }> {
    const p = props({ color: true, view } as Partial<LayoutProps>);
    const off = await renderRaw(props({ color: true }));
    const on = await renderRaw(p);
    const box = geometry(geoInput(p)).windowBox!;
    // ⚠️ **探针先自检**：窗口矩形给 `null` 时下面一行都不跑，而那正是「什么都没测」
    expect(box).not.toBeNull();
    let checked = 0;
    const missed: string[] = [];
    const caret = bgSgrOf(toneColor("selected", themeOf({ color: true, scrimmed: false }))!);
    for (let y = 0; y < p.rows; y += 1) {
      const before = off[y] ?? "";
      const after = on[y] ?? "";
      // ⚠️ 只量「**至少一帧里画过字**」的那些列：Ink 把行尾空白 `trimEnd` 掉了，
      // 那里压根没有一格，量它等于量一个不存在的东西（症状是恒红的假失败）。
      const painted = Math.max(paintedColumns(before), paintedColumns(after));
      for (let x = 0; x < painted; x += 1) {
        if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) continue;
        checked += 1;
        const was = bgAtColumn(before, x);
        const now = bgAtColumn(after, x);
        // ⚠️ **插入符那一格是唯一的例外**：它用反底色（`selected`）当「颜色之外的形状通道」，
        // 而反底色是**自己给的**底色 ⇒ 遮罩压不到它，也**不该**压到它（压暗了它就不再是最亮的一格，
        // 「光标在哪儿」这一条信息就没了）。故按「那一格本来就是反底色」放行，而不是放宽整条判据。
        if (was === caret || now === caret) continue;
        if (was === now || now === null) missed.push(`(${String(x)},${String(y)}) ${String(was)} → ${String(now)}`);
      }
    }
    return { checked, missed };
  }

  it("⚠️ 背后**整屏铺上遮罩**：卡片那一块之外，每一格的底色都与关窗时不同", async () => {
    const { checked, missed } = await scrimCoversScreen(window);
    // ⚠️ 计数也是判据的一部分：屏是 100×28 = 2800 格，而卡片占 70×14 = 980 ⇒ 至多 1820 格在它之外；
    // 「漏了整屏」那种实现会掉到几百，于是这条仍是**够不着**的。
    expect(checked).toBeGreaterThan(1500);
    expect(missed.slice(0, 8)).toEqual([]);
  });

  it("⚠️ **七档每一档**都压暗整屏，而每一档的标题都真的画出来了", async () => {
    // ⚠️ 判据是「**七档都跑**」而不是「多测两档」：漏掉一档时那一档整屏不暗，而症状与测过的
    // 几档**一模一样**（屏上看着有张卡片）。故期望表覆盖了 `ModalView` 的全部判别值。
    for (const view of everyModalView()) {
      const { checked, missed } = await scrimCoversScreen(view);
      // ⚠️ **反向自检**：这一档的标题**真的画在标题那一行上**（否则上面那一趟是「什么都没画」上的恒绿）
      const g = geometry(geoInput(props({ color: true, view } as Partial<LayoutProps>)));
      const screen = await renderScreen(props({ color: true, view } as Partial<LayoutProps>));
      expect(screenRowOf(screen, view.title), `${view.kind} 的标题没画`).toBe(g.windowHeader!.y);
      expect(checked, `${view.kind} 量的格子数`).toBeGreaterThan(1500);
      expect(missed.slice(0, 8), `${view.kind} 漏了格子`).toEqual([]);
    }
  });

  it("窗口浮在上面：卡片比遮罩**亮**（亮卡片浮在极暗遮罩上，明暗差就是「压在上面」）", async () => {
    const p = props({ color: true, view: window });
    const on = await renderRaw(p);
    const behindRow = on[0] ?? "";
    const behindAt = indexOfText(behindRow, "已改");
    const titleRow = on[rowRawOf(on, "控制面（2）")] ?? "";
    const insideAt = indexOfText(titleRow, "控制面（2）");
    // ⚠️ **两个下标都先自检**：探针给 -1 时 `bgRgbAt` 恒给 `null`，而 `null` 与任何数比较都是假 ——
    // 那是一条**恒绿**的判据（实测踩过一次）。
    expect(behindAt).toBeGreaterThanOrEqual(0);
    expect(insideAt).toBeGreaterThanOrEqual(0);
    const behind = bgRgbAt(behindRow, columnOfIndex(behindRow, behindAt));
    const inside = bgRgbAt(titleRow, columnOfIndex(titleRow, insideAt));
    expect(behind).not.toBeNull();
    expect(inside).not.toBeNull();
    // ⚠️ 比的是**深浅**不是「两个不相等」：遮罩最深而卡片次之，方向反了的话屏上读到的是
    // 「背后浮出一块亮斑」，而「不相等」那条判据对它**恒绿**。
    expect(depthOf(inside!)).toBeGreaterThan(depthOf(behind!));
  });

  it("⚠️ 卡片**整块**同一档底色（标题行、分隔行、中间的空行）", async () => {
    const p = props({ color: true, view: window });
    const on = await renderRaw(p);
    const box = geometry(geoInput(p)).windowBox!;
    expect(box).not.toBeNull();
    const panel = bgSgrOf(toneColor("panel", themeOf({ color: true, scrimmed: true }))!);
    // ⚠️ **逐行**量：卡片高度与内容无关（屏高一半），所以中间那段空行也在卡片里 ——
    // 只量标题与内容两行的话，中间那一段掉色（`flexGrow` 那个空盒子被算到卡片之外）测不出来。
    for (let y = box.y; y < box.y + box.height; y += 1) {
      expect(bgAtColumn(on[y] ?? "", box.x + 1)).toBe(panel);
    }
  });

  // ⚠️ 这一组替掉了旧版那条「`esc` 指着自己换一档」：悬停态已被删掉，而**能观测到**的那一半是
  // 「那一枚没有自己的一层底色」—— ⚠️ 因此这里**不能**用底色把「它画了」与「卡片画的」分开
  //（两处同色，而旧版正因为 `panelHot` 不同色才验得到）；「指针移上去不重绘」那一半归 `tests/input/`。
  it("⚠️ 那一枚 `esc` 提示**没有自己的一层底色**：每一格都与卡片同色", async () => {
    const p = props({ color: true, view: window });
    const on = await renderRaw(p);
    const g = geometry(geoInput(p));
    const chip = g.windowClose!;
    const row = on[chip.y] ?? "";
    const panel = bgSgrOf(toneColor("panel", themeOf({ color: true, scrimmed: true }))!);
    // ⚠️ **逐列**量那一枚（含首尾那两列空隙）：它恒与卡片同色，而少给它一格不会在屏上留痕 ——
    // 所以这一条只钉住「同色」，**不**假装钉住了「这一枚自己画了那一格」。
    for (let x = chip.x; x < chip.x + chip.width; x += 1) {
      expect(bgAtColumn(row, x)).toBe(panel);
    }
  });

  it("⚠️ `esc` 提示的**按键字形与动作文案不同色**（同色 = 「按哪个」与「会发生什么」读起来一样）", async () => {
    const p = props({ color: true, view: window });
    const on = await renderRaw(p);
    const row = on[geometry(geoInput(p)).windowClose!.y] ?? "";
    const keyAt = indexOfText(row, "esc");
    const actionAt = indexOfText(row, "关窗");
    expect(keyAt).toBeGreaterThanOrEqual(0);
    expect(actionAt).toBeGreaterThanOrEqual(0);
    const key = sgrColorAt(row, keyAt, "fg");
    const action = sgrColorAt(row, actionAt, "fg");
    // ⚠️ **两个探针都先自检**：`null` 与任何值比较都为真差别，而「两者不同」对两个 `null` 恒假
    expect(key).not.toBeNull();
    expect(action).not.toBeNull();
    expect(key).not.toBe(action);
    // ⚠️ 而**方向**也钉死：按键是最亮那一档、动作是最暗那一档（反过来读起来像「按动作」）
    expect(key).toBe(fgSgrOf(toneColor("accent", themeOf({ color: true, scrimmed: false }))!));
    expect(action).toBe(fgSgrOf(toneColor("idle", themeOf({ color: true, scrimmed: false }))!));
  });

  it("关掉窗口之后整屏**没有**遮罩（它跟着窗口，不是一个常驻底色）", async () => {
    const off = await renderRaw(props({ color: true }));
    const plain = themeOf({ color: true, scrimmed: false });
    const scrimmed = themeOf({ color: true, scrimmed: true });
    // 主区那一格：没有底色（不是「压暗版的没有底色」）
    const at = indexOfText(off[0] ?? "", "已改");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(bgAtColumn(off[0] ?? "", columnOfIndex(off[0] ?? "", at))).toBeNull();
    // 侧边栏那一格：**没被压暗过**的那一档 —— 拿遮罩态的 `surface` 蒙混过关的实现会被这条逮到
    const sidebar = bgAtColumn(off[1] ?? "", 1);
    expect(sidebar).toBe(bgSgrOf(toneColor("surface", plain)!));
    expect(sidebar).not.toBe(bgSgrOf(toneColor("surface", scrimmed)!));
  });

  it("键位说明住在**右上角那一枚**里（`esc` 与它的动作文案），而底部**没有**说明行了", async () => {
    const lines = await renderFrame(props({ view: window }));
    const joined = lines.join("\n");
    expect(joined).toContain("esc");
    expect(joined).toContain("关窗");
    // ⚠️ 旧版那一句是「↑↓ 选 · Enter … · Esc 关窗」**贴在卡片底边**的整行；删掉之后
    // ↑↓ 与 Enter 的键位提示在卡片里**一个字都不许**残留（它们由 `/help` 与命令摘要给出）。
    expect(joined).not.toContain("Esc 关窗");
    expect(joined).not.toContain("Enter 接到当前会话");
  });
});
