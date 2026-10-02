/**
 * `@/cmd/parse` 的行为面：一行文本 → 一条命令
 *
 * **这一档锁的是「一次错误操作的代价」**，不是「函数返回了什么」。解析器出的错有两类代价：
 * 一类是把操作者带偏（`0` 被当成「零字节」于是账号刚建好就满了），另一类是**把凭据抄进
 * 结果区**（错误文案里回显了 token）。后者在屏幕上看着完全正常，而本包是纯客户端、结果区
 * 可滚动可复制 —— 故「文案里不许出现用户输入」这条要有一条**能转红**的断言，而不是靠自觉。
 *
 * ## ⚠️ 本档的用例写的是**命令名**，`/` 由两个便捷断言补上
 * @description
 * 「每一条命令都必须以 `/` 开头」是本层的一条**形状**不变量，它由文件末尾**专门一组**断言守。
 * 故这里几百条用例不必每条都带前缀 —— 每条都带的话，改前缀那天本档与那一组一起红，
 * 而红的东西一多就等于没红（看不出是哪一条在管哪件事）。
 *
 * ## 为什么每条负向判据都配一条**对照**的正向判据
 * @description
 * 「`0.1k` 被拒」单独存在时，它可能是因为「有小数就拒」而绿 —— 而那是一个**错的**判据
 * （`1.5g` 该收）。所以每条数值类的负向断言都配一条「同样有小数、但必须通过」或
 * 「同样大、但必须通过」的对照；两条合起来才说明判据落在**乘完之后是不是整数**、落在
 * **安全整数范围**上。反过来，只写对照不写负向也一样不成立。
 *
 * ## 负向断言的锚点为什么是「输入」而不是「某个符号名」
 * @description
 * 点名一个不存在的符号，断言会**恒真**而不是失败（根 `AGENTS.md`「写护栏时」）。故本档
 * 全部负向判据的锚点都是**用户真会敲的东西**：`user set bob username bob2`（服务端不支持
 * 改用户名，而人真的会试）、`user pass bob "open`（半打一个引号）、`1e30g`、`0.1k`。
 * 每一条都做过**变异**：把被防住的行为放回去，断言必须转红（见本档末尾那七条）。
 */

import { describe, expect, it } from "vitest";
import {
  COMMAND_PREFIX,
  COMMAND_SPECS,
  TOP_LEVEL_NAMES,
  UNLIMITED_BYTES,
  USER_FIELDS,
  findSpec,
  parseLine,
  suggestCommands,
  tokenize,
  type Command,
  type ParseResult,
} from "@/cmd/parse.js";

/* ── 便捷断言 ───────────────────────────────────────────────────────────── */

/**
 * 必须是 `ok`，并把命令交出来（失败时让 vitest 打印那一档的实际形状）
 * @description ⚠️ **这里补上 {@link COMMAND_PREFIX}**：本档的用例写的是命令名，而前缀那条
 * 不变量由文件末尾专门一组断言管（见文件头「本档的用例写的是命令名」）。
 */
function ok(line: string): Command {
  const result = parseLine(COMMAND_PREFIX + line);
  if (result.kind !== "ok") {
    throw new Error(`期望 ok，实际是 ${result.kind}：${JSON.stringify(result)}`);
  }
  return result.command;
}

/** 必须是某一档失败 */
function fails(line: string, kind: ParseResult["kind"]): ParseResult {
  const result = parseLine(COMMAND_PREFIX + line);
  if (result.kind !== kind) {
    throw new Error(`期望 ${kind}，实际是 ${result.kind}：${JSON.stringify(result)}`);
  }
  return result;
}

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

/* ── 命令表 ─────────────────────────────────────────────────────────────── */

describe("命令表：十七行 + 两个组，一行不多一行不少", () => {
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
      "r",
    ]);
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

/* ── 逐条命令 ───────────────────────────────────────────────────────────── */

