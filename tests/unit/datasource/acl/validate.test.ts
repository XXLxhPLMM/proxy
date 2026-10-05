/**
 * `validateAcl` 的结构校验真值表：什么是合法 acl.json（补空 / 非法 / 未知键 / 条目语法）。
 *
 * @description
 * 本档只管**形状**。「这份形状怎么变成放行/拒绝」归判定层
 * （`tests/unit/core/access-control/`），「这条判据有没有被复制成第二份」归同目录
 * `driver-registry.test.ts`，主题级不变量见 `AGENTS.md`。
 */

import { describe, expect, it } from "vitest";
import { validateAcl } from "@/datasource/acl/index.js";

describe("datasource/acl validateAcl 结构校验", () => {
  it("合法：缺省的组/键补空", () => {
    expect(validateAcl({})).toEqual({
      clientIp: { whitelist: [], blacklist: [] },
      target: { whitelist: [], blacklist: [] },
      upstream: { whitelist: [], blacklist: [] },
    });
    expect(validateAcl({ clientIp: { blacklist: ["1.2.3.4"] } })).toEqual({
      clientIp: { whitelist: [], blacklist: ["1.2.3.4"] },
      target: { whitelist: [], blacklist: [] },
      upstream: { whitelist: [], blacklist: [] },
    });
  });

  it("合法：老文件无 upstream 键仍合法（该组补空）", () => {
    const acl = validateAcl({
      clientIp: { blacklist: ["1.2.3.4"] },
      target: { whitelist: ["*.a.com"] },
    });
    expect(acl?.upstream).toEqual({ whitelist: [], blacklist: [] });
  });

  it("合法：target 接受 IP/CIDR/域名/通配域名", () => {
    const acl = validateAcl({
      target: { whitelist: ["example.com", "*.a.com", "10.0.0.0/8", "::1"] },
    });
    expect(acl?.target.whitelist).toEqual(["example.com", "*.a.com", "10.0.0.0/8", "::1"]);
  });

  it("合法：upstream 组与 target 同形（kind host），缺省键补空", () => {
    const acl = validateAcl({
      upstream: {
        whitelist: ["example.com", "*.a.com", "10.0.0.0/8", "::1"],
        blacklist: ["ads.example.net"],
      },
    });
    expect(acl?.upstream.whitelist).toEqual(["example.com", "*.a.com", "10.0.0.0/8", "::1"]);
    expect(acl?.upstream.blacklist).toEqual(["ads.example.net"]);
    expect(validateAcl({ upstream: { whitelist: ["example.com"] } })?.upstream.blacklist).toEqual(
      [],
    );
  });

  it("非法顶层：非对象 / 数组 / 未知键", () => {
    expect(validateAcl(null)).toBeUndefined();
    expect(validateAcl([])).toBeUndefined();
    expect(validateAcl("x")).toBeUndefined();
    expect(validateAcl({ foo: [] })).toBeUndefined();
  });

  it("非法组内：未知键 / 组非对象 / 名单非数组 / 条目非字符串", () => {
    expect(validateAcl({ clientIp: { foo: [] } })).toBeUndefined();
    expect(validateAcl({ clientIp: 1 })).toBeUndefined();
    expect(validateAcl({ clientIp: { whitelist: "1.2.3.4" } })).toBeUndefined();
    expect(validateAcl({ target: { blacklist: [123] } })).toBeUndefined();
  });

  it("非法：upstream 条目带端口 / 通配写法错误 / 未知子键 / 组非对象", () => {
    // 条目不支持端口（与 target 一致）
    expect(validateAcl({ upstream: { blacklist: ["example.com:8080"] } })).toBeUndefined();
    // 非法通配写法（`*.` 只认前缀通配，192.168.*.* 不是合法 host 规则）
    expect(validateAcl({ upstream: { whitelist: ["192.168.*.*"] } })).toBeUndefined();
    // 组内未知子键 / 组非对象 / 名单非数组
    expect(validateAcl({ upstream: { deny: ["a.com"] } })).toBeUndefined();
    expect(validateAcl({ upstream: "x" })).toBeUndefined();
    expect(validateAcl({ upstream: { whitelist: "example.com" } })).toBeUndefined();
  });

  it("clientIp 只收 IP/CIDR（写域名非法）；target 可用通配域名", () => {
    expect(validateAcl({ clientIp: { whitelist: ["example.com"] } })).toBeUndefined();
    expect(validateAcl({ clientIp: { blacklist: ["10.0.0.0/33"] } })).toBeUndefined();
    expect(validateAcl({ target: { whitelist: ["*.a.com"] } })).toBeDefined();
  });
});
