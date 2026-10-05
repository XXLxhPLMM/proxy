/**
 * 候选表：每个形参位置**该出**什么，以及排序与去重。
 *
 * @description
 * 候选只许来自两个数据源：某个形参位置上的 `choices`（`/help` 的主题、`/batch` 第一格的台账名字）与
 * 调用方喂进来的那些名字。任何「哪个更常用」式的排序都会让列表随实现细节漂移，故排序判据只有三个，
 * 全部是「两个字符串」的纯函数。
 *
 * ⚠️ 「命令名」**曾经**也是候选之一，现在不是：命令名是一块**列着整张表**、带说明、能上下走的面板，
 * 与「这一个词后面能接什么」不是同一个问题。两层都答「命令名的第一个候选」的话，`/c` 会
 * 得到两个不同的命令（这里按字典序、那里按表的顺序）。
 *
 * 「零候选的位置」与「补完之后那一行长什么样」不归本档：前者在 `boundaries.test.ts`，后者在
 * `line-output.test.ts`。目录级不变量见 `AGENTS.md`。
 *
 * @module tests/complete
 */

import { describe, expect, it } from "vitest";
import { complete } from "@/commands/complete.js";
import { at, cands } from "./_shared.js";

/* ── 第一段：命令名**不归这里** ──────────────────────────────────────────── */

describe("第一段（命令名）：候选恒为空，而那条路归命令面板", () => {
  it("⚠️ 命令名一个候选都不给（变异：把闭合集加回来 → 这里红）", () => {
    // 判据锚在**今天活着的行为**（返回值）而不是某个被删掉的符号名。
    expect(cands("|")).toEqual([]);
    expect(cands("s|")).toEqual([]);
    expect(cands("us|")).toEqual([]);
    expect(cands("st|")).toEqual([]);
  });

  it("⚠️ 也不给**不认识的**那一段候选（原来 `st` → `status`）", () => {
    // 这一条与上一条是**两件不同的事**：上一条是「命令名归面板」，这一条是「一行已经错了就不提」。
    // 它们合成一条断言的话，「因为判据太宽而给了候选」与「因为该给而没给」会互相掩盖。
    expect(cands("zzz|")).toEqual([]);
    expect(cands("staus|")).toEqual([]);
  });

  it("⚠️ 排序不依赖喂进来的顺序（同一组名字给两种顺序，结果逐字相同）", () => {
    const one = complete({ line: "/batch ", cursor: 7, targetNames: ["b", "a", "c"] });
    const two = complete({ line: "/batch ", cursor: 7, targetNames: ["c", "a", "b"] });
    expect(one.candidates).toEqual(["a", "b", "c"]);
    expect(one.candidates).toEqual(two.candidates);
  });

  it("去重（台账里有重名时不给两条一样的）", () => {
    expect(complete({ line: "/batch ", cursor: 7, targetNames: ["dev", "dev", "prod"] }).candidates)
      .toEqual(["dev", "prod"]);
  });
});

/* ── 命令表声明的那些候选来源 ───────────────────────────────────────────── */

describe("候选只来自命令表声明的那几格", () => {
  it("`batch ` 之后出台账里的控制面名（**按字典序**）", () => {
    expect(cands("batch |")).toEqual(["dev", "prod", "staging"]);
  });

  it("那一格按已敲的前缀收窄", () => {
    expect(cands("batch s|")).toEqual(["staging"]);
    expect(cands("batch p|")).toEqual(["prod"]);
    expect(cands("batch zz|")).toEqual([]);
  });

  it("喂进来的清单是空的 = 没有名字可补（不许自己去读台账）", () => {
    expect(complete({ line: "/batch ", cursor: 7 }).candidates).toEqual([]);
    expect(complete({ line: "/batch ", cursor: 7, targetNames: [] }).candidates).toEqual([]);
  });

  it("`help ` 之后出**命令名**，而命令名**恒是一个词**", () => {
    // ⚠️ 顺序是**候选自身的字典序**，不是命令表的顺序（后者是面板的事）——
    // 而这两者在 `accounts` / `acl` 上就分岔（表里 `acl` 在前，字典序 `accounts` 在前）
    expect(cands("help |")).toEqual([
      "accounts",
      "acl",
      "batch",
      "clear",
      "config",
      "exit",
      "help",
      "models",
      "new",
      "providers",
      "quit",
      "r",
      "rename",
      "sessions",
      "status",
      "targets",
      "usage",
      "users",
    ]);
    expect(cands("help st|")).toEqual(["status"]);
  });
});

/* ── 补完之后那一行仍解析得成同一条命令 ─────────────────────────────────── */

describe("闭包：补完之后那一行真的能被解析成同一条命令", () => {
  it("控制面名补进去之后 `/batch` 解析得出内层那一条", () => {
    const result = at("batch |");
    expect(result.line).toBe("/batch dev");
    expect(result.candidates).toEqual(["dev", "prod", "staging"]);
  });
});