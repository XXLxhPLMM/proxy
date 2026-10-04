/**
 * 命令名这一层：那张表本身、`/` 前缀那条**形状**不变量、以及名字不认识时给的那几个建议。
 *
 * @description
 * ⚠️ 「每一行命令都必须以 `/` 开头」这一组是那条不变量的**牙齿**（`src/commands/AGENTS.md`
 * 「层不变量」指的就是这里），故它在**本档内不散**：前缀那道闸被去掉、或者被改成宽容地接受
 * 不带前缀的写法，转红的只有「宽容地接受…必须转红」那一条。
 *
 * @module tests/parse
 */

import { describe, expect, it } from "vitest";
import {
  COMMAND_PREFIX,
  COMMAND_SPECS,
  TOP_LEVEL_NAMES,
  findSpec,
  parseLine,
  suggestCommands,
} from "@/commands/parse.js";
import { fails, ok } from "./_shared.js";

/* ── 命令表 ─────────────────────────────────────────────────────────────── */

describe("命令表：三十行 + 四个组，一行不多一行不少", () => {
  it("表里的名字逐条对上（多级用空格连写）", () => {
    const names = COMMAND_SPECS.map((spec) => spec.name);
    expect(names).toEqual([
      "help",
      "status",
      "config",
      "usage",
      "acl",
      "users",
      "user",
      "user add",
      "user set",
      "user on",
      "user off",
      "user del",
      "user pass",
      "target",
      "target add",
      "target del",
      "target switch",
      "clear",
      "new",
      "rename",
      "session",
      "session hide",
      "session show",
      "managers",
      "provider",
      "provider show",
      "provider set",
      "provider key",
      "batch",
      "r",
    ]);
  });

  it("`/new` 与 `/managers` 零形参，且各自产出那一个 kind（它们只做界面状态）", () => {
    for (const [line, kind] of [
      ["/new", "session-new"],
      ["/managers", "show-managers"],
      // ⚠️ `/rename` 也是零形参：名字是**在框里敲**出来的，所以它不是形参而是一段界面状态
      ["/rename", "session-rename"],
    ] as const) {
      const parsed = parseLine(line);
      expect(parsed.kind).toBe("ok");
      if (parsed.kind !== "ok") throw new Error("解析失败");
      expect(parsed.command.kind).toBe(kind);
      // ⚠️ 用法串恒等于路径本身 —— 多写一个尖括号就是「它要形参而表里没有」
      expect(COMMAND_SPECS.find((spec) => spec.path === line)?.usage).toBe(line);
    }
  });

  it("每一行都有说明，且用法串是从形参表推出来的（`/user add <用户名> [流量上限]`）", () => {
    for (const spec of COMMAND_SPECS) {
      expect(spec.summary.length).toBeGreaterThan(0);
    }
    // ⚠️ 用法串**带前缀**：它是操作者照着敲的那一串，而 `parseLine` 收带前缀的那一串。
    expect(findSpec("user add")?.usage).toBe("/user add <用户名> [流量上限]");
    expect(findSpec("user set")?.usage).toBe("/user set <用户名> <字段> <值>");
    expect(findSpec("target add")?.usage).toBe("/target add <名字> <地址> <token> [超时毫秒]");
    expect(findSpec("user")?.usage).toBe("/user <子命令>");
  });

  it("⚠️ `path` 逐条就是「前缀 + 名字」，而 `usage` 的第一段就是它（**不是**抄的）", () => {
    for (const spec of COMMAND_SPECS) {
      // ⚠️ 判据是**逐条**重算一遍，不是「数组里有几个带 `/`」：后者对「`path` 全带前缀但
      // `usage` 忘了」恒绿，而那正是同一屏里两句话不一致的形状（`help` 印 `user add`、
      // 错误文案印 `/user add <用户名>`）。
      expect(spec.path).toBe(`${COMMAND_PREFIX}${spec.name}`);
      expect(spec.usage.startsWith(spec.path)).toBe(true);
    }
    expect(findSpec("user add")?.path).toBe("/user add");
    expect(findSpec("status")?.path).toBe("/status");
  });

  it("组不是命令（解析器绝不把一个组交出去）", () => {
    // ⚠️ 锚点是**今天活着的形状**：`user` 单独敲必须是 bad-args 而不是 ok
    expect(findSpec("user")?.subs).toEqual(["add", "del", "off", "on", "pass", "set"]);
    expect(findSpec("target")?.subs).toEqual(["add", "del", "switch"]);
    expect(fails("user", "bad-args").kind).toBe("bad-args");
    expect(fails("target", "bad-args").kind).toBe("bad-args");
  });
});