describe("无参数的命令与可选用法", () => {
  it("status / acl / users / clear / r", () => {
    expect(ok("status")).toEqual({ kind: "status" });
    expect(ok("acl")).toEqual({ kind: "acl" });
    expect(ok("users")).toEqual({ kind: "users" });
    expect(ok("clear")).toEqual({ kind: "clear" });
    expect(ok("r")).toEqual({ kind: "reprobe" });
  });

  it("首尾空白与多个空白是词边界（分词器自己处理）", () => {
    expect(ok("   status   ")).toEqual({ kind: "status" });
    expect(ok("\tuser\tadd\tbob")).toEqual({
      kind: "user-add",
      username: "bob",
      quotaBytes: UNLIMITED_BYTES,
    });
  });

  it("help [命令名]：给名字就带上，不给就是 null", () => {
    expect(ok("help")).toEqual({ kind: "help", topic: null });
    expect(ok("help status")).toEqual({ kind: "help", topic: "status" });
    expect(ok('help "user add"')).toEqual({ kind: "help", topic: "user add" });
  });

  it("config [键名]：⚠️ 键名**不小写化**（`AUTH_TYPE` 是大写的）", () => {
    expect(ok("config")).toEqual({ kind: "config", key: null });
    expect(ok("config AUTH_TYPE")).toEqual({ kind: "config", key: "AUTH_TYPE" });
    expect(ok("config  auth.enabled  ")).toEqual({ kind: "config", key: "auth.enabled" });
  });

  it("usage [用户名]：⚠️ 用户名大小写有意义（逐字保留）", () => {
    expect(ok("usage")).toEqual({ kind: "usage", user: null });
    expect(ok("usage Bob")).toEqual({ kind: "usage", user: "Bob" });
  });

  it("user on / off / del / pass", () => {
    expect(ok("user on bob")).toEqual({ kind: "user-on", username: "bob" });
    expect(ok("user off bob")).toEqual({ kind: "user-off", username: "bob" });
    expect(ok("user del bob")).toEqual({ kind: "user-del", username: "bob" });
    expect(ok("user pass bob newpw")).toEqual({
      kind: "user-pass",
      username: "bob",
      password: "newpw",
    });
  });

  it("target del / target switch", () => {
    expect(ok("target del prod")).toEqual({ kind: "target-del", name: "prod" });
    expect(ok("target switch prod")).toEqual({ kind: "target-switch", name: "prod" });
  });

  it("target add：不给超时时是 null（区间判据归 @/ledger，本层不抄第二份）", () => {
    expect(ok("target add prod http://127.0.0.1:8080 tok")).toEqual({
      kind: "target-add",
      name: "prod",
      baseUrl: "http://127.0.0.1:8080",
      token: "tok",
      timeoutMs: null,
    });
  });

  it("⚠️ 超时只判「是不是一个非负安全整数」，**不**判区间", () => {
    // 两条一起说明这条判据落在哪：200 / 2000 收，1（低于 @/ledger 的下界）与 999999
    // （高于上界）也收 —— 区间是落盘那一层的判据，抄一份就是一处会漂的约束。
    expect(ok("target add prod http://127.0.0.1:8080 tok 2000")).toMatchObject({
      timeoutMs: 2000,
    });
    expect(ok("target add prod http://127.0.0.1:8080 tok 1")).toMatchObject({ timeoutMs: 1 });
    expect(ok("target add prod http://127.0.0.1:8080 tok 999999")).toMatchObject({
      timeoutMs: 999999,
    });
    // 非整数 / 负数 / 溢出：形状不对
    expect(parseLine("/target add prod http://127.0.0.1:8080 tok 1.5").kind).toBe("bad-value");
    expect(parseLine("/target add prod http://127.0.0.1:8080 tok -1").kind).toBe("bad-value");
    expect(parseLine(`/target add prod http://127.0.0.1:8080 tok ${"9".repeat(30)}`).kind).toBe(
      "bad-value",
    );
  });

  it("⚠️ 凭据逐字保留（首尾空白与空串都是**值**，不是手滑）", () => {
    expect(ok('target add prod http://127.0.0.1:8080 "  tok  "')).toMatchObject({
      token: "  tok  ",
    });
    expect(ok('target add prod http://127.0.0.1:8080 ""')).toMatchObject({ token: "" });
    // 名字类形参反过来：trim（复制粘贴带进来的手滑）——
    // ⚠️ 未加引号的词**没有**尾随空白可留（空白就是词边界），所以要 trim 的只能是词的两侧
    expect(ok("target add   prod   http://127.0.0.1:8080   tok")).toMatchObject({
      name: "prod",
      baseUrl: "http://127.0.0.1:8080",
      token: "tok",
    });
  });
});

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
    // ⚠️ 负向的**锚点是用户真会敲的东西**，不是某个符号名（见本档头）
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

