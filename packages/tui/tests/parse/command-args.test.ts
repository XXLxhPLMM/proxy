/**
 * 形参的**值**与**个数**：零形参与可选用法、值怎么落成出参、流量上限怎么换算成字节数，
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
import { UNLIMITED_BYTES, parseLine, readTraffic } from "@/commands/parse.js";
import { fails, ok } from "./_shared.js";

/* ── 逐条命令 ───────────────────────────────────────────────────────────── */

describe("无参数的命令与可选用法", () => {
  it("status / acl / accounts / clear / r", () => {
    expect(ok("status")).toEqual({ kind: "status" });
    expect(ok("acl")).toEqual({ kind: "acl" });
    expect(ok("accounts")).toEqual({ kind: "accounts" });
    expect(ok("clear")).toEqual({ kind: "clear" });
    expect(ok("r")).toEqual({ kind: "reprobe" });
  });

  it("首尾空白与多个空白是词边界（分词器自己处理）", () => {
    expect(ok("   status   ")).toEqual({ kind: "status" });
    expect(ok("\tusage\tbob")).toEqual({ kind: "usage", user: "bob" });
  });

  it("help [命令名]：给名字就带上，不给就是 null", () => {
    expect(ok("help")).toEqual({ kind: "help", topic: null });
    expect(ok("help status")).toEqual({ kind: "help", topic: "status" });
    // ⚠️ 主题**小写化**（命令名全是小写 ASCII）；而给一个表里没有的名字**解析得过** ——
    // 「这条命令不存在」是 `help` 自己那一屏的事（`helpRows` 给一句判据），不是解析器的
    expect(ok("help TARGETS")).toEqual({ kind: "help", topic: "targets" });
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

  it("batch [控制面] <命令>：内层那一条**已经解析完**，且原文逐字带上来", () => {
    expect(ok("batch all /status")).toEqual({
      kind: "batch",
      targets: "all",
      command: { kind: "status" },
      line: "/status",
    });
    expect(ok("batch prod,stage /acl")).toMatchObject({
      targets: "prod,stage",
      command: { kind: "acl" },
    });
  });

  it("⚠️ 控制面名逐字保留（trim，但**不**归一成别的形状）", () => {
    expect(ok("batch   prod   /status")).toMatchObject({ targets: "prod" });
    // ⚠️ 一个空词即失败（`a,,b` 少打一个名字 ⇒ 静默少发一台）
    expect(fails("batch a,,b /status", "bad-value").kind).toBe("bad-value");
  });

  it("⚠️ 名字类形参不许是空串（`usage \"\"`）", () => {
    expect(fails('usage ""', "bad-value").kind).toBe("bad-value");
  });
});

/* ── 流量上限的换算 ─────────────────────────────────────────────────────── */

describe("流量上限：换算成字节数，判据是「乘完之后是整数且在安全范围内」", () => {
  /**
   * 这一份读法归 `@/commands/values.js:readTraffic`，而**账号的流量上限现在从 `/users` 弹窗那一格进来**
   * @description ⚠️ 判据直接打那个纯函数（不是绕一条命令）：弹窗那一格不走命令行，
   * 而这一份换算是它唯一的真相源 —— 绕一条命令去测它等于要求命令表里留着一条查它的命令。
   */
  function quotaOf(text: string): number {
    return readTraffic(text);
  }

  it("纯数字 = 字节（`1048576` 就是 1 MiB）", () => {
    expect(quotaOf("1048576")).toBe(1048576);
    expect(quotaOf("1b")).toBe(1);
  });

  it("单位大小写随意，可带 B", () => {
    for (const text of ["1g", "1G", "1gb", "1GB", "1Gb"]) {
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
    expect(() => quotaOf("0.1k")).toThrow();
    expect(() => quotaOf("1.1g")).toThrow();
  });

  it("⚠️ 对照：同样是小数、但乘完是整数的**必须过**（`0.5k` = 512 字节）", () => {
    // 这一条是上一条的**判据自检**：只有它成立，「`0.1k` 被拒」才说明判据是
    // 「结果必须是整数」而不是「有小数就收/就拒」。删掉它，那条负向断言就是废的。
    expect(quotaOf("0.5k")).toBe(512);
    expect(quotaOf("0.5g")).toBe(536870912);
  });

  it("⚠️ 溢出的**拒**（`1e30g` 换算是 Infinity）", () => {
    expect(() => quotaOf("1e30g")).toThrow();
    // 静默溢出序列化出去是 null，而服务端收到 null 之后的处置不是本工具要的
    expect(() => quotaOf("9".repeat(30))).toThrow();
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
    expect(() => quotaOf("8e18")).toThrow();
    // 刚过上界那个数：`Number()` 会把它舍入成 2^53，而 2^53 已经出了界
    expect(() => quotaOf("9007199254740993")).toThrow();
  });

  it("不限量的各种写法与空串都归 0", () => {
    for (const text of ["∞", "inf", "INF", "unlimited", "None", ""]) {
      expect(quotaOf(text)).toBe(UNLIMITED_BYTES);
    }
  });

  it("⚠️ `0` 与「没给」是**同一件事**（服务端语义：配额 0 = 不限量）", () => {
    // 这一条挡住下一个人以为缺省是「零字节」而去查为什么账号刚建好就满了
    expect(UNLIMITED_BYTES).toBe(0);
    expect(quotaOf("0")).toBe(0);
    expect(quotaOf(" 0 ")).toBe(UNLIMITED_BYTES);
  });

  it("不认识的单位与不像数字的写法都拒（文案只列闭合集，不回显输入）", () => {
    for (const text of ["1.5x", "1t", "1tb", "abc", "-1", "1 000", "0x10"]) {
      let thrown: Error | null = null;
      try {
        quotaOf(text);
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown, text).not.toBeNull();
      // ⚠️ 失败文案里不许出现那个输入本身（它会落进可滚动的结果区）
      expect(thrown?.message ?? "").not.toContain(text);
    }
  });
});

/* ── 参数个数 ───────────────────────────────────────────────────────────── */

describe("参数个数：少给与多给是两句话", () => {
  it("少给：给出用法（usage 来自命令表）", () => {
    const result = fails("batch", "bad-args");
    expect(result.kind === "bad-args" && result.usage).toBe("/batch <控制面> <命令>");
    // ⚠️ **`rest` 那一格不能省**：`/batch all` 缺的是内层命令，而它是**必填**的那一格
    expect(fails("batch all", "bad-args").kind).toBe("bad-args");
  });

  it("多给：⚠️ 多出来的那个不能被**静默忽略**", () => {
    // 静默忽略的后果是「我改的是 A」变成「我多给了一个没人看的东西」，
    // 而操作者以为那条尾巴生效了
    const result = fails("usage alice bob", "bad-args");
    expect(result.kind === "bad-args" && result.message).toContain("多给了 1 个参数");
    expect(parseLine("/status extra").kind).toBe("bad-args");
    expect(parseLine("/accounts extra").kind).toBe("bad-args");
  });

  it("⚠️ 但 `rest` 那一格吃下**全部**剩余的词（个数判据在它之前分岔）", () => {
    // `/batch` 的内层那行里有引号，而分词再拼回去会毁掉引号 ⇒ 那一格吃原文。
    // 而这条断言同时钉住「多给了几个参数」那道判据**没有**误伤它。
    expect(ok('batch all /help "status"')).toMatchObject({
      line: '/help "status"',
      command: { kind: "help", topic: "status" },
    });
  });
});