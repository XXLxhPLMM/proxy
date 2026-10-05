/**
 * 历史会话弹窗：与控制面清单**同一块卡片外壳**，而内容区是**四档槽位**（说明 / 分组标题 / 可选会话 /
 * 改名框），外加**整屏遮罩**与那一枚可关可不关的 `esc 关窗`。
 *
 * @description
 * 这一档盯三件**屏上看着没毛病、其实错了**的事：
 *
 * 1. **遮罩**：Ink 没有半透明，遮罩是「重铺一层不透明底色」，而**任何自己带底色或带边框的盒子都会
 *    盖在它上面或把它挖空** —— 症状是「整屏压暗了而侧边栏没压暗」「屏最底下横着两条亮线」。两者都
 *    不让任何一条 `includes` 断言变红，故判据是**逐格**比两帧。
 * 2. **一行不许超宽**：Ink 对过宽的 `<Text>` 是**静默软换行**，一换行下面所有行都往下移、卡片跟着
 *    长高 —— 症状是「卡片里多出一行而下面那些掉出去了」。判据落在「每一槽落在它自己的那一行」上。
 * 3. **两个「已」不许同形同色**：「已激活」（`pinned`）与「已高亮」（`at`）渲染成同一个东西时，
 *    屏上分不出「它已经在侧边栏上」与「我现在正指着它」。
 *
 * ⚠️ 这一档还带一条**源码级**判据（`app.tsx` 真的读了 `history.closeHint`）：`closeHint` 今天在几何档
 * 是**零承重**的（那边直接喂 `geometry()`），而硬写 `true` 时整屏看着完全正常。理由与写法照
 * `tests/ledger/layer-boundary.test.ts` 那一族（读源文件文本 + 探测器自检 + 反向自检）。
 *
 * 这一组与其余各档共用的前提见本目录 `AGENTS.md`。
 *
 * @module tests/layout
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// ⚠️ 必须在 ink（因而 chalk）被 import 之前设好，否则每一档的着色判据恒为「没有序列」—— 见 `AGENTS.md`
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { widthOf } from "@/lib/format.js";
import { WINDOW_INPUT_PROMPT_COLUMNS, geometry } from "@/lib/geometry.js";
import { MARK_SELECTED, type SessionHistoryRow, type SessionHistoryView } from "@/components/index.js";
import { themeOf, toneColor, type Theme } from "@/theme/index.js";
import { COLUMNS, geoInput, props, renderFrame, renderRaw, renderScreen, stripAnsi } from "./_harness.js";
import {
  bgAtColumn,
  bgSgrOf,
  columnOfIndex,
  fgSgrOf,
  indexOfText,
  isBoldAt,
  paintedColumns,
  rawIndexOfColumn,
  restColumns,
  screenRowOf,
  sgrColorAt,
} from "./_probe.js";

/** 一个**可选会话**那一行（`header` 恒 `null`） */
function session(id: string, name: string, pinned: boolean): SessionHistoryRow {
  return { id, name, header: null, pinned, manager: "live-ok", at: 0, label: name };
}

/** 一个**分组标题**那一行（⚠️ 其余字段一律中性值，而 `label` 就是标题的原文） */
function group(label: string): SessionHistoryRow {
  return { id: "", name: "", header: label, pinned: false, manager: null, at: 0, label };
}

/** 缺省那一档：两个分组标题夹着三个可选会话，高亮的是**第 0 个可选会话**（不是数组下标 0） */
const base = {
  title: "历史会话",
  rows: [
    group("今天"),
    session("h1", "会话 3", true),
    session("h2", "会话 4", false),
    group("3 天前"),
    session("h3", "会话 5", false),
  ],
  at: 0,
  note: null,
  rename: null,
  closeHint: true,
} satisfies SessionHistoryView;

/** 卡片**自己**那份主题（`@/app.tsx` 给卡片的是没盖遮罩的那一份） */
const cardTheme = (): Theme => themeOf({ color: true, scrimmed: false });

/** 那一格的反底色是不是「插入符 / 高亮块」那一档（`null` = 那一格没有反底色） */
function reversedAt(line: string, column: number): boolean {
  return bgAtColumn(line, column) === bgSgrOf(toneColor("selected", cardTheme())!);
}

