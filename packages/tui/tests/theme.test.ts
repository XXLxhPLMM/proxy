/**
 * `@/ui/theme`（配色档）的纯函数断言
 *
 * **锁什么**（四条判据，全是「遮罩」那一条不变式的下半截）：
 * 1. **遮罩是那一层里最亮的一档**（浅 veil），而**卡片是最深的一档** —— 明暗差就是「浮在上面」；
 * 2. **遮罩期间背后那一层的前景七档全等**，且与遮罩只差一点点（这就是「基本只能看到后面一点」）；
 * 3. 遮罩态的**背景两档仍彼此可分**（侧边栏的列边界与悬停还在）；
 * 4. `PLAIN` 每档都是 `undefined`（无色终端里「不分级」而不是「换一套灰阶」）。
 *
 * ## 为什么要一个**纯函数**档
 * @description
 * 这一层零 React、零 Ink、零 `process.*`（`theme.ts` 的文件头），故上面四条能**逐字**断言。
 * ⚠️ 判据是**深浅**（三通道之和）而不是「两个 hex 不相等」—— 后者对「遮罩比背景还深」
 * 那种方向反了的实现**恒绿**，而那正是本档第 1 条要挡的东西。
 *
 * ## 变异实测记录（**四条全部转红**）
 *
 * | # | 变异 | 转红的判据 |
 * | --- | --- | --- |
 * | T1 | `scrim` 调成比 `surface` **深**的那一档 | ①「遮罩是最亮的一档」 |
 * | T2 | `panel` 调成比 `scrim` **浅**（浅卡片压在浅遮罩上） | ①「卡片是最深的一档」 |
 * | T3 | `veiled()` 少盖一档（`muted` 漏掉，于是它仍是原色） | ②「七档全等」 |
 * | T4 | `VEIL_TEXT` 调成与遮罩**同色**（背后一个字都看不见） | ②「与遮罩只差一点点」（差 0 ⇒ 恒看不见） |
 * | T5 | 遮罩态的 `hover` 与 `surface` 取成同一个值 | ③「背景两档仍可分」 |
 */

import { describe, expect, it } from "vitest";

import { themeOf, toneColor, type Theme, type Tone } from "@/ui/theme.js";

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

/** 前景七档（⚠️ `panel` / `panelHot` 不在其内：那是**卡片**那一层，不是背景） */
const FOREGROUNDS: readonly Tone[] = [
  "accent",
  "ok",
  "warn",
  "danger",
  "muted",
  "idle",
  "selected",
];

describe("配色：底色排成链，遮罩期间前景退成一档", () => {
  it("⚠️ 遮罩是那一层里**最亮**的一档（浅 veil —— 「背后变浅」才叫遮罩）", () => {
    const veil = depthOf("scrim", BEHIND);
    expect(Number.isNaN(veil)).toBe(false);
    for (const tone of ["surface", "hover", "panel", "panelHot"] as const) {
      expect(depthOf(tone, BEHIND)).toBeLessThan(veil);
    }
  });

  it("⚠️ 卡片是那一层里**最深**的一档（深卡片压在浅遮罩上，明暗差就是「浮起来」）", () => {
    const panel = depthOf("panel", BEHIND);
    expect(Number.isNaN(panel)).toBe(false);
    for (const tone of ["scrim", "surface", "hover", "panelHot"] as const) {
      expect(depthOf(tone, BEHIND)).toBeGreaterThan(panel);
    }
  });

  it("⚠️ 遮罩期间**前景七档全等**（逐档调淡 = 七档都还读得出来，那不叫遮罩）", () => {
    const first = hexOf(FOREGROUNDS[0]!, BEHIND);
    expect(first).not.toBeNull();
    for (const tone of FOREGROUNDS) expect(hexOf(tone, BEHIND)).toBe(first);
    // 而它们与**不带遮罩**的那一份全都不同（否则这条判据在「根本没盖」时也成立）
    for (const tone of FOREGROUNDS) expect(hexOf(tone, BEHIND)).not.toBe(hexOf(tone, CARD));
  });

  it("⚠️ 那一档前景与遮罩**只差一点点**（差 0 = 背后一个字都看不见，差太多 = 那不是遮罩）", () => {
    const gap = Math.abs(depthOf("muted", BEHIND) - depthOf("scrim", BEHIND));
    // ⚠️ 上下都钉死：这三条是「看起来很浅」与「还能看出那里有东西」之间的**全部**余地
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(120);
  });

  it("遮罩态的**背景两档仍彼此可分**（列的边界与悬停还在）", () => {
    expect(hexOf("hover", BEHIND)).not.toBe(hexOf("surface", BEHIND));
    // ⚠️ 方向也钉死：悬停必须**浅于**本列（与不带遮罩时同一条判据）
    expect(depthOf("hover", BEHIND)).toBeGreaterThan(depthOf("surface", BEHIND));
  });

  it("不带遮罩时**只有**背景两档的深浅关系是判据（`surface` < `hover`）", () => {
    expect(depthOf("hover", CARD)).toBeGreaterThan(depthOf("surface", CARD));
    // 而卡片那两档与遮罩无关 —— 两份主题里逐字相同
    expect(hexOf("panel", CARD)).toBe(hexOf("panel", BEHIND));
    expect(hexOf("panelHot", CARD)).toBe(hexOf("panelHot", BEHIND));
  });

  it("不上色时**每档都是 undefined**（灰阶仍会被读成「这里有分级」）", () => {
    const plain = themeOf({ color: false, scrimmed: false });
    const plainBehind = themeOf({ color: false, scrimmed: true });
    for (const tone of [...FOREGROUNDS, "surface", "hover", "scrim", "panel", "panelHot"] as const) {
      expect(toneColor(tone, plain)).toBeUndefined();
      expect(toneColor(tone, plainBehind)).toBeUndefined();
    }
  });
});