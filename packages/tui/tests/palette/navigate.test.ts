/**
 * 在面板上按一次键之后它变成什么：`paletteFill` / `paletteStep` / `paletteWindow`。
 *
 * @description
 * 四条不变量的后两只（④补完只换命令名那一段而形参与光标原样留着 / ⑤`↑``↓` 不循环而滚窗保证高亮可见）。
 * ⚠️ ④是**同一个实现**被 `↑`/`↓`/`Tab`/鼠标点四处共用，于是少改会把形参吃掉、多改会把前缀写两遍
 * （`//status` —— 而它恰好还能被 `parseLine` 拒掉，症状看着像解析器的锅）；⑤的牙齿是「到头停住」与
 * 「窗口夹住而不跟着高亮滚」。
 *
 * 四条不变量与 N1–N29 / M1–M22 变异实测表见本目录 `AGENTS.md`。
 *
 * @module tests/palette
 */

import { describe, expect, it } from "vitest";

import {
  PALETTE_ROWS,
  paletteFill,
  paletteStep,
  paletteWindow,
} from "@/commands/palette.js";

/* ── ④ 一个补全实现，四处共用 ───────────────────────────────────────────── */

describe("不变量 ④：`paletteFill` 只换命令名那一段，形参与光标位置都保住", () => {
  /** 取面板里的某一行（按名字找，锚在**给人看的**那一串上） */
  function rowNamed(path: string): (typeof PALETTE_ROWS)[number] {
    const row = PALETTE_ROWS.find((one) => one.path === path);
    if (row === undefined) throw new Error(`面板里没有 ${path}`);
    return row;
  }

  it("光标在命令名中间：换掉**整个**命令名段（含光标后面的字）", () => {
    // ⚠️ `/user ad|d alice` → `/user add alice`：尾部的形参**原样留着**
    const filled = paletteFill("/user add alice", 8, rowNamed("/user add"));
    expect(filled.line).toBe("/user add alice");
    expect(filled.cursor).toBe("/user add".length);
  });

  it("⚠️ 尾部形参一个字节都不许动（变异：改成替换整行 → 这里红）", () => {
    const filled = paletteFill("/st alice 1g", 3, rowNamed("/status"));
    expect(filled.line).toBe("/status alice 1g");
    const other = paletteFill("/zzz keep-me", 4, rowNamed("/target switch"));
    expect(other.line).toBe("/target switch keep-me");
  });

  it("两段命令名的补完**补一个尾随空格**，单段的**不补**", () => {
    // ⚠️ 不补空格的话操作者接着敲形参会粘在名字后面（`/user addalice`），那是一个**静默**
    // 的参数错误；而给单段的补空格会让面板多出「补一次就关掉」的手感。
    expect(paletteFill("/", 1, rowNamed("/user add")).line).toBe("/user add ");
    expect(paletteFill("/", 1, rowNamed("/status")).line).toBe("/status");
    expect(PALETTE_ROWS.find((one) => one.path === "/user add")?.needsSpace).toBe(true);
    expect(PALETTE_ROWS.find((one) => one.path === "/status")?.needsSpace).toBe(false);
  });

  it("补完的光标落在刚写进去的那一段**之后**", () => {
    expect(paletteFill("/", 1, rowNamed("/acl")).cursor).toBe("/acl".length);
    expect(paletteFill("/", 1, rowNamed("/target switch")).cursor).toBe(
      "/target switch ".length,
    );
  });

  it("⚠️ 补进去的**不许**把前缀写两遍（变异：直接拼 `row.path` → 这里红）", () => {
    // `row.path` 是**给人看**的那一串（带前缀），而写进行内时前缀由 `COMMAND_PREFIX` 写一次。
    // 拼两次的结果是 `//status` —— 而它**恰好**还能被 `parseLine` 拒掉，于是症状是「补完之后
    // 回车说不认识命令」，看起来像解析器的锅。
    for (const row of PALETTE_ROWS) {
      const filled = paletteFill("/", 1, row);
      expect(filled.line.startsWith("//")).toBe(false);
      const name = row.path.slice(1);
      expect(filled.line.slice(1, 1 + name.length)).toBe(name);
    }
  });
});

/* ── ⑤ `↑`/`↓` 与滚动窗口 ───────────────────────────────────────────────── */

describe("不变量 ⑤：`↑`/`↓` 不循环，而滚动窗口保证高亮可见", () => {
  it("到头停住（不循环）", () => {
    expect(paletteStep(0, -1, 5)).toBe(0);
    expect(paletteStep(4, 1, 5)).toBe(4);
  });

  it("⚠️ 没有高亮时 `↓` 到第一行、`↑` 到最后一行（变异：返回 `-1` → 这里红）", () => {
    // 「敲了一个表里没有的东西之后按 `↓` 永远没反应」，而那恰好是最需要面板给点提示的时刻
    expect(paletteStep(-1, 1, 5)).toBe(0);
    expect(paletteStep(-1, -1, 5)).toBe(4);
    expect(paletteStep(-1, 1, 0)).toBe(-1);
  });

  it("窗口：装得下就是 0，装不下就把高亮**顶进**视口（而不是 clamp 首行号）", () => {
    expect(paletteWindow(0, 10, 5)).toBe(0);
    expect(paletteWindow(4, 10, 5)).toBe(0);
    // ⚠️ 高亮在视口里就不滚（移动最少的那一个）
    expect(paletteWindow(3, 10, 19)).toBe(0);
    expect(paletteWindow(9, 10, 19)).toBe(0);
    expect(paletteWindow(10, 10, 19)).toBe(1);
    expect(paletteWindow(18, 10, 19)).toBe(9);
    // 末行之后不许露出空行
    expect(paletteWindow(999, 10, 19)).toBe(9);
    expect(paletteWindow(0, 0, 19)).toBe(0);
  });

  it("⚠️ `at` 越界也得能用（变异：先夹 `at` 再算窗口 → 这里红）", () => {
    // 判据是「返回的首行号仍然让高亮落在视口里」这件事，不是「某个具体数字」——
    // 后者对「恒返回 0」绿，而那正是那个 bug 的形状。
    for (const at of [-5, -1, 0, 7, 18, 999]) {
      const start = paletteWindow(at, 6, 19);
      const clampedAt = Math.min(Math.max(at, 0), 18);
      expect(clampedAt).toBeGreaterThanOrEqual(start);
      expect(clampedAt).toBeLessThan(start + 6);
    }
  });
});