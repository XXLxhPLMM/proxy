/**
 * `@/theme` 的**记号**那一族：`runMarkOf`（侧边栏那一枚运行记号）逐字断言
 *
 * **这一档管哪一段**：语义 → **字形 + 色档** 的换算，以及它与 `connectionMark` / `toastMark` 的
 * 字形共用。⚠️ 主题级不变量（那一族真值表为什么这么定）与整张变异表在 **`AGENTS.md`**，
 * 这一档的文件头只留「管哪一段」—— 抄一遍就是两份各自腐烂。
 *
 * @module tests/theme
 */

import { describe, expect, it } from "vitest";

import {
  connectionMark,
  runMarkOf,
  themeOf,
  toastMark,
  toneColor,
  type Theme,
} from "@/theme/index.js";

/** 上色 + 不带遮罩的那一份（本档的基线：`ok` 档「真的偏绿」只在这一份上有意义） */
const CARD: Theme = themeOf({ color: true, scrimmed: false });

describe("运行记号：`run` 三档三对（字形 + 色档）+ 「跑完了而你还没看」那第四档", () => {
  /** 三个状态各自那一对（期望值现写 —— 它就是这张表） */
  const MARKS = [
    { run: "idle", glyph: " ", tone: "idle" },
    { run: "running", glyph: "⠋", tone: "accent" },
    { run: "done", glyph: "●", tone: "ok" },
  ] as const;

  it("⚠️ 三档各自给出**那一对**（字形 + 色档），而两档之间不许撞车", () => {
    // ⚠️ 入参**恒给 `seen: true`**：「你看没看」只对 `done` 那一档有话说，另两档答「与它无关」
    for (const one of MARKS) {
      expect(runMarkOf(one.run, true)).toEqual({ glyph: one.glyph, tone: one.tone });
    }
    // ⚠️ **色档两两不同**：撞车的话「跑完了」与「在跑」在**无色终端**上一样 —— 而那一层没有别的通道
    expect(new Set(MARKS.map((one) => one.tone)).size).toBe(MARKS.length);
    // ⚠️ **字形两两不同**（色盲与 `NO_COLOR` 环境下的第二通道）：`idle` 是一个空格而不是空串，
    // 所以「三个字形互不相同」正是「那一格恒存在」的那一半
    expect(new Set(MARKS.map((one) => one.glyph)).size).toBe(MARKS.length);
  });

  it("⚠️ `idle` 的字形是**一个空格而不是空串**（那一格恒存在，两帧的列位必须一样）", () => {
    const idle = runMarkOf("idle", true).glyph;
    expect(idle).toBe(" ");
    expect(idle.length).toBe(1);
  });

  it("⚠️ **「跑完了」是绿色的那个点**：色档取 `ok`，而 `ok` 那一档**真的偏绿**", () => {
    expect(runMarkOf("done", true).tone).toBe("ok");
    expect(runMarkOf("done", true).glyph).toBe("●");
    // ⚠️ 判据是「**绿通道最高**」而不是「等于某个 hex」：后者把配色档的字面量抄进这一档，
    // 而「改了配色忘了改这张表」那种事故正好被它挡住
    const hex = toneColor("ok", CARD)!;
    expect(hex).toMatch(/^#[\da-f]{6}$/u);
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    expect(g!).toBeGreaterThan(r!);
    expect(g!).toBeGreaterThan(b!);
  });

  it("⚠️ 那个字形与 {@link connectionMark} / {@link toastMark} 的「成功」**刻意共用**", () => {
    // ⚠️ 同一个字形在不同语境里必须指同一件事 —— 这条一旦漂了，操作者会把「已连接」读成「跑完了」
    expect(runMarkOf("done", true).glyph).toBe(connectionMark("connected").glyph);
    expect(runMarkOf("done", true).glyph).toBe(toastMark("ok").glyph);
  });

  it("换算只有这一个出口：三档各自的**色档**都真的落在那份主题上（不是查表查不到的值）", () => {
    for (const one of MARKS) {
      expect(toneColor(runMarkOf(one.run, true).tone, CARD)).not.toBeNull();
      expect(toneColor(runMarkOf(one.run, true).tone, CARD)).toBe(toneColor(one.tone, CARD));
    }
  });

  /**
   * 「跑完了但你没看」与「跑完了且看了」是**屏上要分得开的两件事**（判据 = `run === "done" && !seen`）
   *
   * @description ⚠️ **两条通道各自断言**：字形（`NO_COLOR` / 色盲那一层）与色档（有色那一层）。
   * ⚠️ 只断色档的话「两档同字形」的实现照样绿，而屏上无色时两者一模一样；只断字形的话
   * 「同一个字形配两档色」也照样绿 —— 而那一档在**色觉正常**的终端上仍读得出来，掩盖了形状缺失。
   */
  it("⚠️ 「跑完了但你没看」与「跑完了且看了」**字形与色档都不同**（两个通道各自成立）", () => {
    const seen = runMarkOf("done", true);
    const unread = runMarkOf("done", false);
    expect(unread.glyph).not.toBe(seen.glyph);
    expect(unread.tone).not.toBe(seen.tone);
    // ⚠️ **与另外两档也不撞车**（否則「没看」与「在跑」在无色终端上读起来一样）
    expect(unread.glyph).not.toBe(runMarkOf("running", false).glyph);
    expect(unread.tone).not.toBe(runMarkOf("running", false).tone);
    // ⚠️ **反向自检**：那一档**真的**是 `warn`（要你处理），而不是随手挑的一档 ——
    // 它的色值得真的落在那份主题上（查表查不到时 `toneColor` 给 `undefined`）
    expect(unread.tone).toBe("warn");
    expect(toneColor(unread.tone, CARD)).toBe(toneColor("warn", CARD));
    // ⚠️ **正向对照**：`run` 三档**一个字都没少**（`seen` 只对 `done` 那一档有话说）
    expect(runMarkOf("idle", false)).toEqual(runMarkOf("idle", true));
    expect(runMarkOf("running", false)).toEqual(runMarkOf("running", true));
  });
});