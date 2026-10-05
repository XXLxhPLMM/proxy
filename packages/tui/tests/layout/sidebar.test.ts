/**
 * 侧边栏那一列：项落在哪一行、顶部与项间那几行空不空、裁剪预算、装不下时的那句说明、
 * 悬停才画出来的那一枚「✕」、那一枚记号，以及它与主区之间那一列。
 *
 * @description
 * 这一列的全部事实都在这里：⚠️ **顶部那 {@link SIDEBAR_TOP_PAD_ROWS} 行一个字都没有**（它们不属于
 * 任何一项）、**项间恒隔一行**、**名字的预算恒扣掉关闭那两列**（悬停不改变它有多宽）。
 *
 * ⚠️ 判据量的是「**画出来的行号 == 几何给的行号**」而不是「屏上有这么一句」：少补那个间隔或那几行
 * 顶部留白时每一项都比几何给的行号差一行，而症状是「屏上第一项是会话 1、点它切到别的会话」。
 * ⚠️ 名字太长时它被裁而**不把下一项顶下去**（少算一列就是 Ink 静默软换行、整屏往下移）。
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
import {
  SESSION_CLOSE_COLUMNS,
  SESSION_MARK_COLUMNS,
  SESSION_ROWS,
  SESSION_STRIDE,
  SIDEBAR_GAP,
  SIDEBAR_TEXT_X,
  SIDEBAR_TOP_PAD_ROWS,
  geometry,
  hitTest,
} from "@/lib/geometry.js";
import { themeOf, toneColor } from "@/theme/index.js";
import { flatten } from "@/lib/log/index.js";
import type { SessionRow } from "@/app.js";
import {
  ITEM_ROW,
  SIDEBAR,
  entryOf,
  geoInput,
  noteRow,
  props,
  renderRaw,
  renderScreen,
  stripAnsi,
} from "./_harness.js";
import {
  bgAtColumn,
  column,
  columnOfIndex,
  fgSgrOf,
  indexOfText,
  rawIndexOfColumn,
  restColumns,
  screenRowOf,
  sidebarScreen,
  sgrColorAt,
} from "./_probe.js";

describe("不变量 ②：侧边栏列会话，每项两行（名字 + 它连的控制面），项间空一行", () => {
  it("会话名在第一行、控制面名在第二行（两行都画得出来）", async () => {
    const first = await sidebarScreen(props());
    expect(first[ITEM_ROW(0)]).toContain("会话 1");
    expect(first[ITEM_ROW(0) + 1]).toContain("live-ok");
    expect(first[ITEM_ROW(1)]).toContain("会话 2");
    expect(first[ITEM_ROW(1) + 1]).toContain("未选控制面");
  });

  it("第二行答的是「这个会话连的是哪一台」——`null` 说成一句人话而不是空串", async () => {
    const first = await sidebarScreen(
      props({
        sessions: [
          { id: "s1", name: "会话 1", manager: "机房那台", run: "idle" },
          { id: "s2", name: "会话 2", manager: null, run: "idle" },
        ],
      }),
    );
    expect(first[ITEM_ROW(0)]).toContain("会话 1");
    expect(first[ITEM_ROW(0) + 1]).toContain("机房那台");
    // 空串与「名字是空的控制面」在屏上同形，而「还没选」是一个**常见的**状态
    expect(first[ITEM_ROW(1) + 1]).toContain("未选控制面");
  });

  // ⚠️ 这一条与下面那条是一对：**顶部那几行留白**（第一项不在第 0 行）与**项间空一行**
  // （两个判据各自独立）：少间隔的会话名与控制面名会互相读串，而少顶部留白的话清单与主区的
  // 第一行读起来是同一条信息，且「点清单最上面」会落空。
  it("⚠️ 顶部那 {@link SIDEBAR_TOP_PAD_ROWS} 行在侧边栏那一列上**一个字都没有**", async () => {
    const p = props();
    const g = geometry(geoInput(p));
    const first = await sidebarScreen(p);
    expect(SIDEBAR_TOP_PAD_ROWS).toBeGreaterThan(0);
    for (let y = 0; y < SIDEBAR_TOP_PAD_ROWS; y += 1) expect(first[y]?.trim()).toBe("");
    // ⚠️ 而**第一项正落在几何给的那一行上**：少那个空盒子的话这里量到的是上面那一行
    expect(first[g.sidebarRows[0]!.y]).toContain("会话 1");
    // ⚠️ **反向自检**：主区在同一行上有内容 —— 否则「留白那一行是空的」与「整帧没渲染」长得一样。
    // ⚠️ 按**显示列**切（{@link restColumns}）而不是 `slice`：后者数的是 UTF-16 码元，而这一行上有汉字
    // —— 侧边栏一变宽，切点就落在「刚刚好切在『写入』后面」的位置上，而症状是「主区没渲染」。
    const full = (await renderScreen(p))[0] ?? "";
    expect(restColumns(full, SIDEBAR + SIDEBAR_GAP)).toContain("写入");
  });

  it("⚠️ 顶部留白那一格**点不中任何一项**（几何那份也是空的）", () => {
    const g = geometry(geoInput(props()));
    for (let y = 0; y < SIDEBAR_TOP_PAD_ROWS; y += 1) {
      expect(hitTest(3, y, g.sidebarRows)).toBe(-1);
    }
    // ⚠️ **反向自检**：留白之下那一格点得中（否则上面那些恒为 `-1`，而这一档就量不到任何东西）
    expect(hitTest(3, g.sidebarRows[0]!.y, g.sidebarRows)).toBe(0);
  });

  it("⚠️ 两项之间那一行在侧边栏那一列上**一个字都没有**（它只属于「间隔」）", async () => {
    const first = await sidebarScreen(props());
    const gap = ITEM_ROW(0) + SESSION_ROWS;
    expect(SESSION_STRIDE - SESSION_ROWS).toBe(1);
    expect(first[gap]?.trim()).toBe("");
    // ⚠️ 而它上面与下面**都有字**：那一格夹在两个项之间，不是「清单到头了」
    expect(first[gap - 1]).toContain("live-ok");
    expect(first[gap + 1]).toContain("会话 2");
  });

  it("⚠️ 第一项落在 {@link Geometry.sessionRows} 给的那一行上（画出来的行号 == 几何给的行号）", async () => {
    // ⚠️ 判据量的是「**画出来的行号 == 几何给的行号**」：少补那个间隔盒子时每一项都比几何给的行号高一行，
    // 而 `sidebarRows` 仍按间隔算 —— 症状是「屏上第一项是会话 1、点它切到别的会话」。
    const p = props();
    const g = geometry(geoInput(p));
    const screen = await renderScreen(p);
    expect(screen[g.sidebarRows[0]!.y]?.slice(0, SIDEBAR)).toContain("会话 1");
    expect(screen[g.sidebarRows[1]!.y]?.slice(0, SIDEBAR)).toContain("会话 2");
  });

  it("名字太长时它被裁，而**不把下一项顶下去**（每一项恒占两行）", async () => {
    // ⚠️ 少了「按可用宽度裁」这一步，Ink 会**静默软换行** —— 而那多出来的一行会把下一项
    // 顶到第三行去，于是侧边栏里的项与几何给的 `sidebarRows` **不再是同序**：
    // 命中测试说「第 2 项」，屏上第 2 行却是第 1 项的第二个字。
    const p = props({
      sessions: [
        { id: "s1", name: "一个非常非常非常长的会话名字", manager: "一个非常长的控制面名字", run: "idle" },
        { id: "s2", name: "会话 2", manager: null, run: "idle" },
      ],
    });
    const first = await sidebarScreen(p);
    expect(first[ITEM_ROW(0)]).toContain("…");
    expect(first[ITEM_ROW(1)]).toContain("会话 2");
    // ⚠️ 而那一项**不许越过侧边栏**：预算少扣一列时多出来的那一格落进间隔列，
    // 于是那一列上出现了字 —— 而屏上那根竖线（间隔）本该是空的。
    // ⚠️ 结果区**必须有内容**才量得到它：Ink 每行末尾去空白，而那一行的主区若是空的，
    // 「右边没字」在「没溢出」与「溢出到间隔列又被去掉了」两种实现下**都对**。
    const three = flatten(
      [entryOf([noteRow("一"), noteRow("二"), noteRow("三")])],
      geometry(geoInput(props())).outputWidth,
    );
    const filled = { ...p, flat: three };
    // ⚠️ 量的是**名字那一行**（顶部不留白 ⇒ 它是第 0 行），而主区第 0 行上落的是结果区的**第一**行
    const row = (await renderScreen(filled))[ITEM_ROW(0)] ?? "";
    expect(row).toContain("一");
    // ⚠️ 而**下一项**在第 {@link SESSION_STRIDE} 行（中间那一行是间隔）：名字那一行不许把它顶下来
    expect((await renderScreen(filled))[ITEM_ROW(1)]).toContain("会话 2");
    expect(column(row, SIDEBAR + 1)).toBe(`${column(row, SIDEBAR)} `);
  });

  it("装不下的必须说一声（静默少画几行 ⇒ 操作者以为会话就这几个）", async () => {
    const many: SessionRow[] = [];
    for (let i = 0; i < 40; i += 1) many.push({ id: `s${i}`, name: `会话 ${i}`, manager: null, run: "idle" });
    const p = props({ rows: 12, sessions: many });
    const g = geometry(geoInput(p));
    expect(g.sidebarOverflowRow).not.toBeNull();
    // ⚠️ 判据是「**几何说的那一行**」而不是「屏上有这么一句」：贴着屏底的那一句若画在别的行上，
    // 滚动之后它就会跑到别处去而断言照旧绿。
    const screen = await renderScreen(p);
    expect(screen[g.sidebarOverflowRow!.y]?.slice(0, SIDEBAR)).toContain(`共 ${String(many.length)}`);
  });

  it("⚠️ 那一句说清「第几–第几 / 共几个」，而**装得下时不占**那一行", async () => {
    const many: SessionRow[] = [];
    for (let i = 1; i <= 7; i += 1) many.push({ id: `s${i}`, name: `会话 ${i}`, manager: null, run: "idle" });
    const p = props({ rows: 12, sessions: many });
    const g = geometry(geoInput(p));
    expect(g.sessionViewportRows).toBeLessThan(many.length);
    // ⚠️ 12 行：顶部留白 1 + 步长 3 ⇒ 装得下 4 项（1–2、4–5、7–8、10–11），而末尾那一行说明
    // 占掉第 11 行 ⇒ 可见项数掉到 3
    expect(g.sessionViewportRows).toBe(3);
    expect((await renderScreen(p))[g.sidebarOverflowRow!.y] ?? "").toContain("1–3 / 共 7");
    // ⚠️ **跟着窗口滚**：滚过之后那句话说的是「现在看到的」那几个，而不是恒定的 1–3
    const scrolled = props({ rows: 12, sessions: many, sessionsTop: 2 });
    const gScrolled = geometry(geoInput(scrolled));
    expect(gScrolled.sessionFirst).toBe(2);
    expect((await renderScreen(scrolled))[gScrolled.sidebarOverflowRow!.y] ?? "").toContain("3–5 / 共 7");
    // ⚠️ 而**全部装得下**时那一格是 `null`（于是**不占**那一行），屏上也没有那句话
    const fits = props({ rows: 12, sessions: many.slice(0, 2) });
    expect(geometry(geoInput(fits)).sidebarOverflowRow).toBeNull();
    expect((await renderScreen(fits)).join("\n")).not.toContain("共");
  });

  it("⚠️ 装不下时画出来的是窗口**那一段**（`sessionFirst` 的渲染侧）", async () => {
    const many: SessionRow[] = [];
    for (let i = 1; i <= 9; i += 1) many.push({ id: `s${i}`, name: `会话 ${i}`, manager: null, run: "idle" });
    const p = props({ rows: 12, sessions: many, sessionsTop: 2 });
    const g = geometry(geoInput(p));
    expect(g.sessionFirst).toBe(2);
    expect(g.sidebarRows.length).toBeLessThan(many.length);
    const joined = (await sidebarScreen(p)).join("\n");
    // ⚠️ 会话名**互相不含**（「会话 1」不是「会话 8」的一个子串），故这几条各有各的落点；
    // 少加 {@link Geometry.sessionFirst} 的实现会画出前 5 项 → 「会话 1」与「会话 2」都还在屏上
    expect(joined).toContain("会话 3");
    expect(joined).not.toContain("会话 1");
    expect(joined).not.toContain("会话 2");
    expect(joined).not.toContain("会话 8");
  });

  // ⚠️ 这一组是「悬停才画出来的那一枚「✕」」：**位置恒定、宽度恒定、只画在悬停的那一项上**。
  // 三条各自独立：位置错位是「点它关掉了邻居」，宽度漂移是「悬停那一帧名字在抖」。

  it("⚠️ 那一枚「✕」只在**悬停的那一项**上，且落在它的**名字那一行**", async () => {
    const p = props({ hoveredSessionId: "s2" });
    const g = geometry(geoInput(p));
    const screen = await renderScreen(p);
    // ⚠️ **逐屏行**量位置：判在「屏上有这么一枚」上的话，画在控制面那一行（差一格）也照样绿
    expect(screen[g.sidebarRows[1]!.y]?.slice(0, SIDEBAR)).toContain("✕");
    expect(screen[g.sidebarRows[1]!.y + 1]?.slice(0, SIDEBAR)).not.toContain("✕");
    expect(screen[g.sidebarRows[0]!.y]?.slice(0, SIDEBAR)).not.toContain("✕");
    // ⚠️ 而**没有悬停**时一个都没有 —— 那一枚是**状态**画出来的
    expect((await renderScreen(props())).join("\n")).not.toContain("✕");
  });

  it("⚠️ 那一枚「✕」落在几何给的那一格上（点得着的那一格 == 画出来的那一格）", async () => {
    const p = props({
      sessions: [
        { id: "s1", name: "会话 1", manager: null, run: "idle" },
        { id: "s2", name: "会话 2", manager: null, run: "idle" },
      ],
      hoveredSessionId: "s2",
    });
    const slot = geometry(geoInput(p)).sidebarCloseRows[1]!;
    const row = (await renderScreen(p))[slot.y]?.slice(0, SIDEBAR) ?? "";
    const trimmed = row.trimEnd();
    // ⚠️ **按显示列量**而不是按字符下标：一个 CJK 字符占两列，按下标会偏，而症状是「位置看着差不多」。
    // 而「去掉尾部空白之后的末格就是那一枚」这个判据同时钉住了两件事：它在**名字右边**，
    // 且它落在 {@link Geometry.sidebarCloseRows} 给的那一列上（不是更靠右、也不是压着名字）。
    expect(trimmed.slice(-1)).toBe("✕");
    expect(widthOf(trimmed) - 1).toBe(slot.x);
  });

  it("⚠️ 会话名的裁剪预算**恒**扣掉那两列（悬停不改变它有多宽）", async () => {
    const p = props({
      sessions: [
        { id: "s1", name: "一个非常非常非常长的会话名字", manager: "live-ok", run: "idle" },
        { id: "s2", name: "会话 2", manager: null, run: "idle" },
      ],
    });
    const cold = await sidebarScreen(p);
    const hot = await sidebarScreen({ ...p, hoveredSessionId: "s1" });
    const row = ITEM_ROW(0);
    expect(cold[row]).toContain("…");
    expect(hot[row]).toContain("✕");
    // ⚠️ 而名字那一行的字**不许进右边那 {@link SESSION_CLOSE_COLUMNS} 列**：那两列是**恒**留给按钮的，
    // 而按钮只在悬停时画 —— 名字越界的话悬停那一帧它就被压在按钮底下，而那一帧正是正在读它的那一帧。
    expect(widthOf(cold[row]!.trimEnd())).toBeLessThanOrEqual(SIDEBAR - SESSION_CLOSE_COLUMNS);
    // ⚠️ **判据是「去掉那一枚之后逐字相同」**：只在悬停时才扣那两列的实现，两帧的**截断点**不同
    // （省略标记落在不同的列上），而每一列都还在预算内 —— 于是「每一行都不超宽」那条判据零鉴别力。
    expect(hot[row]!.replace("✕", "").trimEnd()).toBe(cold[row]!.trimEnd());
  });

  it("⚠️ 会话名恒不超过侧边栏宽（少算一列就是 Ink 静默软换行、整屏往下移）", async () => {
    const rows = await sidebarScreen(
      props({
        sessions: [{ id: "s1", name: "一个非常非常非常长的会话名字", manager: null, run: "idle" }],
        hoveredSessionId: "s1",
      }),
    );
    const row = rows[ITEM_ROW(0)] ?? "";
    expect(row).toContain("…");
    expect(widthOf(row.trimEnd())).toBeLessThanOrEqual(SIDEBAR);
    // ⚠️ 那一枚「✕」**不许把那一行顶宽**：越界的那一格落进间隔列，于是那一列上出现了字
    expect(restColumns(row, SIDEBAR)).toBe("");
  });

  // ⚠️ 这一组守的是「那一枚记号」：**三档**（转圈 / 绿点 / 没有）与「恒留的那三列」——
  // 后者是本组的一半，因为两帧的列位不同的话「这个名字在跳」，而症状是「焦点那一块在抖」。
  const marked = (run: readonly ("idle" | "running" | "done")[]) =>
    props({
      sessions: run.map((one, i) => ({
        id: `s${String(i + 1)}`,
        name: `会话 ${String(i + 1)}`,
        manager: null,
        run: one,
      })),
    });

  it("⚠️ 名字前面那一枚记号：运行中转圈 / 跑完一个绿点 / 没跑过**一个字都没有**", async () => {
    const p = marked(["running", "done", "idle"]);
    const screen = await sidebarScreen(p);
    // ⚠️ 判据是「记号与名字**之间**有一列空格」：那正是「记号位恒 3 列」的一半，
    // 而只判「屏上有这个字」的话「记号贴在名字上」也照样绿
    expect(screen[ITEM_ROW(0)]).toContain("⠋ 会话 1");
    expect(screen[ITEM_ROW(1)]).toContain("● 会话 2");
    expect(screen[ITEM_ROW(2)]).toContain("会话 3");
    // ⚠️ **反向自检**：没跑过的那一项一个记号都没有（而不是留着一个空格被当成「没有记号」）
    expect(screen[ITEM_ROW(2)]).not.toContain("●");
    expect(screen[ITEM_ROW(0)]).not.toContain("●");
  });

  // ⚠️ 记号位**恒是奇数**，故两侧各留同样多列 = 真居中。判据量的是**字形落在第几列**：
  // 「那一格里有没有字」量不到居中，而「字形落在第 1 列」在「两侧不等宽」的实现上会红。
  it("⚠️ 记号在它那三列里**居中**（左右各留一列），而三档的记号位**列位相同**", async () => {
    const p = marked(["running", "done", "idle"]);
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    const glyphColumn = (i: number, glyph: string): number => {
      const row = raw[g.sidebarRows[i]!.y] ?? "";
      const at = indexOfText(row, glyph);
      expect(at).toBeGreaterThanOrEqual(0);
      return columnOfIndex(row, at);
    };
    const left = Math.floor(SESSION_MARK_COLUMNS / 2);
    expect(glyphColumn(0, "⠋")).toBe(left);
    expect(glyphColumn(1, "●")).toBe(left);
    // ⚠️ 而**名字紧跟在记号位之后**：第三项是 `idle`（记号是一个空格），故那一格仍然占着位置
    const idle = raw[g.sidebarRows[2]!.y] ?? "";
    const nameAt = indexOfText(idle, "会话 3");
    expect(nameAt).toBeGreaterThanOrEqual(0);
    expect(columnOfIndex(idle, nameAt)).toBe(SIDEBAR_TEXT_X);
  });

  // ⚠️ **颜色是独立于字形的一个通道**：需求要的是「跑完了 = 绿色的那个点」，而判据必须问
  // 「**哪一个**色」——「开了颜色」在无色档与「读了另一档」上都恒真。
  it("⚠️ 记号的色档**读自己那一份**（跑完 = `ok` 那档绿），而名字仍吃选中那一档", async () => {
    const theme = themeOf({ color: true, scrimmed: false });
    const p = marked(["idle", "running", "done"]);
    const raw = await renderRaw({ ...p, color: true });
    const g = geometry(geoInput(p));
    const fgOf = (i: number, glyph: string): string | null => {
      const row = raw[g.sidebarRows[i]!.y] ?? "";
      const at = indexOfText(row, glyph);
      expect(at).toBeGreaterThanOrEqual(0);
      return sgrColorAt(row, at, "fg");
    };
    // ⚠️ `idle` 的字形是**一个空格**：探针按**显示列**取（第 1 列），而不是按 `indexOfText`
    // （后者会找到这一行最前面那个空格，于是量到的是缩进而**不是**记号）
    const idleRow = raw[g.sidebarRows[0]!.y] ?? "";
    const idleAt = rawIndexOfColumn(idleRow, Math.floor(SESSION_MARK_COLUMNS / 2));
    expect(idleAt).toBeGreaterThanOrEqual(0);
    expect(sgrColorAt(idleRow, idleAt, "fg")).toBe(fgSgrOf(toneColor("idle", theme)!));
    expect(fgOf(1, "⠋")).toBe(fgSgrOf(toneColor("accent", theme)!));
    // ⚠️ **判据是「`ok` 那一档」而不是「与 `accent` 不同」**：后者放行任何一档绿
    expect(fgOf(2, "●")).toBe(fgSgrOf(toneColor("ok", theme)!));
  });

  // ⚠️ **记号不吃选中色**（名字吃）：「我选了哪一项」与「它在干什么」是两个事实。
  // 判据是「记号那一格 == `idle` 那一档，而名字那一格 == `selected`」——
  // 只判「两者不同」的话「记号跟着名字一起变」也照样绿。
  it("⚠️ 选中那一项：名字亮成 `selected`，而记号**仍读自己那一档**", async () => {
    const theme = themeOf({ color: true, scrimmed: false });
    const p = marked(["idle", "idle", "idle"]);
    const raw = await renderRaw({ ...p, color: true });
    const g = geometry(geoInput(p));
    const row = raw[g.sidebarRows[0]!.y] ?? "";
    const nameAt = indexOfText(row, "会话 1");
    const markAt = rawIndexOfColumn(row, Math.floor(SESSION_MARK_COLUMNS / 2));
    // ⚠️ **两个探针下标先自检**（给 -1 时下面两条恒成立）
    expect(nameAt).toBeGreaterThanOrEqual(0);
    expect(markAt).toBeGreaterThanOrEqual(0);
    expect(sgrColorAt(row, nameAt, "fg")).toBe(fgSgrOf(toneColor("selected", theme)!));
    expect(sgrColorAt(row, markAt, "fg")).not.toBe(fgSgrOf(toneColor("selected", theme)!));
    expect(sgrColorAt(row, markAt, "fg")).toBe(fgSgrOf(toneColor("idle", theme)!));
  });

  it("⚠️ 那一列记号位**恒在**（三帧里名字落在同一列），而它就是名字的起始列", async () => {
    const p = marked(["idle", "running", "done"]);
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    const columnOfName = (i: number): number => {
      const row = raw[g.sidebarRows[i]!.y] ?? "";
      const at = indexOfText(row, `会话 ${String(i + 1)}`);
      // ⚠️ **探针先自检**：那个下标越界时 `columnOfIndex` 给 `-1`，而「三者相等」对三个 `-1` 恒成立
      expect(at).toBeGreaterThanOrEqual(0);
      return columnOfIndex(row, at);
    };
    const columns = [0, 1, 2].map(columnOfName);
    // ⚠️ **反向自检**：三列都不是 `-1`（否则上面那两条恒成立，而这一整档变成空断言）
    expect(columns.every((one) => one >= 0)).toBe(true);
    expect(columns[1]).toBe(columns[0]);
    expect(columns[2]).toBe(columns[0]);
    // ⚠️ 名字的起始列**恒等于**记号位的右缘（两件事是同一批列，叠加成 6 列的话名字会整体右移）
    expect(columns[0]).toBe(SIDEBAR_TEXT_X);
    expect(columns[0]).toBe(SESSION_MARK_COLUMNS);
  });

  it("⚠️ 一个会话都没有 ⇒ 侧边栏**整个不画**（屏上零会话字符，而那一列的宽度归 0）", async () => {
    const p = props({ sessions: [] });
    // ⚠️ 判据是「几何说这一列不存在」而不是「屏幕上没字」：后者在「整个界面没渲染」时恒成立
    expect(geometry(geoInput(p)).sidebar).toBeNull();
    const screen = await renderScreen(p);
    const joined = screen.join("\n");
    expect(joined).not.toContain("会话");
    expect(joined).not.toContain("未选控制面");
    // ⚠️ **反向自检**：同一帧里主区**有**内容（否则上面两条只是「什么都没渲染」）
    expect(screen[0]).toContain("已改");
  });

  it("侧边栏与主区之间**隔一列**（那一列两边都没有底色）", async () => {
    const raw = await renderRaw(props({ color: true, sidebarWidth: 20 }));
    const first = raw[3] ?? "";
    expect(bgAtColumn(first, 19)).not.toBeNull();
    expect(bgAtColumn(first, 20)).toBeNull();
    // 而主区从第 21 列起：那一行里第 20 列（间隔列）上**什么都没有**，
    // 而第 21 列往后是结果区那一行的内容
    expect(restColumns(stripAnsi(raw[0] ?? ""), 20)).toMatch(/^ /u);
    expect(restColumns(stripAnsi(raw[0] ?? ""), 21)).not.toBe("");
  });

  it("**画出来的**主区第一列 == 几何给的 `output.x`（间隔列漏插一个元素时它少一列）", async () => {
    // ⚠️ 这条判据量的是「Ink 摆出来的位置」与「几何算出来的位置」**逐字相同**：Ink 只把**兄弟**
    // 排在一起，故那一列间隔必须真的插一个元素，否则主区会贴在侧边栏右边（少一列），
    // 而症状是「点输入行定位插入符偏一个字」—— 屏上完全看不出那根竖线本该在哪。
    for (const sidebarWidth of [14, 20, 30]) {
      const p = props({ sidebarWidth });
      const g = geometry(geoInput(p));
      const lines = await renderScreen(p);
      const row = lines[screenRowOf(lines, "已改")] ?? "";
      expect(row.slice(g.output!.x)).toContain("已改");
    }
  });
});
