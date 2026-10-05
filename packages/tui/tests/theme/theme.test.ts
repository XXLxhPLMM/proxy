/**
 * `@/theme`（配色档）的**遮罩**那一段：底色那条链 + 压暗幅度
 *
 * **这一档管哪一段**：`themeOf` 取出来的那份主题里，**遮罩态**的底色链与前景压暗。
 * ⚠️ 主题级不变量（输出逐字唯一 / 底色四档 / 语义 → 字形是第二通道）与整张变异表在 **`AGENTS.md`** ——
 * 这一档的文件头只留「管哪一段」，抄一遍就是两份各自腐烂。
 *
 * ⚠️ 判据是**深浅**（三通道之和）而不是「两个 hex 不相等」—— 后者对「遮罩比卡片还深」
 * 那种方向反了的实现**恒绿**，而那正是本档要挡的东西。
 *
 * @module tests/theme
 */

import { describe, expect, it } from "vitest";

import { themeOf, toneColor, type Theme, type Tone } from "@/theme/index.js";

/** 上色 + 不带遮罩的那一份（本档的基线） */
const CARD: Theme = themeOf({ color: true, scrimmed: false });
/** 上色 + 带遮罩的那一份 */
const BEHIND: Theme = themeOf({ color: true, scrimmed: true });

/** `#rrggbb` → 三通道之和（**只比大小**，不比色相；理由见文件头） */
function depthOf(tone: Tone, theme: Theme): number {
  const hex = toneColor(tone, theme);
  if (hex === undefined) return Number.NaN;
  const packed = Number.parseInt(hex.slice(1), 16);
  return ((packed >> 16) & 0xff) + ((packed >> 8) & 0xff) + (packed & 0xff);
}

/** 那一档在**这一份**主题里取到的那个 hex（`null` = 不上色） */
function hexOf(tone: Tone, theme: Theme): string | null {
  return toneColor(tone, theme) ?? null;
}

/** 前景七档（⚠️ `panel` 不在其内：那是**卡片**那一层，不是背景） */
const FOREGROUNDS: readonly Tone[] = [
  "accent",
  "ok",
  "warn",
  "danger",
  "muted",
  "idle",
  "selected",
];

/** 背景四档（⚠️ 它们构成**一条链**，判据在下面那条链上） */
const BACKGROUNDS: readonly Tone[] = ["scrim", "surface", "hover", "panel"];

describe("配色：底色排成链（**遮罩最深、卡片次之**），遮罩期间前景被压到读不出来", () => {
  it("⚠️ 遮罩是那一层里**最深**的一档（极暗 veil —— 「背后变暗」才叫遮罩）", () => {
    const veil = depthOf("scrim", BEHIND);
    expect(Number.isNaN(veil)).toBe(false);
    for (const tone of BACKGROUNDS) {
      if (tone === "scrim") continue;
      expect(depthOf(tone, BEHIND)).toBeGreaterThan(veil);
    }
  });

  it("⚠️ 卡片比遮罩**亮**（卡片浮在遮罩上，明暗差就是「压在上面」）", () => {
    expect(depthOf("panel", BEHIND)).toBeGreaterThan(depthOf("scrim", BEHIND));
  });

  it("⚠️ 四档底色在遮罩态排成**一条链**（判据不是审美：`scrim` < `surface` < `hover` < `panel`）", () => {
    const chain = BACKGROUNDS.map((tone) => depthOf(tone, BEHIND));
    expect(chain).toEqual([...chain].sort((a, b) => a - b));
    // ⚠️ **逐段都真的有差距**：只有「单调」而某两档相等的话那条链其实少了一档
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i]! - chain[i - 1]!).toBeGreaterThan(0);
    }
  });

  it("⚠️ 遮罩期间**每一档前景都被压过**（漏压一档 = 那一档在遮罩下仍然完全可读）", () => {
    for (const tone of FOREGROUNDS) {
      expect(hexOf(tone, BEHIND)).not.toBeNull();
      expect(hexOf(tone, BEHIND)).not.toBe(hexOf(tone, CARD));
    }
  });

  // ⚠️ 「近乎不可读」的**唯一**定义是「与遮罩几乎同色」：差距至多一成，于是对比度恒在 1.1:1 上下，
  // 而那正是「屏上有一个形状但读不出字」。差 0 ⇒ 背后一个字都没有，差太多 ⇒ 那不是遮罩。
  it("⚠️ 每一档前景与遮罩**只差至多一成**（差 0 = 背后一个字都没有，差太多 = 那不是遮罩）", () => {
    const veil = depthOf("scrim", BEHIND);
    // ⚠️ 三通道**各自**四舍五入，故深度和的误差至多 1.5 —— 那 2 是取整的余量，不是放水
    const rounding = 2;
    for (const tone of FOREGROUNDS) {
      const plain = depthOf(tone, CARD);
      const veiled = depthOf(tone, BEHIND);
      expect(veiled).toBeGreaterThan(veil);
      // ⚠️ 判据是「压过去之后的那一档」而不是「压的系数」：系数是实现，差距是不变量
      expect(veiled - veil).toBeLessThanOrEqual(Math.ceil((plain - veil) * 0.1) + rounding);
    }
  });

  // ⚠️ **七档两两不同**：遮罩负责「读不出来」，而「两个事实不许渲染成同一个东西」是本层的另一条
  // 不变量 —— 压暗之后两者在暗遮罩上不冲突（旧版的亮遮罩上才冲突，于是那一版只能压成一档）。
  it("⚠️ 遮罩态的前景**七档两两不同**（同色 = 语义分层在遮罩下消失）", () => {
    const hexes = FOREGROUNDS.map((tone) => hexOf(tone, BEHIND));
    expect(hexes.every((hex) => hex !== null)).toBe(true);
    // ⚠️ 判据是「**去重之后**的个数 == 档数」而不是「相邻两档不同」：后者放过「1 = 2、2 = 3」那种塌法
    expect(new Set(hexes).size).toBe(FOREGROUNDS.length);
  });

  it("遮罩态的**背景两档仍彼此可分**（列的边界与悬停还在，方向也不变）", () => {
    expect(hexOf("hover", BEHIND)).not.toBe(hexOf("surface", BEHIND));
    expect(depthOf("hover", BEHIND)).toBeGreaterThan(depthOf("surface", BEHIND));
  });

  it("不带遮罩时**只有**背景两档的深浅关系是判据（`surface` < `hover`）", () => {
    expect(depthOf("hover", CARD)).toBeGreaterThan(depthOf("surface", CARD));
    // 而卡片那一档与遮罩无关 —— 两份主题里逐字相同
    expect(hexOf("panel", CARD)).toBe(hexOf("panel", BEHIND));
  });

  it("不上色时**每档都是 undefined**（灰阶仍会被读成「这里有分级」）", () => {
    const plain = themeOf({ color: false, scrimmed: false });
    const plainBehind = themeOf({ color: false, scrimmed: true });
    for (const tone of [...FOREGROUNDS, ...BACKGROUNDS] as const) {
      expect(toneColor(tone, plain)).toBeUndefined();
      expect(toneColor(tone, plainBehind)).toBeUndefined();
    }
  });
});
