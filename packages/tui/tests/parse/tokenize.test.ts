/**
 * 一行文本怎么被切开：空输入、分词（引号 / 转义 / 空词）、坏输入一律收敛成一档而不抛，
 * 以及**切坏时那一档结果里绝不出现用户输入**（凭据那一组）。
 *
 * @description
 * ⚠️ 凭据那一组与分词同档，是因为它触发失败的入口**全是分词级的**：半个引号、多出来的那一个
 * 词、少给的密码 —— 而「不许抛」与「不许回显」是同一件事的两面（两者都要活到可滚动、可复制的
 * 结果区里）。共享的判据纪律与 `/`-前缀那条形状不变量归本目录 `AGENTS.md`。
 *
 * @module tests/parse
 */

import { describe, expect, it } from "vitest";
import { parseLine, tokenize } from "@/commands/parse.js";
import { fails, ok } from "./_shared.js";

/* ── 空输入 ─────────────────────────────────────────────────────────────── */

describe("只有空白：什么都不做（不是错误）", () => {
  it("空串 / 空格 / 制表符都归 empty", () => {
    for (const line of ["", " ", "    ", "\t", " \t "]) {
      expect(parseLine(line)).toEqual({ kind: "empty" });
    }
  });

  it("⚠️ empty 那一支**不带** message —— 回车不该在结果区留下一条消息", () => {
    // 判据是「结果里一个 `message` 字段都没有」，不是「文案里没有 error 字样」：
    // 后者在实现多带一句提示时照样绿，而那正是要防的（一次空回车留一行红字）
    expect(Object.keys(parseLine("   ")).join(",")).toBe("kind");
  });
});

/* ── 分词 ───────────────────────────────────────────────────────────────── */

describe("分词：引号、转义、空词", () => {
  it("双引号内的空格算一个词的一部分", () => {
    expect(tokenize('user pass bob "a b c"')).toEqual({
      ok: true,
      tokens: ["user", "pass", "bob", "a b c"],
    });
  });

  it("单引号同样成对（引号内的另一种引号是普通字符）", () => {
    expect(tokenize("target add prod 'a \" b' tok")).toEqual({
      ok: true,
      tokens: ["target", "add", "prod", 'a " b', "tok"],
    });
  });

  it("反斜杠转义下一个字符（引号内外一致）", () => {
    expect(tokenize("user pass bob a\\ b")).toEqual({
      ok: true,
      tokens: ["user", "pass", "bob", "a b"],
    });
    expect(tokenize('user pass bob "a\\"b"')).toEqual({
      ok: true,
      tokens: ["user", "pass", "bob", 'a"b'],
    });
  });

  it('⚠️ 空的引号是**一个空词**（`user pass alice ""` ≠ 少一个参数）', () => {
    // 这两条必须同时成立：分词出 4 个词，解析结果是 ok 且密码是空串。
    // 少给一个参数的同一句话（`user pass alice`）是 bad-args —— 两件事。
    expect(tokenize('user pass alice ""')).toEqual({
      ok: true,
      tokens: ["user", "pass", "alice", ""],
    });
    const result = ok('user pass alice ""');
    expect(result).toEqual({ kind: "user-pass", username: "alice", password: "" });
    expect(parseLine("/user pass alice").kind).toBe("bad-args");
  });

  it("⚠️ 未闭合的引号是 bad-args，不是「把后半行吞掉」", () => {
    // 吞掉的后果是 `user add alice \"1g` 变成一次 `user add alice`（建出一个**不限量**的
    // 账号）而操作者看到命令跑过了：一次静默的错误副作用。
    expect(tokenize('user add alice "1g').ok).toBe(false);
    const result = fails('user add alice "1g', "bad-args");
    expect(result.kind === "bad-args" && result.message).toContain("引号");
    // 单引号同样判失败
    expect(tokenize("user pass bob 'x").ok).toBe(false);
  });

  it("行尾一个孤零零的反斜杠也是失败（转义没有后继字符）", () => {
    expect(tokenize("user pass bob x\\")).toEqual({
      ok: false,
      reason: "unterminated-escape",
    });
  });

  it("闭合的引号与转义都**不**在错误文案里回显（未闭合那档的 message 不带用户输入）", () => {
    const result = fails('user add alice "1g', "bad-args");
    expect(JSON.stringify(result)).not.toContain("1g");
  });
});

/* ── 凭据不进错误消息 ───────────────────────────────────────────────────── */