describe("不变量 ⑩：历史会话弹窗 = 同一块卡片 + 四档槽位 + 整屏遮罩", () => {
  it("⚠️ 卡片共用同一块外壳：无框 + `padding 1` + 标题与 `esc` **同一行**", async () => {
    const p = props({ color: true, history: base });
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    const screen = await renderScreen(p);
    const box = g.windowBox!;
    expect(screenRowOf(screen, "历史会话")).toBe(g.windowHeader!.y);
    // ⚠️ **上边那两格（padding 那一行）是卡片自己的底色而上面没有字** —— 一圈框线只会把它画成
    // 「另一个终端窗口」，而满屏接管之后屏上并没有别的窗口。⚠️ 判据落在**那两格**而不是
    // 「整帧没有 ╭」—— 输入框自己是圆角框，那条对它恒红而不回答「卡片有没有框」。
    const panel = bgSgrOf(toneColor("panel", cardTheme())!);
    for (const column of [box.x, box.x + box.width - 1]) {
      expect(bgAtColumn(raw[box.y] ?? "", column)).toBe(panel);
    }
    // ⚠️ **反向自检**：那一行**必须**一个框线字形都没有（少这一句的话「有底色」与「有框」都过得去）
    expect(raw[box.y] ?? "").not.toMatch(/[│╭╰]/u);
    // ⚠️ 而分隔那一行恒铺满**内容区**（与控制面清单那一份逐字同一条纪律）
    const divider = tailFrom(screen[g.windowContent!.y] ?? "", g.windowContent!.x);
    expect(divider.slice(0, g.windowContent!.width)).toBe(
      MARK_SELECTED.repeat(g.windowContent!.width),
    );
  });

  // ⚠️ **四档槽位各占它自己那一行**：判据是「屏行号 == 几何给的那个 `y`」，而槽位序与入参那串槽位
  // **同序同长** —— 少画一行或少读一格，后面那些行都会整体错位一格（屏上只是「少了一个分组标题」）。
  it("⚠️ 四档槽位**各占它自己的那一行**（说明 / 标题 / 可选 / 改名框）", async () => {
    const view: SessionHistoryView = {
      ...base,
      note: "台账里只有 5 个会话",
      rename: { id: "h1", text: "会话 3 改名", cursor: 3 },
    };
    const p = props({ history: view });
    const g = geometry(geoInput(p));
    const screen = await renderScreen(p);
    // ⚠️ **探针先自检**：几何没给那一格时下面几行都不跑，而那正是「什么都没测」
    expect(g.windowSlots.filter((one) => one !== null)).toHaveLength(view.rows.length + 2);
    expect(screenRowOf(screen, "台账里只有 5 个会话")).toBe(g.windowSlots[0]!.y);
    expect(screenRowOf(screen, "今天")).toBe(g.windowSlots[1]!.y);
    expect(screenRowOf(screen, "会话 3")).toBe(g.windowSlots[2]!.y);
    expect(screenRowOf(screen, "3 天前")).toBe(g.windowSlots[4]!.y);
    expect(screenRowOf(screen, "会话 5")).toBe(g.windowSlots[5]!.y);
    expect(screenRowOf(screen, "✎")).toBe(g.windowSlots[6]!.y);
    // ⚠️ 而三个投影各只含自己那一档（**同一批对象**，不是坐标相同的两份）
    expect(g.windowGroups).toEqual([g.windowSlots[1], g.windowSlots[4]]);
    expect(g.windowRows).toEqual([g.windowSlots[2], g.windowSlots[3], g.windowSlots[5]]);
    expect(g.windowInput).toBe(g.windowSlots[6]);
  });

  it("⚠️ **分组标题不吃高亮**（它是标题不是可选项，而记号与加粗是「可不可选」的两个通道）", async () => {
    const p = props({ color: true, history: base });
    const raw = await renderRaw(p);
    const g = geometry(geoInput(p));
    const card = cardTheme();
    // ⚠️ **两档色必须真的不同**（否则下面那两条是「两处取到了同一个值」上的恒绿）
    expect(toneColor("muted", card)).not.toBe(toneColor("selected", card));
    // ⚠️ 那一帧里**确实有一个被高亮的可选会话**，否则下面那两行是「零高亮帧」上的恒绿
    const rowLine = raw[g.windowRows[0]!.y] ?? "";
    const rowAt = indexOfText(rowLine, "会话 3");
    const headLine = raw[g.windowGroups[0]!.y] ?? "";
    const headAt = indexOfText(headLine, "今天");
    expect(rowAt).toBeGreaterThanOrEqual(0);
    expect(headAt).toBeGreaterThanOrEqual(0);
    expect(sgrColorAt(rowLine, rowAt, "fg")).toBe(fgSgrOf(toneColor("selected", card)!));
    expect(isBoldAt(rowLine, rowAt)).toBe(true);
    // ⚠️ 标题那一行是**另一档且不加粗**（「只是不吃高亮」不够 —— 还得读得出它是一行标题）
    expect(sgrColorAt(headLine, headAt, "fg")).toBe(fgSgrOf(toneColor("muted", card)!));
    expect(isBoldAt(headLine, headAt)).toBe(false);
    // ⚠️ 而标题那一行**一个字都没有记号**（几何层也没为它让开记号那两列：它不可选）
    expect(headLine).not.toContain(MARK_SELECTED);
    expect(g.windowGroups[0]!.x - g.windowContent!.x).toBe(2);
    expect(g.windowRows[0]!.x - g.windowContent!.x).toBe(4);
    // ⚠️ **两帧逐格不同**：反过来（标题吃高亮）时下面那两条会一起红，而这一条钉住「它们本来就不一样」
    expect(sgrColorAt(headLine, headAt, "fg")).not.toBe(sgrColorAt(rowLine, rowAt, "fg"));
  });

  it("⚠️ `pinned` 的记号与**高亮记号两两可分**（形不同、档也不同）", async () => {
    const p = props({ color: true, history: base });
    const raw = await renderRaw(p);
    const g = geometry(geoInput(p));
    const line = raw[g.windowRows[0]!.y] ?? "";
    // ⚠️ 那一行既被高亮又**已在侧边栏上**（两个标记同时在屏上，才谈得上「可分」）
    const highlightAt = indexOfText(line, MARK_SELECTED);
    const labelAt = indexOfText(line, "会话 3");
    const pinnedAt = indexOfText(line, "◉");
    expect(highlightAt).toBeGreaterThanOrEqual(0);
    expect(labelAt).toBeGreaterThan(highlightAt);
    expect(pinnedAt).toBeGreaterThan(labelAt);
    // ⚠️ **形**：右侧那一枚不是 `MARK_SELECTED`（左缘那枚才是），而它落在那一槽之内
    expect(line.slice(pinnedAt, pinnedAt + 1)).not.toBe(MARK_SELECTED);
    expect(columnOfIndex(line, pinnedAt)).toBeLessThan(
      g.windowRows[0]!.x + g.windowRows[0]!.width,
    );
    // ⚠️ **档**：两枚的前景色不同（共用一档的话「已激活」与「已高亮」在屏上读起来一样）
    const highlight = sgrColorAt(line, highlightAt, "fg");
    const pinned = sgrColorAt(line, pinnedAt, "fg");
    expect(highlight).not.toBeNull();
    expect(pinned).not.toBeNull();
    expect(pinned).not.toBe(highlight);
    // ⚠️ 反向：没 pin 的那一行**一个「◉」都没有**（常驻的话它就不再是一个状态）
    const other = raw[g.windowRows[1]!.y] ?? "";
    expect(other).not.toContain("◉");
  });

  it("⚠️ `label` 由**状态层**裁好，呈现层不自己裁（两边守的是相反的纪律，同一帧里各占一行）", async () => {
    // ⚠️ 那一行**故意违约**：`label` 比那一槽的预算长。理由是「裁与不裁」**只在违约时**才分得开 ——
    // 守约的 label 装得下，于是「裁了」与「没裁」渲染结果逐字相同（实测，见本目录 `AGENTS.md`
    // 那条「期望值来自被测对象」的同类坑）。而这一档喂长串**不是**给实现挖坑：
    // 那是**状态层**该修的排版（它有那一槽的预算），呈现层只负责不冒充第二份排版。
    const long = "x".repeat(200);
    const p = props({
      history: { ...base, note: "说明".repeat(40), rows: [group("今天"), session("h1", long, true)] },
    });
    const g = geometry(geoInput(p));
    const screen = await renderScreen(p);
    // ⚠️ 那一行末尾**没有省略号**：裁过的实现会在那里留一个 `…`，而守约的那个不会
    expect(tailFrom(screen[g.windowRows[0]!.y] ?? "", g.windowRows[0]!.x).includes("…")).toBe(false);
    // ⚠️ **反向自检（同一帧、同一探测器）**：那句说明**没有**「状态层已裁好」那份承诺，
    // 而它超预算 ⇒ **必须**看见 `…`。看得见才说明上面那条不是「找 `…` 的探测器恒返回 false」。
    expect(tailFrom(screen[g.windowSlots[0]!.y] ?? "", g.windowSlots[0]!.x).includes("…")).toBe(true);
  });

  it("⚠️ `closeHint: false` ⇒ `g.windowClose` 是 `null` **且**屏上找不到「esc 关窗」那几个字", async () => {
    const off = props({ color: true, history: { ...base, closeHint: false } });
    const g = geometry(geoInput(off));
    expect(g.windowClose).toBeNull();
    // ⚠️ 而**标题于是能用满整行**（判据是同一个值的两处表现，不是「它变淡了」）
    expect(g.windowTitle!.x + g.windowTitle!.width).toBe(
      g.windowHeader!.x + g.windowHeader!.width,
    );
    const joined = (await renderFrame(off)).join("\n");
    expect(joined).not.toContain("esc");
    expect(joined).not.toContain("关窗");
    // ⚠️ **反向自检**：同一份视图给 `closeHint: true` 时那两个词**必须**出现，
    // 否则上面那两条是「什么都没渲染」的恒绿。
    const on = await renderFrame(props({ color: true, history: base }));
    expect(on.join("\n")).toContain("esc");
    expect(on.join("\n")).toContain("关窗");
    expect(geometry(geoInput(props({ history: base }))).windowClose).not.toBeNull();
  });

  it("⚠️ 改名框画出来了（提示符占满 `WINDOW_INPUT_PROMPT_COLUMNS`，插入符是反底色）", async () => {
    const p = props({
      color: true,
      history: { ...base, rename: { id: "h1", text: "alpha", cursor: 3 } },
    });
    const raw = await renderRaw(p);
    const g = geometry(geoInput(p));
    const rect = g.windowInput;
    const text = g.windowInputText;
    // ⚠️ **探针先自检**：那一格给 `null` 时下面几行都不跑
    expect(rect).not.toBeNull();
    expect(text).not.toBeNull();
    const line = raw[rect!.y] ?? "";
    const promptAt = indexOfText(line, "✎");
    expect(promptAt).toBeGreaterThanOrEqual(0);
    // ⚠️ 提示符**恒占那两列**，而文字从 `windowInputText.x` 起 —— 两处对不上就是错开一列
    expect(widthOf("✎ ")).toBe(WINDOW_INPUT_PROMPT_COLUMNS);
    expect(columnOfIndex(line, promptAt) + WINDOW_INPUT_PROMPT_COLUMNS).toBe(text!.x);
    // ⚠️ 插入符在 `cursor` 那一格（`windowInput` 恒是一行 ⇒ 没有「落在第几行」的换算）
    const caretColumn = text!.x + 3;
    expect(reversedAt(line, caretColumn)).toBe(true);
    // ⚠️ 探针先自检（`-1` 时下面那条 `undefined` 判据恒假，而症状与「实现没画对」一模一样）
    const glyphAt = rawIndexOfColumn(line, caretColumn);
    expect(glyphAt).toBeGreaterThanOrEqual(0);
    expect(line[glyphAt]).toBe("h");
    expect(reversedAt(line, caretColumn - 1)).toBe(false);
    expect(reversedAt(line, caretColumn + 1)).toBe(false);
    // ⚠️ 而框里那一串字**逐字**在屏上
    expect(tailFrom(stripAnsi(line), rect!.x)).toContain("alpha");
  });

  it("⚠️ 改名框开着时 `Composer` **不画插入符**（两处反底色不许同时在屏上）", async () => {
    const p = props({
      color: true,
      history: { ...base, rename: { id: "h1", text: "a", cursor: 1 } },
      input: "/managers",
      cursor: 9,
    });
    const on = await renderRaw(p);
    const off = await renderRaw(props({ color: true, input: "/managers", cursor: 9 }));
    const caretRow = geometry(geoInput(props({ input: "/managers", cursor: 9 }))).inputTextRows[0]!.y;
    /** 那一行上最后一个反底色格子的**显示列**（`-1` = 一个都没有） */
    const finds = (line: string, theme: Theme): number => {
      const wanted = bgSgrOf(toneColor("selected", theme)!);
      let at = -1;
      for (let x = 0; x < COLUMNS; x += 1) if (bgAtColumn(line, x) === wanted) at = x;
      return at;
    };
    // ⚠️ **每一帧都按它自己那份主题找**：输入区吃的是**遮罩态**的主题，而那一档 `selected`
    // 已被压暗 —— 拿不带遮罩的那一档去搜遮罩态那一帧会**恒搜不到**，于是这条判据变成恒绿。
    // ⚠️ **反向自检**：不带弹窗那一帧**必须**找得到那个块（找不到的话下面那条恒真，
    // 而症状与「实现没画插入符」一模一样）
    expect(finds(off[caretRow] ?? "", cardTheme())).toBeGreaterThanOrEqual(0);
    // ⚠️ 弹窗开着时输入框那一行**一格都不许**是反底色：按键已经全被弹窗吃掉，
    // 而屏上留着那个块等于说「焦点还在输入框」。
    expect(finds(on[caretRow] ?? "", themeOf({ color: true, scrimmed: true }))).toBe(-1);
    // ⚠️ 而**改名框那个块必须在**（判的是「焦点搬走了」而不是「插入符整个不画了」）
    const renameRow = geometry(geoInput(p)).windowInput!;
    expect(finds(on[renameRow.y] ?? "", cardTheme())).toBeGreaterThanOrEqual(0);
  });

  // ⚠️ 这一条是本档**最贵**的一条断言，而它守着一个「屏上看着没毛病、其实遮罩漏了两块」的实现：
  // 侧边栏那一列**自己带底色**（Ink 后画 ⇒ 盖在整屏那层上），输入框**上下框那两行**里 Ink 只读
  // 节点自己的 `borderBackgroundColor`（不继承 ⇒ 边框一画就把那两行重写成「没有底色」）。
  // 两条都不会让任何一条 `includes` 断言变红 —— 故判据是**逐格**比两帧。
  it("⚠️ 背后**整屏铺上遮罩**：卡片那一块之外，每一格的底色都与关窗时不同", async () => {
    const p = props({ color: true, history: base });
    const off = await renderRaw(props({ color: true }));
    const on = await renderRaw(p);
    const box = geometry(geoInput(p)).windowBox!;
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
        // ⚠️ **反底色那一格是唯一的例外**：它自己给底色 ⇒ 遮罩压不到它，也**不该**压到它
        if (was === caret || now === caret) continue;
        if (was === now || now === null) missed.push(`(${String(x)},${String(y)}) ${String(was)} → ${String(now)}`);
      }
    }
    // ⚠️ 计数也是判据的一部分：100×28 = 2800 格，卡片占 70×14 = 980 ⇒ 至多 1820 格在它之外；
    // 「漏了整屏」那种实现会掉到几百，于是这条仍是**够不着**的。
    expect(checked).toBeGreaterThan(1500);
    expect(missed.slice(0, 8)).toEqual([]);
  });

  // ⚠️ **Ink 对过宽的 `<Text>` 是静默软换行**：一换行，**后面所有行都往下移**、卡片跟着长高 ——
  // 症状是「卡片里多出一行而下面那些掉出去了」。改名的输入串**没有**「状态层已裁好」那份承诺，
  // 故它是本档唯一合法喂超长数据的那一档（喂别的那几档就是给一份破契约）。
  it("⚠️ **没有一行超宽**：改名串长到撑爆那一格时，每一槽仍落在它自己的那一行上", async () => {
    const view: SessionHistoryView = {
      ...base,
      rename: { id: "h1", text: "x".repeat(400), cursor: 200 },
    };
    const p = props({ history: view });
    const g = geometry(geoInput(p));
    const screen = await renderScreen(p);
    // ⚠️ **逐槽**量：那一行上从 `rect.x` 起到屏尾的字面宽度**不超过**那一槽的预算
    for (const rect of g.windowSlots) {
      if (rect === null) continue;
      expect(widthOf(restColumns(screen[rect.y] ?? "", rect.x))).toBeLessThanOrEqual(rect.width);
    }
    // ⚠️ 而**每一槽的字都在它自己的那一行**（软换行的后果是下面那些整体下移一格）
    expect(screenRowOf(screen, "今天")).toBe(g.windowGroups[0]!.y);
    expect(screenRowOf(screen, "会话 5")).toBe(g.windowRows[2]!.y);
    expect(screenRowOf(screen, "✎")).toBe(g.windowInput!.y);
    // ⚠️ **整帧**仍不越出终端列数，而**最后一格有字的行恒是状态行那一行**
    //（卡片长出来的那一行会画在它下面 ⇒ 屏高之外出现了字）
    for (const line of screen) expect(widthOf(line)).toBeLessThanOrEqual(COLUMNS);
    const lastPainted = screen.reduce((top, line, i) => (line === "" ? top : i), -1);
    expect(lastPainted).toBe(p.rows - 1);
    // ⚠️ 卡片底边那一行**必须**还是空的（长出来的那一行会把它顶掉）
    const box = g.windowBox!;
    expect(tailFrom(screen[box.y + box.height - 1] ?? "", box.x).trim()).toBe("");
  });

  it("⚠️ 装不下的那些槽**一个字都不许出现**（`null` 槽当照画是最容易假绿的一处）", async () => {
    // ⚠️ 这一屏的内容区只装得下十来行，故喂二十来行 ⇒ 末尾若干槽必然是 `null`
    const many = Array.from({ length: 24 }, (_, i) => session(`s${String(i)}`, `会话 ${String(i)}`, false));
    const p = props({ history: { ...base, rows: many } });
    const g = geometry(geoInput(p));
    expect(g.windowSlots.filter((one) => one === null).length).toBeGreaterThan(0);
    const joined = (await renderFrame(p)).join("\n");
    const shown = g.windowRows.filter((one) => one !== null).length;
    for (const [i, row] of many.entries()) {
      // ⚠️ 判据是**「几何说装下了吗」**：前 `shown` 行必须出现，之后的**一个都不许**出现 ——
      // 只断言「末尾那几行没出现」的话，一个「照画并多画几行」的实现照样全绿。
      if (i < shown) expect(joined).toContain(row.label);
      else expect(joined).not.toContain(row.label);
    }
  });
});

