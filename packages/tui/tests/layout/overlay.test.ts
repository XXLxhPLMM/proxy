/**
 * 两块**浮在别的区之上、而背后照旧亮着**的浮层：命令面板（浮在输入框正上方）与
 * 会话菜单（浮在侧边栏那一列上）。
 *
 * @description
 * 两块都不是模态：⚠️ 它们**不铺遮罩**，故判据是「它压住的那几格换了底色，而菜单之外那一行
 * **没有被压暗**」—— 后半句是这一档的一半，光看前半句的话「整屏铺一层更暗的底色」也能照样通过。
 *
 * ⚠️ 高亮靠「**最亮那一档 + 加粗 + 记号**」三样，而**没有反底色**：无色终端里记号是唯一认得出的通道。
 * ⚠️ 判据要问「**哪一个**底色」而不是「开没开」—— 见 `selection.test.ts` 那条不变式。
 *
 * 两条不变量的完整说明与判据为什么这么写见本目录 `AGENTS.md`。
 *
 * @module tests/layout
 */

import { describe, expect, it, vi } from "vitest";

// ⚠️ 必须在 ink（因而 chalk）被 import 之前设好，否则每一档的着色判据恒为「没有序列」—— 见 `AGENTS.md`
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { SIDEBAR_GAP, geometry } from "@/lib/geometry.js";
import type { MenuView } from "@/components/index.js";
import { themeOf, toneColor } from "@/theme/index.js";
import { SIDEBAR, geoInput, props, renderFrame, renderRaw, renderScreen } from "./_harness.js";
import { atText, bgAtColumn, bgSgrOf, indexOfText, isBoldAt, screenRowOf, sgrColorAt } from "./_probe.js";

describe("不变量 ⑤：面板的高亮靠「最亮那一档 + 加粗 + 记号」，没有反底色", () => {
  const palette = {
    rows: [
      { text: "/help", summary: "列出命令" },
      { text: "/status", summary: "服务进程与代理的现状" },
    ],
    at: 1,
    total: 2,
    footer: null,
  };

  it("高亮那一行**没有底色**（这一列的底色归 hover）", async () => {
    const raw = await renderRaw(props({ color: true, palette, input: "/status" }));
    const at = atText(raw, "服务进程与代理的现状");
    expect(at.index).toBeGreaterThan(0);
    expect(sgrColorAt(at.line, at.index, "bg")).toBeNull();
  });

  it("高亮那一行是最亮的那一档前景 + 加粗，而未高亮的那行不是", async () => {
    const raw = await renderRaw(props({ color: true, palette, input: "/status" }));
    const at = atText(raw, "服务进程与代理的现状");
    const other = atText(raw, "列出命令");
    expect(isBoldAt(at.line, at.index)).toBe(true);
    expect(isBoldAt(other.line, other.index)).toBe(false);
    expect(sgrColorAt(at.line, at.index, "fg")).not.toBe(sgrColorAt(other.line, other.index, "fg"));
  });

  it("高亮那一行左边有记号（形状通道，无色终端里靠它认）", async () => {
    const lines = await renderFrame(props({ palette, input: "/status" }));
    expect(lines.some((line) => line.includes("▍"))).toBe(true);
  });

  it("面板浮在输入框正上方，且至多占结果区内容行的四成", async () => {
    const p = props({ palette: { ...palette, total: 19, rows: manyRows(19) }, input: "/" });
    const g = geometry(geoInput(p));
    expect(g.paletteRows.length + (g.paletteFooterRow === null ? 0 : 1)).toBeLessThanOrEqual(
      Math.floor(g.output!.height * 0.4),
    );
    const lines = await renderScreen(p);
    expect(screenRowOf(lines, "╭")).toBeGreaterThanOrEqual(0);
  });
});

/** 造 n 行候选（面板「装不下」那一档用） */
function manyRows(n: number): { text: string; summary: string | null }[] {
  return Array.from({ length: n }, (_, i) => ({ text: `/cmd-${i}`, summary: null }));
}

describe("不变量 ⑨：会话菜单是一块浮层，浮在别的东西上面，而背后那一层照旧可见", () => {
  const menu = (over: Partial<MenuView> = {}): MenuView => ({
    sessionId: "s1",
    items: ["删除会话", "重命名"],
    at: 0,
    origin: [4, 6],
    ...over,
  });

  it("关掉时屏上一个字都不多（菜单不是常驻的）", async () => {
    const lines = await renderFrame(props());
    expect(lines.join("\n")).not.toContain("删除会话");
    expect(lines.join("\n")).not.toContain("重命名");
  });

  it("⚠️ 两项都画在几何给的那两行上，且**高亮落在 `at` 那一项**（记号 + 加粗）", async () => {
    const p = props({ menu: menu(), selectedSessionId: "s2" });
    const g = geometry(geoInput(p));
    const screen = await renderScreen(p);
    expect(screen[g.menuRows[0]!.y]?.slice(g.menu!.x)).toContain("删除会话");
    expect(screen[g.menuRows[1]!.y]?.slice(g.menu!.x)).toContain("重命名");
    const raw = await renderRaw(p);
    const row = raw[g.menuRows[0]!.y] ?? "";
    expect(row).toContain("▍");
    expect(isBoldAt(row, indexOfText(row, "删除会话"))).toBe(true);
    // ⚠️ 而**第二项没有**高亮（`at` 换了就换全套）
    const other = raw[g.menuRows[1]!.y] ?? "";
    expect(other).not.toContain("▍");
  });

  it("⚠️ 菜单**浮在上面**：它压住的那几格本来就是侧边栏那一列的底色，而卡片那一块换成 `panel`", async () => {
    const p = props({ color: true, menu: menu({ origin: [1, 0] }) });
    const g = geometry(geoInput(p));
    expect(g.menuRows[0]!.y).toBe(0);
    const raw = await renderRaw(p);
    // ⚠️ **逐格量**：菜单在第 0 行第 1 列，而那一格在关掉菜单时是 `surface`（侧边栏那一列的底色）
    const off = await renderRaw(props({ color: true }));
    const panel = bgSgrOf(toneColor("panel", themeOf({ color: true, scrimmed: false }))!);
    expect(bgAtColumn(off[0] ?? "", 1)).toBe(
      bgSgrOf(toneColor("surface", themeOf({ color: true, scrimmed: false }))!),
    );
    expect(bgAtColumn(raw[0] ?? "", 1)).toBe(panel);
    // ⚠️ 而菜单之外那一行**没被遮罩压暗**（菜单不是模态 —— 屏上后几块都照旧亮着）
    expect(bgAtColumn(raw[0] ?? "", SIDEBAR + SIDEBAR_GAP + 4)).toBe(bgAtColumn(off[0] ?? "", SIDEBAR + SIDEBAR_GAP + 4));
  });

  it("空白处那一份只有一项（那里没有「它」可以删除或改名）", async () => {
    const one = menu({ sessionId: null, items: ["新建会话"], at: 0 });
    const p = props({ menu: one });
    const g = geometry(geoInput(p));
    expect(g.menuRows).toHaveLength(1);
    const screen = await renderScreen(p);
    expect(screen[g.menuRows[0]!.y]?.slice(g.menu!.x)).toContain("新建会话");
    expect(screen.join("\n")).not.toContain("删除会话");
  });
});
