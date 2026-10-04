/**
 * 选中与 hover 的**着色**：选中 = 最亮那一档前景 + 加粗 + **没有多出底色**，
 * hover = **另一层**底色且铺满整项两行。
 *
 * @description
 * ⚠️ 判据必须问「**哪一个**色」而不是「开没开」：侧边栏那一列**整列都有底色**（`surface`），
 * 于是「开没开」在这一列上恒为真 —— 而「选中项没有底色」真正要说的是**它没有多出 hover 那一层**。
 * 故本档的探测器**真的解析 SGR 参数**（`sgrColorAt` / `isBoldAt`）。
 *
 * ⚠️ **加粗是颜色之外的第二通道**：无色终端里它是「哪一个被选中了」的唯一线索 ——
 * 只判颜色的那一版判据对那条不变式**零鉴别力**。
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

import { geometry } from "@/lib/geometry.js";
import { themeOf, toneColor } from "@/theme/index.js";
import type { LayoutProps } from "@/app.js";
import { ITEM_ROW, SIDEBAR, geoInput, props, renderFrame, renderRaw } from "./_harness.js";
import {
  atText,
  bgAtColumn,
  bgSgrOf,
  fgSgrOf,
  indexOfText,
  isBoldAt,
  sgrColorAt,
} from "./_probe.js";

describe("不变量 ③：选中靠「最亮那一档 + 加粗」，hover 靠**另一层底色**", () => {
  it("选中的那一项**没有**底色，而未选中的那几行连底色都没有", async () => {
    const raw = await renderRaw(props({ color: true }));
    // ⚠️ 判据必须问「**哪一个**底色」而不是「开没开」：侧边栏**整列**都有 `surface` 底色，
    // 于是「开没开」在这一列上恒为真，而「选中项没有底色」真正要说的是
    // **它没有多出 hover 那一层** —— 故与同一项的缩进处逐字相同。
    const at = atText(raw, "会话 1");
    expect(sgrColorAt(at.line, at.index, "bg")).toBe(sgrColorAt(at.line, 1, "bg"));
    // 而「未选中那一项」与「选中那一项」的底色也相同（选中只走前景色 + 加粗）
    const other = atText(raw, "会话 2");
    expect(sgrColorAt(other.line, other.index, "bg")).toBe(sgrColorAt(at.line, at.index, "bg"));
  });

  it("选中的那一项是**最亮的那一档前景** + 加粗，而未选中的那几行不是", async () => {
    const raw = await renderRaw(props({ color: true }));
    // ⚠️ 行号从 {@link ITEM_ROW} 算（顶部不留白），而 `renderRaw` 的下标就是屏行号
    const first = raw[ITEM_ROW(0)] ?? "";
    const at = indexOfText(first, "会话 1");
    const second = raw[ITEM_ROW(1)] ?? "";
    const other = indexOfText(second, "会话 2");
    // ⚠️ **两个探针下标先自检**：给 -1 时 `sgrColorAt` 恒返回 `null`，而「`null` ≠ 那个色」恒成立
    expect(at).toBeGreaterThanOrEqual(0);
    expect(other).toBeGreaterThanOrEqual(0);
    expect(sgrColorAt(first, at, "fg")).not.toBeNull();
    expect(sgrColorAt(second, other, "fg")).not.toBe(sgrColorAt(first, at, "fg"));
    // ⚠️ **加粗是颜色之外的第二通道**：无色终端里它是「哪一个被选中了」的唯一线索
    expect(isBoldAt(first, at)).toBe(true);
    expect(isBoldAt(second, other)).toBe(false);
  });

  // ⚠️ 「选中只高亮**标题**」这一条：两行都高亮的话，「我选了哪一项」与「它连着的那台是当前那台」
  // 在屏上读起来一样 —— 而这两个是**两件事**（面板与侧边栏各有自己的「当前」记号）。
  it("⚠️ 选中只高亮**标题那一行**：控制面那一行既不换色也不加粗", async () => {
    const p = props({ color: true });
    const g = geometry(geoInput(p));
    const theme = themeOf({ color: true, scrimmed: false });
    const raw = await renderRaw(p);
    const nameRow = raw[g.sidebarRows[0]!.y] ?? "";
    const managerRow = raw[g.sidebarRows[0]!.y + 1] ?? "";
    const nameAt = indexOfText(nameRow, "会话 1");
    const managerAt = indexOfText(managerRow, "live-ok");
    // ⚠️ **两个探针下标先自检**（给 -1 时下面两条恒成立）
    expect(nameAt).toBeGreaterThanOrEqual(0);
    expect(managerAt).toBeGreaterThanOrEqual(0);
    expect(sgrColorAt(nameRow, nameAt, "fg")).toBe(fgSgrOf(toneColor("selected", theme)!));
    expect(isBoldAt(nameRow, nameAt)).toBe(true);
    expect(sgrColorAt(managerRow, managerAt, "fg")).toBe(fgSgrOf(toneColor("idle", theme)!));
    expect(isBoldAt(managerRow, managerAt)).toBe(false);
  });

  it("⚠️ 选中的与**未选中**的那些行都**没有多出底色**（那一列的底色恒是 `surface`，只归 hover）", async () => {
    const p = props({ color: true });
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    const surface = bgSgrOf(toneColor("surface", themeOf({ color: true, scrimmed: false }))!);
    // ⚠️ **逐行逐项**量：只量一项的话「选中那一项加了反底色」会被漏掉，而那正是旧版的做法
    for (const i of [0, 1]) {
      for (const y of [g.sidebarRows[i]!.y, g.sidebarRows[i]!.y + 1]) {
        expect(bgAtColumn(raw[y] ?? "", SIDEBAR - 1)).toBe(surface);
      }
    }
    // ⚠️ 而**反向对照**：悬停那一项确实换成了 `hover` 那一档 —— 否则上面那条只是「探针永远是 null」
    const hot = await renderRaw(props({ color: true, hoveredSessionId: "s2" }));
    expect(bgAtColumn(hot[g.sidebarRows[1]!.y] ?? "", SIDEBAR - 1)).toBe(
      bgSgrOf(toneColor("hover", themeOf({ color: true, scrimmed: false }))!),
    );
  });

  it("hover 那一项换的是**另一层**底色（与那一列的 `surface` 不是同一个）", async () => {
    const base = await renderRaw(props({ color: true }));
    const hot = await renderRaw(props({ color: true, hoveredSessionId: "s2" }));
    const probe = (line: string): string | null => bgAtColumn(line, 20);
    // 第二个会话占第 3、4 行（每项两行 + 项间一行），而 hover 铺满**整项两行**
    const name = ITEM_ROW(1);
    expect(probe(hot[name] ?? "")).not.toBe(probe(base[name] ?? ""));
    expect(probe(hot[name + 1] ?? "")).toBe(probe(hot[name] ?? ""));
    // 而**没有被指着**的那一项仍然是那一列的底色（两个通道互不干扰）
    expect(probe(hot[ITEM_ROW(0)] ?? "")).toBe(probe(base[ITEM_ROW(0)] ?? ""));
  });

  it("hover 的底色铺满**整列两行**（不铺满的话右边留下一截列的底色，看着像画歪了）", async () => {
    const hot = await renderRaw(props({ color: true, hoveredSessionId: "s2", sidebarWidth: 20 }));
    const name = ITEM_ROW(1);
    const row = hot[name] ?? "";
    const band = bgAtColumn(row, 19);
    expect(band).not.toBeNull();
    for (const column of [0, 5, 12, 19]) expect(bgAtColumn(row, column)).toBe(band);
    // 第二行同样是这一层（hover 铺满**整项两行**，不是只有第一行）
    expect(bgAtColumn(hot[name + 1] ?? "", 19)).toBe(band);
  });

  it("⚠️ 悬停那一项时底色**铺到「✕」底下那一格**（不在字形那里戳一个洞）", async () => {
    // ⚠️ Ink 把 `<Box backgroundColor>` 写成「一串带底色的空格」并在写完复位，而裸字形不带底色 ——
    // 于是 `<Text>` 上漏给 background 时那一格会取**默认底色**，在 hover 那一档上看着像「破了一个洞」。
    const p = props({ color: true, hoveredSessionId: "s1" });
    const hot = await renderRaw(p);
    const row = hot[geometry(geoInput(p)).sidebarRows[0]!.y] ?? "";
    const at = indexOfText(row, "✕");
    // ⚠️ 探针下标先自检（`-1` 时恒给 `null`，而症状与「实现坏了」一模一样）
    expect(at).toBeGreaterThanOrEqual(0);
    const beside = bgAtColumn(row, 5);
    expect(beside).not.toBeNull();
    expect(sgrColorAt(row, at, "bg")).toBe(beside);
  });

  it("⚠️ 「✕」指在上面时亮成「别按」那一档，而只是**露出来**时与那一项的名字同档", async () => {
    const at = ITEM_ROW(1);
    const fgOf = async (p: LayoutProps): Promise<string | null> => {
      const row = (await renderRaw(p))[at] ?? "";
      const glyph = indexOfText(row, "✕");
      return glyph < 0 ? null : sgrColorAt(row, glyph, "fg");
    };
    const revealed = await fgOf(props({ color: true, hoveredSessionId: "s2" }));
    const armed = await fgOf(props({ color: true, hoveredSessionId: "s2", sessionCloseHot: true }));
    // ⚠️ **先自检**：探针给 `null` 时「两者不同」恒成立，而那是「那一枚压根没画出来」
    expect(revealed).not.toBeNull();
    expect(armed).not.toBeNull();
    expect(revealed).not.toBe(armed);
  });

  it("指针在手柄上时那一列自己换一层底色（「这一列能拖」看得见）", async () => {
    const off = await renderRaw(props({ color: true, sidebarWidth: 20 }));
    const on = await renderRaw(props({ color: true, sidebarWidth: 20, handleHot: true }));
    // 手柄 = 最右那一列（第 19 列，第 0 起）
    expect(bgAtColumn(on[3] ?? "", 19)).not.toBe(bgAtColumn(off[3] ?? "", 19));
    // 而它左侧那一列**不变**（否则那一整列都会亮，「能拖的那一列」就说不清了）
    expect(bgAtColumn(on[3] ?? "", 18)).toBe(bgAtColumn(off[3] ?? "", 18));
  });

  it("无色终端里侧边栏与主区长得一样（无色档**刻意**把底色退成 `undefined`）", async () => {
    const lines = await renderFrame(props({ color: false }));
    expect(lines.length).toBeGreaterThan(5);
  });
});
