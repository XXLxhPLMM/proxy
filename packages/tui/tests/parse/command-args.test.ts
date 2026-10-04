/**
 * 形参的**值**与**个数**：零形参与可选用法、凭据与超时怎么落成出参、流量上限怎么换算成字节数，
 * 以及少给 / 多给是两句话。
 *
 * @description
 * ⚠️ 「乘完之后是整数且落在安全整数范围内」是本档的中心判据，而**区间**判据归
 * `@/services/config`（落盘那一层）—— 抄一份就是一处会漂的约束。共享的判据纪律归本目录
 * `AGENTS.md`。
 *
 * @module tests/parse
 */

import { describe, expect, it } from "vitest";
import { UNLIMITED_BYTES, parseLine } from "@/commands/parse.js";
import { fails, ok } from "./_shared.js";

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

  it("target add：不给超时时是 null（区间判据归 @/services/config，本层不抄第二份）", () => {
    expect(ok("target add prod http://127.0.0.1:8080 tok")).toEqual({
      kind: "target-add",
      name: "prod",
      baseUrl: "http://127.0.0.1:8080",
      token: "tok",
      timeoutMs: null,
    });
  });

  it("⚠️ 超时只判「是不是一个非负安全整数」，**不**判区间", () => {
    // 两条一起说明这条判据落在哪：200 / 2000 收，1（低于 @/services/config 的下界）与 999999
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