/* ── 每一行都必须以 `/` 开头（本层的一条**形状**不变量）─────────────────── */

/** 形参名 → 一个**真能过**的样本（判据按形参名校验，故「随便给个 x」会让对照自己先红） */
const VALID_ARG: Readonly<Record<string, string>> = {
  命令名: "status",
  键名: "AUTH_TYPE",
  用户名: "alice",
  密码: "unused",
  新密码: "s3cret",
  值: "off",
  字段: "disabled",
  流量上限: "1g",
  名字: "prod",
  地址: "http://127.0.0.1:3010",
  token: "tok",
  超时毫秒: "3000",
  // ⚠️ `/provider set` 的地址**不归一**（`normalizeBaseUrl` 是控制面那份），故给一个真的 https 端点
  模型名: "some-model",
  凭据: "sk-test",
  控制面: "all",
  // ⚠️ `/batch` 第二格是 `rest`：它吃下**剩下的原文**，故样本**必须自带前缀**（递归解析走 `parseLine`）
  命令: "/help",
};

describe("⚠️ 每一行命令都必须以 `/` 开头，且不带前缀时**不许**被宽容接受", () => {
  it("加前缀就通：表里**每一个**名字都真的能被解析（反向自检）", () => {
    // ⚠️ 这一条是**对照**：少了它，下面那些负向断言可能只是「前缀那道闸把所有人都拒了」而绿。
    // 判据锚在**今天活着的形状**（`parseLine` 的返回档），不是点名某个符号。
    // ⚠️ 形参给的是**真样本**而不是 `"x"`：`user set x用户名 x字段 x值` 会因为 `x字段`
    // 不是合法字段而进 `bad-value`，于是这条「对照」自己先红了（而它红的方式与前缀无关）。
    for (const spec of COMMAND_SPECS) {
      if (spec.subs.length > 0) continue;
      const bare = spec.args
        .filter((one) => one.required)
        .map((one) => VALID_ARG[one.label] ?? "x");
      expect(parseLine([spec.path, ...bare].join(" ")).kind).toBe("ok");
    }
  });

  it("不带前缀 → `missing-prefix`，而**不是** `unknown-command`", () => {
    // ⚠️ 单独一档而不是混进 `unknown-command`：两件事要修的地方不同（补一个字符 vs 改命令名），
    // 合成一档的话建议会变成「你是不是想写 `statuss`」。
    expect(parseLine("status").kind).toBe("missing-prefix");
    expect(parseLine("nope").kind).toBe("missing-prefix");
    // 首尾空白不救它、也不冤枉它（trim 之后判前缀）
    expect(parseLine("   status   ").kind).toBe("missing-prefix");
    expect(parseLine("   /status   ").kind).toBe("ok");
  });

  it("⚠️ 宽容地接受不带前缀的写法**必须转红**（变异：去掉那道闸 → 这里绿）", () => {
    // 这是本组的**核心**：判据是「不带前缀的 `status` 进不了 `ok`」。
    // 少了它，「每一条都必须以 `/` 开头」就只是一句注释 —— 而宽容分支是最容易被加回来的
    // （它看起来像「兼容老脚本」），症状是操作者有两套写法而其中一套会在下一版消失。
    expect(parseLine("status").kind).not.toBe("ok");
    expect(parseLine("user add alice").kind).not.toBe("ok");
  });

  it("建议与文案都给人看的形态（带前缀），而**不回显**敲了什么", () => {
    const failed = parseLine("status");
    expect(failed.kind).toBe("missing-prefix");
    if (failed.kind !== "missing-prefix") throw new Error("档位不对");
    expect(failed.suggestions).toContain("/status");
    // ⚠️ 文案里只有闭合集与那一个前缀字符：抄进结果区的是「怎么改」，不是「你敲了什么」
    expect(failed.message).not.toContain("status");
    expect(failed.message).toContain(COMMAND_PREFIX);
  });

  it("只有一个 `/` 时是 `empty`（什么也不是），不是 `missing-prefix`", () => {
    // ⚠️ `/` 已经带了前缀，缺的是命令名 —— 那和「忘了打前缀」是两件事。
    expect(parseLine("/")).toEqual({ kind: "empty" });
    expect(parseLine("/   ")).toEqual({ kind: "empty" });
  });

  it("⚠️ 前缀**不进词**：`/user add` 是两个词（变异：把 `/` 一起分词 → 这里红）", () => {
    // 判据是**今天活着的形状**（`ok` 那一支的字段值），不是点名 `tokenize`：
    // 若 `/` 进了第一个词，`user` 就不是命令名了，`user add` 会归 `unknown-command`。
    expect(ok("user add alice")).toEqual({ kind: "user-add", username: "alice", quotaBytes: 0 });
  });
});

