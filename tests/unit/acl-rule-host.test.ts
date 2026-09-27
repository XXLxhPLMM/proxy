/**
 * 名单条目语法层 `config/files/rules/host`（服务 `target` / `upstream` 两组，IP/CIDR 分支直接复用 `ip.ts`）
 *
 * @description
 * ## 域名 ASCII 白名单正则**刻意拒绝 IDN 与下划线** — 否掉「顺手支持 punycode / 主机名里的 `_`」
 * IDN 条目必须由运维自己写成 punycode；静默接受非 ASCII 会让「写错了但没报错」的条目在匹配时
 * **永远不命中**（症状是名单时灵时不灵，且没有任何报错可查）。
 * 牙齿**两面**：
 * - 本档「非法条目返回 undefined」那条：`expect(parseHostRule("bad_domain")).toBeUndefined()`
 *   （下划线）、`parseHostRule("bad domain")` / `"*"` / `"*."` / `"*.a..com"` / `""`。
 * - 数据层那一侧（账号级 `acl` 走同一条判据，`tests/unit/auth-users.test.ts`）：
 *   `expect(bad(["exämple.com"])).toBeUndefined()` / `expect(bad(["a_b.com"])).toBeUndefined()`，
 *   以及那条「两文件对同一批条目结论必须一致」的逐条比对。
 *
 * ## `*.a.com` **只匹配 `a.com` 的子域**，**不含** `a.com` 本身 — 否掉「通配隐含 apex」
 * 隐含 apex 会让「只开放 `api.example.com`」的意图**顺带开放 `example.com`**；要 apex 就单独写一条。
 * 精确与通配职责分离，不隐式包含。牙齿（本档「`*.a.com` 命中子域，但不命中 a.com 本身」那条）：
 * `expect(hostMatches("x.a.com", m)).toBe(true)` / `expect(hostMatches("a.b.a.com", m)).toBe(true)` /
 * `expect(hostMatches("a.com", m)).toBe(false)` / `expect(hostMatches("nota.com", m)).toBe(false)`
 * ——把 apex 也算进去，那第三行当场红。对照档「精确域名命中/未命中（不隐式匹配子域）」是反方向那一面。
 *
 * ## `compileHostRules` **任一条非法即整体 `undefined`**
 * 牙齿（本档「compileHostRules 任一条非法即整体 undefined」那条）：
 * `expect(compileHostRules(["example.com", "bad_host"])).toBeUndefined()`
 * ——静默丢弃那一条就等于返回一条更短的规则集，红。
 * 正向那一格 `expect(compileHostRules([])?.exact.size).toBe(0)` 钉住「空名单编译成空匹配器」
 * （不是 `undefined`，也不是抛错）。
 *
 * ## 请求 host 侧的带端口 authority 必须归一（`[::1]:443` → `::1`）
 * 客户端真的会发 `[::1]:443`，不归一则 IPv6 名单永不命中。
 * 牙齿（本档「剥去方括号（含 `[v6]:port`）与 `%zone`」那条）：
 * `expect(normalizeHost("[::1]")).toBe("::1")` / `expect(normalizeHost("[::1]:443")).toBe("::1")` /
 * `expect(normalizeHost("fe80::1%eth0")).toBe("fe80::1")`。
 * ⚠️ **条目侧刻意不放松**（`normalizeIp` 不认 `]:port`）——那半边**本档没有断言**，
 * 由 `tests/unit/auth-users.test.ts` 的「条目不支持端口」间接兑现
 * （`expect(bad(["example.com:8080"])).toBeUndefined()`）；它是**条目侧**的纪律，不是请求侧的。
 */

import { describe, expect, it } from "vitest";
import { compileHostRules, hostMatches, normalizeHost, parseHostRule } from "@/config/files/rules/index.js";

describe("config/files/rules/host normalizeHost", () => {
  it("小写化并去掉末尾点", () => {
    expect(normalizeHost("Example.COM.")).toBe("example.com");
  });

  it("剥去方括号（含 [v6]:port）与 %zone", () => {
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("[::1]:443")).toBe("::1");
    expect(normalizeHost("fe80::1%eth0")).toBe("fe80::1");
  });

  it("空串/纯空白返回 undefined", () => {
    expect(normalizeHost("")).toBeUndefined();
    expect(normalizeHost("   ")).toBeUndefined();
  });
});

describe("config/files/rules/host parseHostRule", () => {
  it("精确域名归一为小写", () => {
    expect(parseHostRule("Example.COM.")).toEqual({
      kind: "exact",
      name: "example.com",
      source: "Example.COM.",
    });
  });

  it("通配域名编译为后缀形式", () => {
    expect(parseHostRule("*.a.com")).toEqual({
      kind: "wildcard",
      suffix: ".a.com",
      source: "*.a.com",
    });
  });

  it("IP/CIDR 条目（含方括号 IPv6）编译为 ip 规则", () => {
    expect(parseHostRule("10.0.0.0/8")?.kind).toBe("ip");
    expect(parseHostRule("1.2.3.4")?.kind).toBe("ip");
    expect(parseHostRule("[::1]")?.kind).toBe("ip");
  });

  it("非法条目返回 undefined", () => {
    expect(parseHostRule("*")).toBeUndefined();
    expect(parseHostRule("*.")).toBeUndefined();
    expect(parseHostRule("*.a..com")).toBeUndefined();
    expect(parseHostRule("bad domain")).toBeUndefined();
    expect(parseHostRule("bad_domain")).toBeUndefined();
    expect(parseHostRule("")).toBeUndefined();
  });
});

describe("config/files/rules/host hostMatches", () => {
  it("精确域名命中/未命中（不隐式匹配子域）", () => {
    const m = compileHostRules(["example.com"])!;
    expect(hostMatches("example.com", m)).toBe(true);
    expect(hostMatches("Example.COM.", m)).toBe(true);
    expect(hostMatches("www.example.com", m)).toBe(false);
    expect(hostMatches("other.com", m)).toBe(false);
  });

  it("*.a.com 命中子域，但不命中 a.com 本身", () => {
    const m = compileHostRules(["*.a.com"])!;
    expect(hostMatches("x.a.com", m)).toBe(true);
    expect(hostMatches("a.b.a.com", m)).toBe(true);
    expect(hostMatches("a.com", m)).toBe(false);
    expect(hostMatches("nota.com", m)).toBe(false);
  });

  it("CIDR 条目命中 IP 字面量请求", () => {
    const m = compileHostRules(["10.0.0.0/8"])!;
    expect(hostMatches("10.1.2.3", m)).toBe(true);
    expect(hostMatches("11.0.0.1", m)).toBe(false);
  });

  it("[::1] 形态归一后命中 IPv6 规则", () => {
    const m = compileHostRules(["::1"])!;
    expect(hostMatches("[::1]", m)).toBe(true);
    expect(hostMatches("::2", m)).toBe(false);
  });

  it("IP 与域名规则互不串味", () => {
    // IP 规则不命中域名请求
    const ipOnly = compileHostRules(["1.2.3.4"])!;
    expect(hostMatches("example.com", ipOnly)).toBe(false);
    // 域名规则不命中 IP 请求
    const hostOnly = compileHostRules(["example.com"])!;
    expect(hostMatches("1.2.3.4", hostOnly)).toBe(false);
  });

  it("compileHostRules 任一条非法即整体 undefined", () => {
    expect(compileHostRules(["example.com", "bad_host"])).toBeUndefined();
    expect(compileHostRules([])?.exact.size).toBe(0);
  });
});
