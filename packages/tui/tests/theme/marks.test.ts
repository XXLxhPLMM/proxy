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

describe("运行记号：三档三对（字形 + 色档），「跑完了」是 `ok` 那一档绿", () => {
  /** 三个状态各自那一对（期望值现写 —— 它就是这张表） */
  const MARKS = [
    { run: "idle", glyph: " ", tone: "idle" },
    { run: "running", glyph: "⠋", tone: "accent" },
    { run: "done", glyph: "●", tone: "ok" },
  ] as const;

  it("⚠️ 三档各自给出**那一对**（字形 + 色档），而两档之间不许撞车", () => {
    for (const one of MARKS) {
      expect(runMarkOf(one.run)).toEqual({ glyph: one.glyph, tone: one.tone });
    }
    // ⚠️ **色档两两不同**：撞车的话「跑完了」与「在跑」在**无色终端**上一样 —— 而那一层没有别的通道
    expect(new Set(MARKS.map((one) => one.tone)).size).toBe(MARKS.length);
    // ⚠️ **字形两两不同**（色盲与 `NO_COLOR` 环境下的第二通道）：`idle` 是一个空格而不是空串，
    // 所以「三个字形互不相同」正是「那一格恒存在」的那一半
    expect(new Set(MARKS.map((one) => one.glyph)).size).toBe(MARKS.length);
  });

  it("⚠️ `idle` 的字形是**一个空格而不是空串**（那一格恒存在，两帧的列位必须一样）", () => {
    const idle = runMarkOf("idle").glyph;
    expect(idle).toBe(" ");
    expect(idle.length).toBe(1);
  });

  it("⚠️ **「跑完了」是绿色的那个点**：色档取 `ok`，而 `ok` 那一档**真的偏绿**", () => {
    expect(runMarkOf("done").tone).toBe("ok");
    expect(runMarkOf("done").glyph).toBe("●");
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
    expect(runMarkOf("done").glyph).toBe(connectionMark("connected").glyph);
    expect(runMarkOf("done").glyph).toBe(toastMark("ok").glyph);
  });

  it("换算只有这一个出口：三档各自的**色档**都真的落在那份主题上（不是查表查不到的值）", () => {
    for (const one of MARKS) {
      expect(toneColor(runMarkOf(one.run).tone, CARD)).not.toBeNull();
      expect(toneColor(runMarkOf(one.run).tone, CARD)).toBe(toneColor(one.tone, CARD));
    }
  });
});