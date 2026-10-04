/**
 * 四条体量上限：判据 1 / 2 / 3 / 4 作用在**本包 `src/` 的真实语料**上。
 *
 * @description
 * 四条上限**是同一个判据形状作用在不同输入上**，故它们同属一档：语料遍历一次、逐条算行数、
 * 把超限的那几条列出来。四条各自的上限（6 / 3 / 12 / 3）各有各的理由，拆开就是四份各带一个
 * 用例的碎片，而碎片之间没有独立含义。
 *
 * - **判据 1**：每个源文件的**头部**（第一段注释块 + 紧随其后的 `//` 行）≤ 6 行。
 * - **判据 2**：**barrel** 的头部 ≤ 3 行。作用面必须由 `isBarrel` 收窄 —— 判据写反过一次，
 *   留下的恰好是**非 barrel**，于是它实际变成了「所有文件 ≤3 行」而真正的 barrel 永远不被列出。
 * - **判据 3**：**单个**注释块 ≤ 12 行（长推导属于 `AGENTS.md`，不属于代码）。
 * - **判据 4**：含 `⚠` 的注释块 ≤ 3 行（一个 `⚠` 只讲一件事）。
 *
 * 探测器本身与扫描面空不空不归本档（`detector.test.ts`）；判据为什么是行数、为什么只管体量
 * 不管对错，见 `AGENTS.md`。
 *
 * @module tests/comment-budget
 */

import { describe, expect, it } from "vitest";
import { SRC, commentBlocks, headCommentLines, isBarrel } from "./_shared.js";

describe("1 判据：文件头不超过 6 行", () => {
  it("每个源文件的头部注释都在上限内", () => {
    const over = SRC.map(([name, text]) => {
      const n = headCommentLines(text.split(/\r?\n/));
      return n > 6 ? `${name}: 头部 ${n} 行` : null;
    }).filter((x): x is string => x !== null);
    expect(
      over,
      `文件头超过 6 行（判据：头部是「一个不变量」，不是一段论文）：\n${over.join("\n")}\n\n` +
        "修法：留 @fileoverview 一句 + 最多一条「为什么不一样」；推导过程搬进 packages/tui/AGENTS.md 或删掉。",
    ).toEqual([]);
  });
});

describe("2 判据：barrel 的注释不超过 3 行", () => {
  it("判据只作用在 barrel 上（判据写反过一次，这条钉住作用面）", () => {
    // 曾经写成 `!isBarrel(...) || head <= 3` —— 留下的恰好是**非 barrel**，
    // 于是这条判据实际变成了「所有文件 ≤3 行」，而真正的 barrel 永远不会被列出。
    const impl = ["/**", " * a", " * b", " * c", " * d", " */", "export const a = 1;"];
    const barrel = ["/**", " * a", " * b", " * c", " * d", " */", 'export { x } from "./x.js";'];
    expect(isBarrel(impl)).toBe(false);
    expect(isBarrel(barrel)).toBe(true);
    expect(headCommentLines(impl)).toBeLessThanOrEqual(6);
  });

  it("本包今天真的有一批 barrel（否则这条判据作用在空集上）", () => {
    const barrels = SRC.filter(([, text]) => isBarrel(text.split(/\r?\n/))).map(([n]) => n);
    expect(barrels.length).toBeGreaterThanOrEqual(8);
    expect(barrels).toContain("api/index.ts");
    expect(barrels).toContain("components/index.ts");
  });

  it("每个 barrel 的注释都在上限内", () => {
    const over = SRC.filter(([, text]) => isBarrel(text.split(/\r?\n/)))
      .map(([name, text]) => {
        const n = headCommentLines(text.split(/\r?\n/));
        return n > 3 ? `${name}: 头部 ${n} 行` : null;
      })
      .filter((x): x is string => x !== null);
    expect(
      over,
      `barrel 的注释超过 3 行：\n${over.join("\n")}\n\n` +
        "修法：barrel 只许说「这个目录答什么」一句；层不变量搬进该目录的 AGENTS.md。",
    ).toEqual([]);
  });
});

describe("3 判据：单个注释块不超过 12 行", () => {
  it("正文里没有超过上限的注释块（长推导属于 AGENTS.md，不属于代码）", () => {
    const over = SRC.flatMap(([name, text]) => {
      const lines = text.split(/\r?\n/);
      return commentBlocks(lines)
        .filter((b) => b.lines.length > 12)
        .map((b) => `${name}:${b.at}: 注释块 ${b.lines.length} 行`);
    });
    expect(
      over,
      `单个注释块超过 12 行：\n${over.join("\n")}\n\n` +
        "修法：一条注释只说一条不变量；多条的场合拆成相邻的几条短注释。",
    ).toEqual([]);
  });
});

describe("4 判据：⚠️ 警告不许超过 3 行", () => {
  it("没有超过上限的 ⚠️ 注释块（一个 ⚠️ 讲一件事）", () => {
    const over = SRC.flatMap(([name, text]) => {
      const lines = text.split(/\r?\n/);
      return commentBlocks(lines)
        .filter((b) => b.lines.length > 3 && b.lines.some((l) => l.includes("⚠")))
        .map((b) => `${name}:${b.at}: ${b.lines.length} 行`);
    });
    expect(
      over,
      `⚠️ 注释超过 3 行：\n${over.slice(0, 40).join("\n")}\n\n` +
        "修法：⚠️ 只留「反例是什么」，删掉「而那正是我们要防的事故本身」这类铺陈。",
    ).toEqual([]);
  });
});