/* ── 流量上限的换算 ─────────────────────────────────────────────────────── */

describe("流量上限：换算成字节数，判据是「乘完之后是整数且在安全范围内」", () => {
  /** 走 `user add` 的第二个形参（那条路的出参就是这个字节数） */
  function quotaOf(text: string): number {
    const command = ok(`user add bob "${text}"`);
    if (command.kind !== "user-add") throw new Error("期望 user-add");
    return command.quotaBytes;
  }

  it("纯数字 = 字节（`1048576` 就是 1 MiB）", () => {
    expect(quotaOf("1048576")).toBe(1048576);
    expect(quotaOf("1b")).toBe(1);
  });

  it("单位大小写随意，可带 B", () => {
    for (const text of ["1g", "1G", "1gb", "1GB", "1G b".replace(" ", "")]) {
      expect(quotaOf(text)).toBe(1073741824);
    }
    for (const text of ["1m", "1M", "1mb"]) {
      expect(quotaOf(text)).toBe(1048576);
    }
    for (const text of ["1k", "1K", "1kb"]) {
      expect(quotaOf(text)).toBe(1024);
    }
    expect(quotaOf("512mb")).toBe(512 * 1024 * 1024);
  });

  it("小数**收**，且要精确（不许先 floor 再乘）", () => {
    // `1.5g` 必须是 1.5 GiB。写成 1 GiB 的话操作者以为自己给了 1.5 倍。
    expect(quotaOf("1.5g")).toBe(1610612736);
    expect(quotaOf("2.25k")).toBe(2304);
  });

  it("⚠️ 换算后不是整数的**拒**（`0.1k` = 102.4 字节）", () => {
    expect(parseLine('/user add bob "0.1k"').kind).toBe("bad-value");
    expect(parseLine('/user add bob "1.1g"').kind).toBe("bad-value");
  });

  it("⚠️ 对照：同样是小数、但乘完是整数的**必须过**（`0.5k` = 512 字节）", () => {
    // 这一条是上一条的**判据自检**：只有它成立，「`0.1k` 被拒」才说明判据是
    // 「结果必须是整数」而不是「有小数就收/就拒」。删掉它，那条负向断言就是废的。
    expect(quotaOf("0.5k")).toBe(512);
    expect(quotaOf("0.5g")).toBe(536870912);
  });

  it("⚠️ 溢出的**拒**（`1e30g` 换算是 Infinity）", () => {
    expect(parseLine('/user add bob "1e30g"').kind).toBe("bad-value");
    // 静默溢出序列化出去是 null，而服务端收到 null 之后的处置不是本工具要的
    expect(parseLine(`/user add bob "${"9".repeat(30)}"`).kind).toBe("bad-value");
  });

  it("⚠️ 对照：指数写法、且仍在安全整数内的**必须过**", () => {
    // 安全整数上界是 9007199254740991，故「刚好在界内的大数」是这个判据的对照组。
    // ⚠️ 8e18 **不在**界内（它比上界大约 888 倍），所以对照组用 8e15；
    // 8e18 属于下面那条「界外必拒」，写成「通过」就是一条自相矛盾的断言。
    expect(quotaOf("8e15")).toBe(8000000000000000);
    expect(quotaOf("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("界外必拒（含 `8e18` —— 它比上界大三个数量级）", () => {
    expect(Number.isSafeInteger(8e18)).toBe(false);
    expect(parseLine('/user add bob "8e18"').kind).toBe("bad-value");
    // 刚过上界那个数：`Number()` 会把它舍入成 2^53，而 2^53 已经出了界
    expect(parseLine('/user add bob "9007199254740993"').kind).toBe("bad-value");
  });

  it("不限量的各种写法与空串都归 0", () => {
    for (const text of ["∞", "inf", "INF", "unlimited", "None", ""]) {
      expect(quotaOf(text)).toBe(UNLIMITED_BYTES);
    }
  });

  it("⚠️ `0` 与「没给」是**同一件事**（服务端语义：配额 0 = 不限量）", () => {
    // 这一条挡住下一个人以为缺省是「零字节」而去查为什么账号刚建好就满了
    expect(UNLIMITED_BYTES).toBe(0);
    expect(ok("user add bob")).toEqual({ kind: "user-add", username: "bob", quotaBytes: 0 });
    expect(ok("user add bob 0")).toEqual({ kind: "user-add", username: "bob", quotaBytes: 0 });
    expect(ok("user add bob inf")).toEqual(ok("user add bob"));
  });

  it("不认识的单位与不像数字的写法都拒（文案只列闭合集，不回显输入）", () => {
    for (const text of ["1.5x", "1t", "1tb", "abc", "-1", "1 000", "0x10"]) {
      const result = parseLine(`/user add bob "${text}"`);
      expect(result.kind).toBe("bad-value");
      expect(JSON.stringify(result)).not.toContain(text);
    }
  });
});

/* ── 参数个数 ───────────────────────────────────────────────────────────── */

describe("参数个数：少给与多给是两句话", () => {
  it("少给：给出用法（usage 来自命令表）", () => {
    const result = fails("user add", "bad-args");
    expect(result.kind === "bad-args" && result.usage).toBe("/user add <用户名> [流量上限]");
    expect(parseLine("/user set bob traffic").kind).toBe("bad-args");
    expect(parseLine("/user on").kind).toBe("bad-args");
    expect(parseLine("/target add prod http://127.0.0.1:8080").kind).toBe("bad-args");
    expect(parseLine("/user pass bob").kind).toBe("bad-args");
  });

  it("多给：⚠️ 多出来的那个不能被**静默忽略**", () => {
    // 静默忽略的后果是「我改的是 A」变成「我多给了一个没人看的东西」，
    // 而操作者以为那条尾巴生效了
    const result = fails("user add bob 1g 2m", "bad-args");
    expect(result.kind === "bad-args" && result.message).toContain("多给了 1 个参数");
    expect(parseLine("/status extra").kind).toBe("bad-args");
  });

  it("组少一个子命令 / 子命令不在闭合集里，两条都归 bad-args 且列出子命令", () => {
    const missing = fails("target", "bad-args");
    // ⚠️ 列的是**能敲的那几串**（`/target add` 而不是 `add`）：文案是照着敲的，
    // 只给子命令名的话操作者还得自己拼前缀 —— 而「忘了前缀」正是本层最常见的一个错。
    expect(missing.kind === "bad-args" && missing.message).toContain(
      "/target add / /target del / /target switch",
    );
    const wrong = fails("user nope", "bad-args");
    expect(wrong.kind === "bad-args" && wrong.message).toContain(
      "/user add / /user del / /user off / /user on / /user pass / /user set",
    );
  });

  it('名字类形参不许是空串（`user add "" 1g`）', () => {
    expect(parseLine('/user add "" 1g').kind).toBe("bad-value");
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