/* ── 不认识的命令 ───────────────────────────────────────────────────────── */

describe("不认识的命令：带上最接近的那几个", () => {
  it("`staus` 指向 `status`（相邻换位算一次编辑）", () => {
    const result = fails("staus", "unknown-command");
    expect(result.kind === "unknown-command" && result.suggestions).toEqual(["/status"]);
  });

  it("`usr` 的第一位是 `user` 而不是 `r`（同距离时公共前缀长的在前）", () => {
    // ⚠️ 这是排序第二判据的对照：`user` / `users` / `r` 与 `usr` 的距离是 1 / 2 / 2，
    // 纯字典序会给 `["r","user","users"]`。没有前缀那一判据，操作者敲 `usr` 看到的第一项
    // 是那个一字母命令。
    expect(
      fails("usr", "unknown-command").kind === "unknown-command" &&
        (fails("usr", "unknown-command") as { suggestions: readonly string[] }).suggestions,
    ).toEqual(["/user", "/users", "/r"]);
  });

  it("建议只来自闭合集（第一段命令名），且顺序只由两个字符串决定", () => {
    expect(suggestCommands("staus")).toEqual(["status"]);
    expect(suggestCommands("statuss")).toEqual(["status"]);
    expect(suggestCommands("targt")).toEqual(["target"]);
    // 短到不可能是手滑的输入不给建议（那时候的「接近」全是噪声）
    expect(suggestCommands("xy")).toEqual([]);
    expect(suggestCommands("")).toEqual([]);
    // 完全不像的输入没有建议，但仍然是 unknown-command
    const result = fails("zzzzzzzzz", "unknown-command");
    expect(result.kind === "unknown-command" && result.suggestions).toEqual([]);
  });

  it("⚠️ 不回显敲了什么（粘贴进来的凭据不许被抄进结果区）", () => {
    const result = fails("S3CR3Ttokenvalue", "unknown-command");
    expect(JSON.stringify(result)).not.toContain("S3CR3Ttokenvalue");
    // 建议全部来自闭合集（`TOP_LEVEL_NAMES`），不是用户输入的派生
    for (const one of (result as { suggestions: readonly string[] }).suggestions) {
      expect(TOP_LEVEL_NAMES).toContain(one);
    }
  });

  it("两级命令的第一段认识、第二段不认识时是 bad-args（不是 unknown-command）", () => {
    // ⚠️ 判据是**两支的分工**：`user` 是表里的一个组，故这里报「参数不对」；
    // 若哪天组被删出表，这一条会转成 unknown-command 而测试会红 —— 那是真的行为变化。
    expect(parseLine("/user nope").kind).toBe("bad-args");
    expect(parseLine("/nope add").kind).toBe("unknown-command");
  });
});

