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

import {
  selectionInk,
  themeOf,
  toneColor,
  type Theme,
  type Tone,
} from "@/theme/index.js";

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

/** 背景**五**档（加进用户消息那一块；⚠️ 它**不在那条链上** —— 它是内容而不是版式，判据在下面那一条） */
const BACKDROPS: readonly Tone[] = [...BACKGROUNDS, "bubble"];

/** 这一轮加的两档（⚠️ `reasoning` **刻意与 `warn` 同值** ⇒ 它不进「两两不同」那个集合，见下面那一条） */
const ADDED: readonly Tone[] = ["bubble", "reasoning"];

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
    for (const tone of [...FOREGROUNDS, ...BACKDROPS, "reasoning"] as const) {
      expect(toneColor(tone, plain)).toBeUndefined();
      expect(toneColor(tone, plainBehind)).toBeUndefined();
    }
  });
});

/** 加档那一族：用户消息的底色与推理强度那一档（⚠️ 加第五档底色的前提是「屏上有一件事要靠它分」） */
describe("加的两档：三份表里都在，遮罩态**压到读不出来**且与另外那些档**两两不同**", () => {
  const plain = themeOf({ color: false, scrimmed: false });

  it("⚠️ 三份表里**都在**（漏 `PLAIN` 或漏 `COLORED` 的话那一档在某一档终端上根本取不到值）", () => {
    for (const tone of ADDED) {
      // ⚠️ 正向对照：老的那几档在同一份表里都取得到值（否则这一条会因「全都没值」而恒绿）
      expect(toneColor(tone, CARD)).toMatch(/^#[\da-f]{6}$/u);
      expect(toneColor("accent", CARD)).toMatch(/^#[\da-f]{6}$/u);
      // ⚠️ 无色档归 `undefined`（灰阶仍会被读成「这里有分级」）
      expect(toneColor(tone, plain)).toBeUndefined();
    }
  });

  it("⚠️ **三份表的键集都等于全部档位**（漏写一格 ⇒ 那一档在这份表里**根本没有那个键**）", () => {
    // ⚠️ **只判「取出来是 undefined」会恒绿**：漏写一格时 `theme[tone]` 同样是 `undefined`，
    // 而「值是 undefined」与「键不存在」在屏上一样、在**类型上却不一样**（后者漏掉了一档的承诺）。
    // 故这里量的是**键集**，不是值。
    // ⚠️ **去重**（`bubble` 既是背景那一族又是加的那一族，不去重的话期望值里会多一个）
    const wanted = [...new Set<Tone>([...FOREGROUNDS, ...BACKDROPS, ...ADDED])].sort();
    const keysOf = (theme: Theme): string[] => Object.keys(theme).sort();
    for (const theme of [CARD, BEHIND, plain, themeOf({ color: false, scrimmed: true })]) {
      expect(keysOf(theme)).toEqual(wanted);
    }
  });

  it("⚠️ 两档在遮罩态**与另外那些档两两不同**（加一档不许把语义分层压塌 —— 「两两不同」是本层的头号不变量）", () => {
    // ⚠️ 判据是「**逐档**比而不是「相邻两档不同」」：后者放过「1 = 2、2 = 3」那种塌法。
    // ⚠️ **刻意同值的那一族先划出来**：`reasoning` 与 `warn` 渲染成同一个颜色是**结论**
    // （两处语境、屏上从不相邻），把它算成撞车的话这条判据就再也不会红。
    const familyOf = (tone: Tone): readonly Tone[] =>
      tone === "warn" || tone === "reasoning" ? ["warn", "reasoning"] : [tone];
    for (const tone of ADDED) {
      const family = familyOf(tone);
      const others: readonly Tone[] = [...FOREGROUNDS, ...BACKDROPS, ...ADDED].filter(
        (one) => !family.includes(one),
      );
      // ⚠️ 正向对照：它自己**取得到值**（下面那些比较若全在比 `null` 就是恒绿）
      expect(hexOf(tone, BEHIND)).not.toBeNull();
      for (const other of others) {
        expect(hexOf(tone, BEHIND)).not.toBe(hexOf(other, BEHIND));
      }
    }
  });

  // ⚠️ 判据只比**深浅**（深度和），理由见文件头 —— 与「两个 hex 不相等」不是同一条东西。
  it("⚠️ 用户消息的底色是**背景**且遮罩期间压到读不出来（与卡片那两条判据同形）", () => {
    const plain2 = depthOf("bubble", CARD);
    expect(Number.isNaN(plain2)).toBe(false);
    // ⚠️ **正向对照**：遮罩那一层比卡片深，而卡片比遮罩亮（老的两条判据，判据形状一样）
    expect(depthOf("panel", BEHIND)).toBeGreaterThan(depthOf("scrim", BEHIND));
    expect(depthOf("hover", CARD)).toBeGreaterThan(depthOf("surface", CARD));
    // ⚠️ **它比卡片亮**（它是一块内容而不是一层版式 —— 版式那条链是 `surface` < `hover` < `panel`）
    expect(plain2).toBeGreaterThan(depthOf("panel", CARD));
    // ⚠️ **遮罩期间它被压到与遮罩只差至多一成**：与「每档前景都被压过」那条同一道判据
    const veil = depthOf("scrim", BEHIND);
    expect(depthOf("bubble", BEHIND) - veil).toBeLessThanOrEqual(
      Math.ceil((plain2 - veil) * 0.1) + 2,
    );
  });

  it("⚠️ 推理强度那一档是**前景**：它**刻意与 `warn` 同值**而独立成档（两处语境，不相邻）", () => {
    // ⚠️ **正向对照**：「它是被压过的」与「它没被压过」两种实现必须分得开 —— 判据是压暗前后**不同**
    expect(hexOf("reasoning", BEHIND)).not.toBe(hexOf("reasoning", CARD));
    expect(hexOf("warn", BEHIND)).not.toBe(hexOf("warn", CARD));
    // ⚠️ 同值是**结论**（那一行是橙的，与「要你处理」同一个橙），判据写成同值而不是抄字面量
    expect(hexOf("reasoning", CARD)).toBe(hexOf("warn", CARD));
    // ⚠️ 遮罩期间仍然同值 —— 两条走同一个系数，而同系数 + 同原色必然同结果
    expect(hexOf("reasoning", BEHIND)).toBe(hexOf("warn", BEHIND));
  });

  // ⚠️ 这一族是「语义 → 字形 / 色档」真值表的第四张，故它的牙齿与前三张同处一个 `describe`。
  it("⚠️ 选区是**真反色**：底色那一档与字色那一档**明暗相反**（同色 = 选中的字看不见）", () => {
    const ink = selectionInk();
    // ⚠️ **正向对照**：「它是一对**不同**的档」与「它退化成同一个档」必须分得开
    expect(ink.background).not.toBe(ink.foreground);
    // ⚠️ 判据是**深浅相反**而不是「两个 hex 不相等」：选区是整块反色，两档明暗同向的话
    // 字仍然读不出来（亮底浅字）—— 而那正是本条要挡的实现
    const plainBg = depthOf(ink.background, CARD);
    const plainFg = depthOf(ink.foreground, CARD);
    expect(Number.isNaN(plainBg) || Number.isNaN(plainFg)).toBe(false);
    expect(plainBg).toBeGreaterThan(plainFg);
    // ⚠️ 换算只有这一个出口：两次调用给出**同一对**（表是唯一真相，两处各算一次就会漂）
    expect(selectionInk()).toEqual(ink);
  });
});