/**
 * 从第 `from` 个**显示列**起到行尾
 * @description ⚠ 入参**必须**是 `renderScreen` 那种**已剥过 ANSI**的帧：这里没有第二份
 * 「剥 ANSI」的实现（那一份都属于造帧，而它的答案是逐字符扫而不是一条正则）。
 */
function tailFrom(line: string, from: number): string {
  return restColumns(line, from);
}

describe("源码级：`app.tsx` 真的把 `history.closeHint` 交给了几何层", () => {
  /**
   * `src/app.tsx` 的**代码**（注释整行略去：注释里点名那个字段是在**描述**这条不变量，
   * 而那会让判据在「代码删了注释还在」时恒绿）
   */
  function appCode(): string {
    // ⚠️ **两个** `..`：本档在 `tests/layout/`（比 `tests/` 深一层），一个会落到 `tests/src`
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "src",
      "app.tsx",
    );
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !(trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*"));
      })
      .join("\n");
  }

  /**
   * 那一行赋值的形状：`windowCloseHint:` 后面那个表达式里**读到了 `history` 的 `closeHint`**
   * @description 锚在**今天还存在的字段名**上（`windowCloseHint:` 与 `closeHint`），
   * 故硬写成 `true` 会当场转红，而这不是「点名一个已删掉的符号」那种恒绿。
   */
  const READS_CLOSE_HINT = /windowCloseHint:\s*[^,]*history[^,]*closeHint/;

  it("扫描面非空且真的覆盖到 `app.tsx`（否则下面那条是空断言）", () => {
    const code = appCode();
    expect(code).toContain("function Layout");
    expect(code).toContain("windowCloseHint:");
    expect(code.length).toBeGreaterThan(500);
  });

  it("⚠️ `windowCloseHint` 那一行读的是 `history.closeHint`，不是硬写的 `true`", () => {
    expect(READS_CLOSE_HINT.test(appCode())).toBe(true);
  });

  it("判据自检 + 反向自检：喂进**硬写**的那一份，判据必须判它不读", () => {
    // ⚠️ 「探测器看得见」与「今天真的读了」合起来才叫断言；而反向那一半防的是
    // 「判据匹配不到任何东西」——那种失守的症状是全绿而不是红。
    expect(READS_CLOSE_HINT.test("windowCloseHint: props.history?.closeHint ?? true,")).toBe(true);
    expect(READS_CLOSE_HINT.test("windowCloseHint: true,")).toBe(false);
    expect(READS_CLOSE_HINT.test("windowCloseHint: props.window !== null,")).toBe(false);
    // ⚠️ 而**只写在一个注释里**的不算数（否则把那一行删了判据照样绿）
    const commented = ["// windowCloseHint: props.history?.closeHint", "windowCloseHint: true,"].join("\n");
    expect(READS_CLOSE_HINT.test(appCodeOf(commented))).toBe(false);
  });

  /** 与 {@link appCode} 同一套「去注释」步骤（合成样本要判的是那一步，故它也得能用） */
  function appCodeOf(text: string): string {
    return text
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !(trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*"));
      })
      .join("\n");
  }
});
