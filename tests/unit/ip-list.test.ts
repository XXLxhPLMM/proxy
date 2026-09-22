import { describe, expect, it } from "vitest";
import {
  compileIpRules,
  ipMatches,
  ipv6BytesToString,
  normalizeIp,
  parseIpRule,
} from "@/utils/ip-list.js";

// 说明：断言刻意不绑定内部数值形态（uint32 / BigInt / 字节缓冲），
// 只校验地址族、前缀位数、条目文本与匹配行为——实现换表示法也不应影响这些语义。

describe("utils/ip-list normalizeIp", () => {
  it("识别 IPv4 / IPv6 地址族", () => {
    expect(normalizeIp("1.2.3.4")?.family).toBe(4);
    expect(normalizeIp("0.0.0.0")?.family).toBe(4);
    expect(normalizeIp("255.255.255.255")?.family).toBe(4);
    expect(normalizeIp("::1")?.family).toBe(6);
    expect(normalizeIp("2001:db8::1")?.family).toBe(6);
  });

  it("解析结果随地址内容变化（值被真实解析而非占位）", () => {
    expect(normalizeIp("1.2.3.4")).not.toEqual(normalizeIp("1.2.3.5"));
    expect(normalizeIp("::1")).not.toEqual(normalizeIp("::2"));
  });

  it("v4-mapped 的两种写法都归一为 IPv4（与点分形态等价）", () => {
    // 双栈/Windows 下对端地址常为 ::ffff:127.0.0.1，不归一则 IPv4 规则永不命中
    expect(normalizeIp("::ffff:127.0.0.1")?.family).toBe(4);
    expect(normalizeIp("::ffff:127.0.0.1")).toEqual(normalizeIp("127.0.0.1"));
    expect(normalizeIp("::ffff:7f00:1")?.family).toBe(4);
    expect(normalizeIp("::ffff:7f00:1")).toEqual(normalizeIp("127.0.0.1"));
  });

  it("剥方括号与 %zone，且大小写不敏感", () => {
    expect(normalizeIp("[::1]")).toEqual(normalizeIp("::1"));
    expect(normalizeIp("FE80::1%eth0")).toEqual(normalizeIp("fe80::1"));
  });

  it("非法地址返回 undefined", () => {
    expect(normalizeIp("300.1.1.1")).toBeUndefined();
    expect(normalizeIp("1.2.3.4.5")).toBeUndefined();
    expect(normalizeIp("abc")).toBeUndefined();
    expect(normalizeIp("")).toBeUndefined();
  });
});

describe("utils/ip-list parseIpRule", () => {
  it("单 IP 默认满位（v4 为 /32、v6 为 /128）", () => {
    expect(parseIpRule("1.2.3.4")).toMatchObject({ family: 4, bits: 32, source: "1.2.3.4" });
    expect(parseIpRule("::1")).toMatchObject({ family: 6, bits: 128, source: "::1" });
  });

  it("CIDR 记录前缀位数（含 /0 与 /32）", () => {
    expect(parseIpRule("10.0.0.0/8")).toMatchObject({ family: 4, bits: 8, source: "10.0.0.0/8" });
    expect(parseIpRule("0.0.0.0/0")).toMatchObject({ family: 4, bits: 0, source: "0.0.0.0/0" });
    expect(parseIpRule("1.2.3.4/32")?.bits).toBe(32);
  });

  it("IPv6 CIDR：/32、/128、/0 与前缀越界", () => {
    expect(parseIpRule("2001:db8::/32")).toMatchObject({
      family: 6,
      bits: 32,
      source: "2001:db8::/32",
    });
    expect(parseIpRule("2001:db8::1/128")?.bits).toBe(128);
    expect(parseIpRule("::/0")).toMatchObject({ family: 6, bits: 0, source: "::/0" });
    expect(parseIpRule("::1/129")).toBeUndefined();
  });

  it("网段基址随地址内容变化（基址被真实解析）", () => {
    expect(parseIpRule("10.0.0.0/8")).not.toEqual(parseIpRule("11.0.0.0/8"));
    expect(parseIpRule("2001:db8::/32")).not.toEqual(parseIpRule("2001:db9::/32"));
  });

  it("非法条目返回 undefined（越界/坏地址/空串/缺前缀/非数字前缀）", () => {
    expect(parseIpRule("10.0.0.0/33")).toBeUndefined();
    expect(parseIpRule("300.1.1.1")).toBeUndefined();
    expect(parseIpRule("abc")).toBeUndefined();
    expect(parseIpRule("")).toBeUndefined();
    expect(parseIpRule("1.2.3.4/")).toBeUndefined();
    expect(parseIpRule("1.2.3.4/x")).toBeUndefined();
  });
});

