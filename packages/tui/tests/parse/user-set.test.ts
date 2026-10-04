/**
 * `/user set`：字段是**与服务端 `PATCH_KEYS` 一条不缺、一条不多**的闭合集，而值按字段分派。
 *
 * @description
 * ⚠️ 一个解析器接受、而服务端会拒的字段，是把「敲错」升级成「以为成了」的最短路径，故本档锁的
 * 是**集合相等**而不是「包含」—— 少一条是本工具做不到，多一条是一次注定 400 的请求。
 * 共享的判据纪律（负向判据为什么要配对照、锚点为什么取用户真会敲的东西）归本目录 `AGENTS.md`。
 *
 * @module tests/parse
 */

import { describe, expect, it } from "vitest";
import { USER_FIELDS, parseLine } from "@/commands/parse.js";
import { fails, ok } from "./_shared.js";

/* ── user set ───────────────────────────────────────────────────────────── */

describe("user set：字段是闭合集，值按字段分派", () => {
  it("quotaBytes 走流量换算（出参是**字节数**不是原字符串）", () => {
    expect(ok("user set bob quotaBytes 1g")).toEqual({
      kind: "user-set",
      username: "bob",
      field: "quotaBytes",
      value: 1073741824,
    });
    // ⚠️ 对照：单位后缀只在这一条命令上生效（别的字段没有「1g」这种写法）
    expect(parseLine("/user set bob quotaWindow 1g").kind).not.toBe("ok");
  });

  it("quotaWindow 收三档闭合集（**clear = 删窗口键**，不是「无限期」）", () => {
    for (const text of ["day", "DAY", "month", "clear"]) {
      expect(ok(`user set bob quotaWindow ${text}`)).toEqual({
        kind: "user-set",
        username: "bob",
        field: "quotaWindow",
        value: text.toLowerCase(),
      });
    }
    // ⚠️ 负向的**锚点是用户真会敲的东西**，不是某个符号名（见本目录 `AGENTS.md`「防假绿的位置」）
    const bad = fails("user set bob quotaWindow week", "bad-value");
    expect(bad.kind === "bad-value" && bad.argIndex).toBe(3);
  });

  it("disabled 收 on/off/true/false/0/1，出参是**布尔**", () => {
    for (const [text, want] of [
      ["on", true],
      ["ON", true],
      ["true", true],
      ["1", true],
      ["off", false],
      ["False", false],
      ["0", false],
    ] as const) {
      expect(ok(`user set bob disabled ${text}`)).toEqual({
        kind: "user-set",
        username: "bob",
        field: "disabled",
        value: want,
      });
    }
    expect(fails("user set bob disabled maybe", "bad-value").kind).toBe("bad-value");
  });

  it("expiresAt / password 是逐字的（**形态归服务端判**）", () => {
    // ⚠️ 本层**不**判 ISO：那是数据源那一侧的判据，抄一份就多一处会漂的约束
    expect(ok("user set bob expiresAt 2030-01-01T00:00:00+08:00")).toEqual({
      kind: "user-set",
      username: "bob",
      field: "expiresAt",
      value: "2030-01-01T00:00:00+08:00",
    });
    expect(ok("user set bob expiresAt clear")).toEqual({
      kind: "user-set",
      username: "bob",
      field: "expiresAt",
      value: "clear",
    });
    // ⚠️ 密码的空白是**值**（与 `user pass` 同一纪律）
    expect(ok('user set bob password " a b "')).toEqual({
      kind: "user-set",
      username: "bob",
      field: "password",
      value: " a b ",
    });
  });

  it("两份名单：逗号分隔，逐条 trim，**空 = 清空**", () => {
    // ⚠️ 名单**含空格**，故它是一个**词**而不是三个 —— 这里必须加引号，否则分词器会把
    // `10.0.0.0/8` `*.example.com` `1.2.3.4` 判成「多给了 2 个参数」（而那是对的处理）
    expect(ok('user set bob targetWhitelist " 10.0.0.0/8 , *.example.com , 1.2.3.4 "')).toEqual({
      kind: "user-set",
      username: "bob",
      field: "targetWhitelist",
      value: ["10.0.0.0/8", "*.example.com", "1.2.3.4"],
    });
    expect(ok("user set bob targetBlacklist 1.1.1.1")).toEqual({
      kind: "user-set",
      username: "bob",
      field: "targetBlacklist",
      value: ["1.1.1.1"],
    });
    // ⚠️ 「清空」与「没给」是两件事：给一个空引号 = 清空这份名单，而**少一个参数**才是没给
    expect(ok('user set bob targetWhitelist ""')).toEqual({
      kind: "user-set",
      username: "bob",
      field: "targetWhitelist",
      value: [],
    });
    expect(parseLine("/user set bob targetWhitelist").kind).toBe("bad-args");
  });

  it("⚠️ 一个空条目是**失败**而不是被静默丢掉（丢掉 = 「已改」而磁盘上少一条）", () => {
    // ⚠️ 样本一律**带引号**：不加引号时空格会把 `a,,b` 切成两个词，那条命令就成了
    // 「多给了一个参数」—— 而那测的是分词器，不是空条目这条判据
    expect(fails('user set bob targetWhitelist "a,,b"', "bad-value").kind).toBe("bad-value");
    expect(fails('user set bob targetBlacklist "a, ,b"', "bad-value").kind).toBe("bad-value");
    expect(fails('user set bob targetWhitelist "a,"', "bad-value").kind).toBe("bad-value");
    // ⚠️ 对照：条目**语法**不在这儿判（合法 host / IP 是服务端数据源的判据）
    expect(ok("user set bob targetWhitelist 不是一条名单").kind).toBe("user-set");
  });

  it("字段名按小写比较、**出参是表里的规范拼写**（`QUOTAWINDOW` → `quotaWindow`）", () => {
    // ⚠️ 合法字段名本身是驼峰：只把用户输入小写化的话 `quotawindow` 会被拒 ——
    // 那不是「非法字段」，那是同一个人手滑没按 Shift。
    expect(ok("user set bob QUOTABYTES 1g")).toEqual({
      kind: "user-set",
      username: "bob",
      field: "quotaBytes",
      value: 1073741824,
    });
    expect(ok("user set bob quotawindow month")).toEqual({
      kind: "user-set",
      username: "bob",
      field: "quotaWindow",
      value: "month",
    });
  });

  it("⚠️ 字段是闭合集：**与服务端 PATCH_KEYS 一条不缺、一条不多**", () => {
    // 服务端 `PATCH` 的字段白名单里没有 username，本工具**不能**多收它：
    // 一个解析器接受、服务端会拒的字段，是把「敲错」升级成「以为成了」的最短路径。
    expect(fails("user set bob username bob2", "bad-value").kind).toBe("bad-value");
    // ⚠️ 判据是**逐字相等**，不是「包含」：少一条 = 服务端支持而本工具做不到（三个字段做不到
    // 就是在界面外的能力），多一条 = 一次注定 400 的请求
    expect(USER_FIELDS).toEqual([
      "disabled",
      "password",
      "quotaBytes",
      "quotaWindow",
      "expiresAt",
      "targetWhitelist",
      "targetBlacklist",
    ]);
  });

  it("⚠️ 表里每一个字段都有**一条能过的样本**（集合相等不等于字段可用）", () => {
    // ⚠️ 上一条锁的是「名字的集合」，这一条锁的是「每个名字都真能走到 ok」——
    // 一个字段名落在表里、而值分派漏了它，那一条命令就会对每个值报「值不合法」。
    // ⚠️ 样本**逐字**带上引号：名单值可以含空白，而一个不带引号的空串会被分词器吃掉
    const samples: Readonly<Record<(typeof USER_FIELDS)[number], string>> = {
      disabled: "on",
      password: "x",
      quotaBytes: "1g",
      quotaWindow: "day",
      expiresAt: "clear",
      targetWhitelist: "1.2.3.4",
      targetBlacklist: '""',
    };
    for (const field of USER_FIELDS) {
      expect(ok(`user set bob ${field} ${samples[field]}`)).toMatchObject({ field });
    }
    // ⚠️ 对照：样本表**多一个字段**就在上面那条相等断言上红（所以它必须与 USER_FIELDS 同形）
  });

  it("值不合法时说的是「第 3 个形参」（位置由 build 自己知道）", () => {
    const result = fails("user set bob quotaBytes 1.5x", "bad-value");
    expect(result.kind === "bad-value" && result.argIndex).toBe(3);
    // 字段那一格坏时报第 2 位
    expect(
      fails("user set bob nope x", "bad-value").kind === "bad-value" &&
        (fails("user set bob nope x", "bad-value") as { argIndex: number }).argIndex,
    ).toBe(2);
  });
});