describe("⚠️ 凭据不许进任何失败分支的文案", () => {
  const PASSWORD = "p@ss-W0rd-9x";
  const TOKEN = "tok#EN-$ecret-42";

  /** 一次失败的结果里**不许**出现的东西（闭合集之外的、用户敲进去的那些） */
  function expectNoLeak(line: string, forbidden: readonly string[]): void {
    const result = parseLine(line);
    expect(result.kind).not.toBe("ok");
    const dumped = JSON.stringify(result);
    for (const one of forbidden) {
      expect(dumped).not.toContain(one);
    }
  }

  it("`user pass bob` 少给密码：message 不含用户名与任何可能被打进去的内容", () => {
    // 这一条是「按错 Tab 把后面半行打进结果区」的现实：用户敲的是 `user pass bob <密码>`
    // 而多打了什么只有他知道，判据只能是「一个字节都不许有」
    const result = fails("user pass bob", "bad-args");
    expect(JSON.stringify(result)).not.toContain("bob");
    expect(result.kind === "bad-args" && result.message).not.toContain("bob");
    // usage 里只该有**占位符**
    expect(result.kind === "bad-args" && result.usage).toBe("/user pass <用户名> <新密码>");
  });

  it("`user pass` 多给了两个词（密码被挤到第三个位置）：只有占位符，没有那三个词", () => {
    expectNoLeak(`user pass bob ${PASSWORD} extra`, ["bob", PASSWORD]);
  });

  it("`target add` 少给 token / 多给了词：文案里没有 token 也没有地址", () => {
    expectNoLeak("target add prod http://127.0.0.1:8080", ["prod", "127.0.0.1"]);
    expectNoLeak(`target add prod http://127.0.0.1:8080 ${TOKEN} 1.5 extra`, [
      "prod",
      "127.0.0.1",
      TOKEN,
    ]);
  });

  it("`user set ... password` 的值：多给一个词时那串密码不在任何一支里", () => {
    expectNoLeak(`user set bob password ${PASSWORD} extra`, ["bob", PASSWORD]);
  });

  it("每一档失败都被这条扫一遍（表驱动：每种坏法 × 里面带的那份凭据）", () => {
    // ⚠️ 表里每一行都必须**真的**是失败输入（`expectNoLeak` 第一句就断言 `kind !== "ok"`）：
    // 一行合法命令混进来会让这条护栏「因为失败得不对而红」，把真正的漏洞盖住。
    const lines: readonly (readonly [string, readonly string[]])[] = [
      ['user pass bob "' + PASSWORD, [PASSWORD, "bob"]],
      ["user pass " + PASSWORD + " " + TOKEN + " extra", [PASSWORD, TOKEN]],
      ["user pass bob " + PASSWORD + " " + TOKEN, [PASSWORD, TOKEN]],
      ["user set bob password " + PASSWORD + " 1g", [PASSWORD]],
      ["user set bob nope " + PASSWORD, [PASSWORD]],
      ["user set bob quotaBytes " + PASSWORD, [PASSWORD]],
      ["user set bob quotaWindow " + PASSWORD, [PASSWORD]],
      ["user set bob targetWhitelist " + PASSWORD + ",,x", [PASSWORD]],
      ["user set bob disabled " + PASSWORD, [PASSWORD]],
      ["user set " + PASSWORD + " password " + TOKEN + " 1g", [PASSWORD, TOKEN]],
      ["target add " + PASSWORD + " http://127.0.0.1 " + TOKEN + " 1.5 9", [TOKEN, PASSWORD]],
      ["target add " + PASSWORD, [PASSWORD]],
      ["target add prod " + TOKEN, [TOKEN, "prod"]],
      ["target del " + PASSWORD + " extra", [PASSWORD]],
      ["user add " + PASSWORD + " " + PASSWORD, [PASSWORD]],
    ];
    for (const [line, forbidden] of lines) {
      expectNoLeak(line, forbidden);
    }
  });

  it("⚠️ 对照：`ok` 那一支**是**带凭据的（否则这条护栏会把功能改坏）", () => {
    // 没有这一条，一个「把密码清空成空串」的实现在上面全部断言下都绿
    expect(ok(`user pass bob ${PASSWORD}`)).toEqual({
      kind: "user-pass",
      username: "bob",
      password: PASSWORD,
    });
    expect(ok(`target add prod http://127.0.0.1:8080 ${TOKEN}`)).toMatchObject({
      token: TOKEN,
    });
  });
});

/* ── 解析器不抛 ─────────────────────────────────────────────────────────── */

describe("输入侧的每一种坏法都收敛成一档，不抛", () => {
  it("一组乱七八糟的输入全部返回某一档（不是 throw）", () => {
    const lines = [
      "",
      " ",
      '""',
      "'",
      '"',
      "\\",
      "user",
      "user ",
      "user nope",
      "user add",
      "user add bob 1g 2m",
      "user set bob nope x",
      'user add bob "1.5x"',
      'user add bob "1e30g"',
      "target add a b c d e f",
      "help 'x",
      "nope",
      "😀",
      "a".repeat(300),
    ];
    for (const line of lines) {
      expect(() => parseLine(line)).not.toThrow();
      expect(parseLine(line).kind).not.toBe(undefined);
    }
  });

  it("单张非 BMP 字符按**一个**词算（代理对不被切成半个）", () => {
    // 切在代理对中间会让两半都变成孤立代理项，界面显示成两个豆腐块
    expect(tokenize("user add 😀")).toEqual({
      ok: true,
      tokens: ["user", "add", "😀"],
    });
  });
});
