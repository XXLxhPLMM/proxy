/**
 * 一行文本怎么被切开：空输入、分词（引号 / 转义 / 空词）、坏输入一律收敛成一档而不抛，
 * 以及**切坏时那一档结果里绝不出现用户输入**（粘贴进来的凭据那一组）。
 *
 * @description
 * 凭据那一组与分词同档，是因为它触发失败的入口**全是分词级的**：半个引号、多出来的那一个
 * 词、空引号 —— 而「不许抛」与「不许回显」是同一件事的两面（两者都要活到可滚动、可复制的
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
    expect(tokenize('batch all "prod stage" /status')).toEqual({
      ok: true,
      tokens: ["batch", "all", "prod stage", "/status"],
    });
  });

  it("单引号同样成对（引号内的另一种引号是普通字符）", () => {
    expect(tokenize("batch all 'a \" b' /status")).toEqual({
      ok: true,
      tokens: ["batch", "all", 'a " b', "/status"],
    });
  });

  it("反斜杠转义下一个字符（引号内外一致）", () => {
    expect(tokenize("batch all a\\ b /status")).toEqual({
      ok: true,
      tokens: ["batch", "all", "a b", "/status"],
    });
    expect(tokenize('batch all "a\\"b" /status')).toEqual({
      ok: true,
      tokens: ["batch", "all", 'a"b', "/status"],
    });
  });

  it('⚠️ 空的引号是**一个空词**（`usage ""` ≠ 少一个参数）', () => {
    // 这两条必须同时成立：分词出两个词，而**解析**结果是「值不合法」而不是「参数不够」——
    // 少给一个参数的同一句话（`usage`）是 ok。两件事。
    expect(tokenize('usage ""')).toEqual({ ok: true, tokens: ["usage", ""] });
    expect(fails('usage ""', "bad-value").kind).toBe("bad-value");
    expect(ok("usage").kind).toBe("usage");
  });

  it("⚠️ 未闭合的引号是 bad-args，不是「把后半行吞掉」", () => {
    // 吞掉的后果是 `batch all "prod` 变成一次 `/batch all`（发给**台账里的全部**控制面）
    // 而操作者看到命令跑过了：一次静默的错误副作用。
    expect(tokenize('batch all "prod').ok).toBe(false);
    const result = fails('batch all "prod', "bad-args");
    expect(result.kind === "bad-args" && result.message).toContain("引号");
    // 单引号同样判失败
    expect(tokenize("batch all 'x").ok).toBe(false);
  });

  it("行尾一个孤零零的反斜杠也是失败（转义没有后继字符）", () => {
    expect(tokenize("usage bob x\\")).toEqual({
      ok: false,
      reason: "unterminated-escape",
    });
  });

  it("闭合的引号与转义都**不**在错误文案里回显（未闭合那档的 message 不带用户输入）", () => {
    const result = fails('batch all "prod', "bad-args");
    expect(JSON.stringify(result)).not.toContain("prod");
  });
});

/* ── 粘贴进来的凭据不进错误消息 ───────────────────────────────────────────── */

describe("⚠️ 粘贴进来的凭据不许进任何失败分支的文案", () => {
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

  it("`usage` 多给一个词：message 与 usage 里只有占位符，没有那个词", () => {
    // 这一条是「按错 Tab 把后面半行打进结果区」的现实：用户敲的是 `usage <名字> extra`
    // 而多打了什么只有他知道，判据只能是「一个字节都不许有」
    const result = fails(`usage ${PASSWORD} extra`, "bad-args");
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(result.kind === "bad-args" && result.usage).toBe("/usage [用户名]");
  });

  it("`batch` 少给内层命令 / 多给了词：文案里没有控制面名", () => {
    expectNoLeak(`batch ${TOKEN} extra`, [TOKEN]);
    expectNoLeak(`batch ${TOKEN} /status extra`, [TOKEN]);
  });

  it("`config` 与 `help` 的值格：多给一个词时那串字不在任何一支里", () => {
    expectNoLeak(`config ${PASSWORD} extra`, [PASSWORD]);
    expectNoLeak(`help ${PASSWORD} extra`, [PASSWORD]);
  });

  it("⚠️ 内层那一行不对时也不回显（`bad-value` 的文案只说形状）", () => {
    expectNoLeak(`batch all ${PASSWORD}`, [PASSWORD]);
  });

  it("每一档失败都被这条扫一遍（表驱动：每种坏法 × 里面带的那份凭据）", () => {
    // ⚠️ 表里每一行都必须**真的**是失败输入（`expectNoLeak` 第一句就断言 `kind !== "ok"`）：
    // 一行合法命令混进来会让这条护栏「因为失败得不对而红」，把真正的漏洞盖住。
    const lines: readonly (readonly [string, readonly string[]])[] = [
      ["usage " + PASSWORD + ' "', [PASSWORD]],
      ["usage " + PASSWORD + " extra", [PASSWORD]],
      ["usage " + PASSWORD + " " + TOKEN, [PASSWORD, TOKEN]],
      ["config " + PASSWORD + " extra", [PASSWORD]],
      ["help " + PASSWORD + " extra", [PASSWORD]],
      ["help " + TOKEN + " " + PASSWORD, [TOKEN, PASSWORD]],
      ["batch " + PASSWORD + " extra", [PASSWORD]],
      ["batch " + PASSWORD + " /status extra", [PASSWORD]],
      ["batch " + PASSWORD, [PASSWORD]],
      ["batch all " + PASSWORD, [PASSWORD]],
      ["batch a,,b " + PASSWORD, [PASSWORD]],
      ["batch all " + PASSWORD + " 1.5", [PASSWORD]],
    ];
    for (const [line, forbidden] of lines) {
      expectNoLeak(line, forbidden);
    }
  });

  it("⚠️ 对照：`ok` 那一支**逐字带着**它（否则这条护栏会把功能改坏）", () => {
    // 没有这一条，一个「把值清空 / 把用户输入从命令里抹掉」的实现在上面全部断言下都绿。
    // ⚠️ 而这一条恰好说明**为什么**失败分支不许回显：`ok` 那一支要带着它跑，
    // 失败那一支只是**不让人看见**它 —— 两件事的方向相反。
    expect(ok(`usage ${PASSWORD}`)).toEqual({ kind: "usage", user: PASSWORD });
    expect(ok(`batch ${TOKEN} /status`)).toMatchObject({ targets: TOKEN });
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
      "usage",
      "usage ",
      "users",
      "user",
      "user add",
      "user add bob 1g",
      "target add a b c d e f",
      'usage ""',
      'usage "1.5x"',
      "batch all /nope",
      "batch a,,b /status",
      "batch all",
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
    expect(tokenize("usage 😀")).toEqual({
      ok: true,
      tokens: ["usage", "😀"],
    });
  });
});