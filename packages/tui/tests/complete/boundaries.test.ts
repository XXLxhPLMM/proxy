/**
 * 退化输入：位置不在闭合集里、以及光标坐标畸形时的那一份答案。
 *
 * @description
 * 两件事共用同一个前提 —— **输入落在正常形态之外时，正确答案仍然是确定的，且绝不瞎猜**：
 *
 * - **位置不在表里 ⇒ 零候选**（用量名格 / 形参用满 / 第一段不认识 / 组不存在之后的第一段不认识）。
 *   一个空列表在界面上看不出是「没有」还是「有但没匹配」，所以这一档逐个位置钉住「恒空」。
 * - **坐标越界 ⇒ 夹住，不抛**（行尾之后、行首之前、`NaN`、`±∞`、小数）。夹的职责是「不崩」，
 *   而**不是**「凑一个答案」：夹到行首之前时那一格连命令名都还没开始敲，给候选就是在诱导。
 *
 * ⚠️ **前缀那道闸钉在「光标在行尾」的那一行上**：空输入行上取消那道闸仍然给零候选（命令名不归
 * 补全层，而空行光标就在 0 处），于是一个「前缀闸可以删」的结论会从那些用例上溜过去。
 *
 * 「该出候选的位置」不归本档（`candidates.test.ts`），「补完之后那一行长什么样」也不归
 * （`line-output.test.ts`）。目录级不变量见 `AGENTS.md`。
 *
 * @module tests/complete
 */

import { describe, expect, it } from "vitest";
import { complete } from "@/commands/complete.js";
import { NAMES, at, cands } from "./_shared.js";

/* ── 没有候选的那些位置 ─────────────────────────────────────────────────── */

describe("没有候选的那些位置：返回空列表，不瞎猜", () => {
  it("用量名与用户名：本层手里没有账号清单", () => {
    expect(cands("usage |")).toEqual([]);
    expect(cands("config |")).toEqual([]);
  });

  it("⚠️ 值那一格**不给**任何候选（那是用户自己知道的东西）", () => {
    // `/batch` 的第二格是 `rest`：它吃下剩下的原文，而光标落在它上面时一个候选都不给
    expect(cands("batch all |")).toEqual([]);
    expect(cands("help status |")).toEqual([]);
  });

  it("命令已经用满了形参：后面再多一个词也不提候选", () => {
    expect(cands("status |")).toEqual([]);
    expect(cands("clear extra |")).toEqual([]);
    expect(cands("usage alice |")).toEqual([]);
  });

  it("第一段就不认识：整行已经错了，不提任何候选", () => {
    expect(cands("nope |")).toEqual([]);
    expect(cands("nope su|")).toEqual([]);
    // ⚠️ 表里没有组，于是「一个存在的组 + 不存在的子命令」那种形状**也不存在**了：
    // `/user` 本身就是不认识的第一段（它是一个被删掉的命令）
    expect(cands("user |")).toEqual([]);
  });

  it("没有候选时那一行**逐字不变**（一次「按了 Tab 什么都没发生」是可观察的）", () => {
    const line = "/help status extra";
    const result = complete({ line, cursor: line.length });
    expect(result.candidates).toEqual([]);
    expect(result.line).toBe(line);
    expect(result.cursor).toBe(line.length);
  });
});

/* ── 边界 ───────────────────────────────────────────────────────────────── */

describe("光标越界：夹住，不抛", () => {
  it("光标在行尾之后按行尾算", () => {
    const result = complete({ line: "/status", cursor: 999 });
    expect(result.candidates).toEqual([]);
    expect(result.line).toBe("/status");
    expect(result.cursor).toBe(7);
  });

  it("光标在行首之前当 0，而 0 处**还没有成型的行**（一个候选都不给）", () => {
    // ⚠️ 夹到 0 之后光标落在前缀 `/` **之前** —— 那一格连「命令名」都还没开始敲，
    // 给候选就是在一个注定要改的行上诱导。夹的职责是「不抛」，不是「凑一个答案」。
    const result = complete({ line: "/status", cursor: -3 });
    expect(result.candidates).toEqual([]);
    expect(result.line).toBe("/status");
    expect(result.cursor).toBe(0);
  });

  it("非有限坐标：NaN 当 0，+∞ 当行尾（`NaN` 落进 `slice` 会静默变成 0 那一侧）", () => {
    const nan = complete({ line: "/batch ", cursor: Number.NaN, targetNames: NAMES });
    expect(nan.candidates).toEqual([]);
    expect(nan.line).toBe("/batch ");
    expect(nan.cursor).toBe(0);
    const inf = complete({ line: "/status", cursor: Number.POSITIVE_INFINITY });
    expect(inf.line).toBe("/status");
    expect(inf.cursor).toBe(7);
    expect(complete({ line: "/status", cursor: Number.NEGATIVE_INFINITY }).line).toBe("/status");
  });

  it("小数坐标夹成整数", () => {
    // 2.7 → 2（还在命令名中间 ⇒ 一个候选都不给），7.5 → 7（落在行尾那个空白上 ⇒ 那一格）
    expect(complete({ line: "/batch ", cursor: 2.7 }).candidates).toEqual([]);
    expect(complete({ line: "/batch ", cursor: 7.5, targetNames: NAMES }).candidates).toEqual([
      "dev",
      "prod",
      "staging",
    ]);
  });

  it("⚠️ 空行 / 不带前缀的行：一个候选都不给（变异：去掉前缀那道闸 → 这里红）", () => {
    // 这两条**曾经**会给 10 个第一段命令名，于是**空输入行**上凭空浮出一截幽灵文本与一句
    // 「Tab 补全：acl clear …」。而那正是「底部那条提示栏一直列着有哪些命令」的来源。
    expect(complete({ line: "", cursor: 0 }).candidates).toEqual([]);
    expect(complete({ line: "", cursor: 0 }).line).toBe("");
    expect(complete({ line: "st", cursor: 2 }).candidates).toEqual([]);
    expect(complete({ line: "/", cursor: 1 }).candidates).toEqual([]);
    // ⚠️ **这一条才真的咬住那道闸**：前面几条去掉闸门之后仍然给零候选（命令名不归本层，
    // 而空行光标就在 0 处），于是一个「前缀那道闸可以删」的结论会从它们上溜过去。
    // 而这里光标在行尾 —— 不带 `/` 的多词行本来能拿到台账名字候选。
    expect(complete({ line: "batch ", cursor: 6 }).candidates).toEqual([]);
    expect(complete({ line: "help ", cursor: 5 }).candidates).toEqual([]);
    // ⚠️ **退格删掉那个 `/` 之后**的那一行（`" batch "`）：去掉闸门之后
    // `line.slice(1, …)` 恰好把 `batch` 放回第一段，于是**真的会**给出三个台账名字 ——
    // 症状是「我明明删了斜杠，补全还在按 `/batch` 给候选」。
    expect(complete({ line: " batch ", cursor: 7, targetNames: NAMES }).candidates).toEqual([]);
  });

  it("多个空格 / 制表符都是词边界（切词按空白，不按「恰好一个空格」）", () => {
    expect(at("batch   |", NAMES).candidates).toEqual(["dev", "prod", "staging"]);
    expect(at("batch\t|", NAMES).candidates).toEqual(["dev", "prod", "staging"]);
  });
});