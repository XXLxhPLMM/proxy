/**
 * 名单条目语法层 `addr/host`：`normalizeHost` 归一 / `parseHostRule` 编译 / `hostMatches` 匹配。
 * 本档三条**独有**否决：域名正则刻意拒绝 IDN 与下划线（静默接受会让「写错但没报错」的条目永不命中）、
 * `*` 通配**不含 apex**（否则「只开放 `api.a.com`」会顺带开放 `a.com`）、精确与通配不隐式包含。
 * 另两条与 `ip-rule.test.ts` 共用的不变量（fail-closed 整体 `undefined`、带端口 authority 归一）
 * 与数据层那半边的对咬位置在 `./AGENTS.md`。
 * @module tests/unit/utils/addr
 */

import { describe, expect, it } from "vitest";
import { compileHostRules, hostMatches, normalizeHost, parseHostRule } from "@/utils/addr/index.js";

describe("addr/host normalizeHost", () => {
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

describe("addr/host parseHostRule", () => {
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

describe("addr/host hostMatches", () => {
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
