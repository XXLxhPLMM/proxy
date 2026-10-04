/**
 * 候选表：每个形参位置**该出**什么，以及排序与去重。
 *
 * @description
 * 候选只许来自两个数据源：某个形参位置上的 `choices`（组名 `target` 的下一段、`user set` 的
 * 字段名、`help` 的主题）与调用方喂进来的台账名字。任何「哪个更常用」式的排序都会让列表随
 * 实现细节漂移，故排序判据只有三个，全部是「两个字符串」的纯函数。
 *
 * ⚠️ 「命令名」**曾经**也是候选之一，现在不是：命令名是一个 19 行、带说明、能上下走的面板，
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
  it("⚠️ 命令名一个候选都不给（变异：把 `TOP_LEVEL_NAMES` 加回来 → 这里红）", () => {
    // 判据锚在**今天活着的行为**（返回值）而不是某个被删掉的符号名。
    expect(cands("|")).toEqual([]);
    expect(cands("s|")).toEqual([]);
    expect(cands("user|")).toEqual([]);
    expect(cands("st|")).toEqual([]);
  });

  it("⚠️ 也不给**不认识的**那一段候选（原来 `st` → `status`）", () => {
    // 这一条与上一条是**两件不同的事**：上一条是「命令名归面板」，这一条是「一行已经错了就不提」。
    // 它们合成一条断言的话，「因为判据太宽而给了候选」与「因为该给而没给」会互相掩盖。
    expect(cands("zzz|")).toEqual([]);
    expect(cands("staus|")).toEqual([]);
  });

  it("⚠️ 排序不依赖喂进来的顺序（同一组名字给两种顺序，结果逐字相同）", () => {
    const one = complete({ line: "/target switch ", cursor: 16, targetNames: ["b", "a", "c"] });
    const two = complete({ line: "/target switch ", cursor: 16, targetNames: ["c", "a", "b"] });
    expect(one.candidates).toEqual(["a", "b", "c"]);
    expect(one.candidates).toEqual(two.candidates);
  });

  it("去重（台账里有重名时不给两条一样的）", () => {
    expect(
      complete({ line: "/target switch ", cursor: 16, targetNames: ["dev", "dev", "prod"] })
        .candidates,
    ).toEqual(["dev", "prod"]);
  });
});

/* ── 多级命令 ───────────────────────────────────────────────────────────── */

describe("多级命令：下一段在组之后才出", () => {
  it("`user ` 之后出六个子命令（按字典序）", () => {
    expect(cands("user |")).toEqual(["add", "del", "off", "on", "pass", "set"]);
  });

  it("`target ` 之后出三个子命令", () => {
    expect(cands("target |")).toEqual(["add", "del", "switch"]);
  });

  it("组的那一段上补全：按已敲的前缀收窄", () => {
    expect(cands("user |")).toEqual(["add", "del", "off", "on", "pass", "set"]);
    expect(cands("user a|")).toEqual(["add"]);
    expect(cands("user o|")).toEqual(["off", "on"]);
    expect(cands("target s|")).toEqual(["switch"]);
    expect(cands("target zz|")).toEqual([]);
  });

  it("`user set <用户名> ` 之后才出字段名（就是命令表里那七个）", () => {
    // ⚠️ 判据是**位置**：紧跟 `user set` 的那一格是**用户名**（没有候选），
    // 字段名在用户名**之后**。少写一个 `bob` 而期望这里出字段名，是把形参次序记反了。
    expect(cands("user set |")).toEqual([]);
    expect(cands("user set bob |")).toEqual([
      "disabled",
      "expiresAt",
      "password",
      "quotaBytes",
      "quotaWindow",
      "targetBlacklist",
      "targetWhitelist",
    ]);
    // ⚠️ 对照：前缀 `t` 只剩那两条名单，而 `q` 出的是**配额那两条** ——
    // 少一条都会让「按 t 想输名单」变成一个空列表（而一个空列表看不出是「没有」还是「有但没匹配」）
    expect(cands("user set bob t|")).toEqual(["targetBlacklist", "targetWhitelist"]);
    expect(cands("user set bob q|")).toEqual(["quotaBytes", "quotaWindow"]);
    expect(cands("user set bob p|")).toEqual(["password"]);
  });

  it("`help ` 之后出**命令名**（两级命令的完整名字也算一个候选）", () => {
    // 带空白的候选在插入时会被加引号（`render`），所以 `user add` 是一个合法的候选而不是两个词
    expect(cands("help |")).toEqual([
      "acl",
      "batch",
      "clear",
      "config",
      "help",
      "managers",
      "new",
      "provider",
      "provider key",
      "provider set",
      "provider show",
      "r",
      "rename",
      "session",
      "session hide",
      "session show",
      "status",
      "target",
      "target add",
      "target del",
      "target switch",
      "usage",
      "user",
      "user add",
      "user del",
      "user off",
      "user on",
      "user pass",
      "user set",
      "users",
    ]);
    expect(cands("help st|")).toEqual(["status"]);
  });
});

/* ── 目标名字来自台账 ───────────────────────────────────────────────────── */

describe("`target switch` / `target del` 的参数是台账里的名字（由调用方喂进来）", () => {
  it("两个位置都给名字清单", () => {
    expect(cands("target switch |")).toEqual(["dev", "prod", "staging"]);
    expect(cands("target del |")).toEqual(["dev", "prod", "staging"]);
  });

  it("按前缀收窄", () => {
    expect(cands("target switch st|")).toEqual(["staging"]);
    expect(cands("target del p|")).toEqual(["prod"]);
  });

  it("喂进来的清单是空的 = 没有名字可补（不许自己去读台账）", () => {
    expect(complete({ line: "target switch ", cursor: 15 }).candidates).toEqual([]);
    expect(complete({ line: "target switch ", cursor: 15, targetNames: [] }).candidates).toEqual(
      [],
    );
  });

  it("补全之后那一行真的能被解析成同一条命令（闭包：补全不许造出解析不了的行）", () => {
    const result = at("target switch |");
    expect(result.line).toBe("/target switch dev");
  });
});