describe("utils/ip-list ipMatches", () => {
  const v4 = compileIpRules(["10.0.0.0/8", "192.168.1.1"])!;
  const v6 = compileIpRules(["2001:db8::/32", "::1"])!;

  it("单 IP 与 CIDR 命中", () => {
    expect(ipMatches("10.1.2.3", v4)).toBe(true);
    expect(ipMatches("192.168.1.1", v4)).toBe(true);
    expect(ipMatches("192.168.1.2", v4)).toBe(false);
    expect(ipMatches("11.0.0.1", v4)).toBe(false);
  });

  it("0.0.0.0/0 匹配任意 IPv4", () => {
    const all = compileIpRules(["0.0.0.0/0"])!;
    expect(ipMatches("1.2.3.4", all)).toBe(true);
    expect(ipMatches("255.255.255.255", all)).toBe(true);
  });

  it("IPv6 规则只命中本族；::/0 匹配任意 IPv6", () => {
    expect(ipMatches("2001:db8::1", v6)).toBe(true);
    expect(ipMatches("2001:db9::1", v6)).toBe(false);
    expect(ipMatches("::1", v6)).toBe(true);
    const all6 = compileIpRules(["::/0"])!;
    expect(ipMatches("2001:db8::dead:beef", all6)).toBe(true);
  });

  it("v4-mapped 地址命中 IPv4 规则", () => {
    expect(ipMatches("::ffff:10.1.2.3", v4)).toBe(true);
    expect(ipMatches("::ffff:a01:203", v4)).toBe(true);
  });

  it("族不交叉：IPv4 规则不命中 IPv6 地址，反之亦然", () => {
    expect(ipMatches("::1", v4)).toBe(false);
    expect(ipMatches("1.2.3.4", v6)).toBe(false);
    expect(ipMatches("::ffff:1.2.3.4", v6)).toBe(false);
  });

  it("空规则集恒 false；非法地址恒 false", () => {
    expect(ipMatches("1.2.3.4", [])).toBe(false);
    expect(ipMatches("not-an-ip", v4)).toBe(false);
  });
});

describe("utils/ip-list compileIpRules", () => {
  it("全部合法时逐条编译并保留顺序", () => {
    const rules = compileIpRules(["1.2.3.4", "10.0.0.0/8", "::1"]);
    expect(rules?.map((r) => r.source)).toEqual(["1.2.3.4", "10.0.0.0/8", "::1"]);
  });

  it("任一条非法即整体 undefined（fail-closed 交给调用方）", () => {
    expect(compileIpRules(["1.2.3.4", "bad"])).toBeUndefined();
    expect(compileIpRules(["10.0.0.0/33"])).toBeUndefined();
  });

  it("空数组编译为空规则集", () => {
    expect(compileIpRules([])).toEqual([]);
  });
});

describe("utils/ip-list ipv6BytesToString", () => {
  const bytes = (hex: string): Buffer => Buffer.from(hex.replace(/:/g, ""), "hex");

  it("零段压缩与特殊形态（::1 / :: / 全写无零段）", () => {
    expect(ipv6BytesToString(bytes("0000:0000:0000:0000:0000:0000:0000:0001"))).toBe("::1");
    expect(ipv6BytesToString(Buffer.alloc(16))).toBe("::");
    expect(ipv6BytesToString(bytes("2001:0db8:0001:0002:0003:0004:0005:0006"))).toBe(
      "2001:db8:1:2:3:4:5:6",
    );
  });

  it("最长零段压缩、并列取首段、单零组不压缩", () => {
    expect(ipv6BytesToString(bytes("2001:0db8:0000:0000:0000:00ff:0000:0001"))).toBe(
      "2001:db8::ff:0:1",
    );
    // 两处等长零段压缩首段
    expect(ipv6BytesToString(bytes("2001:0000:0000:0001:0000:0000:0002:0003"))).toBe(
      "2001::1:0:0:2:3",
    );
    // 单个零组不压缩
    expect(ipv6BytesToString(bytes("2001:0db8:0000:0001:0002:0003:0004:0005"))).toBe(
      "2001:db8:0:1:2:3:4:5",
    );
  });

  it("与 parseIpv6 往返一致（normalizeIp 可再解析）", () => {
    for (const s of ["::1", "::", "2001:db8::ff:0:1", "2408:871a:2100:1b23:0:ff:b07a:7ebc"]) {
      const norm = normalizeIp(s);
      expect(norm?.family).toBe(6);
      expect(ipv6BytesToString(norm!.bytes)).toBe(s);
    }
  });
});
