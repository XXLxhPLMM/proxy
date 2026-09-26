import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAcl, readAcl, validateAcl } from "@/config/index.js";
import { checkClientIp, checkTargetHost, checkUpstreamRoute } from "@/core/access-control.js";
import { resolveRoute } from "@/core/helpers/index.js";
import { set, testConfig } from "../helpers/config.js";
import { restoreConfig, snapshotConfig } from "../helpers/config.js";

describe("config/files/acl validateAcl 结构校验", () => {
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

describe("core/access-control 判定语义与热加载", () => {
  let dir: string;
  let snap: Record<string, unknown>;

  beforeEach(() => {
    // 保存并静音日志，避免热加载用例把 warn/落盘写进项目 log 目录
    snap = snapshotConfig(["aclFile", "logLevel", "logFile"]);
    set("logLevel", "silent");
    set("logFile", "");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "acl-test-"));
  });

  afterEach(() => {
    restoreConfig(snap);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 写入 acl.json 并让 store 指向它；每个用例独立文件名，避免命中上一条的节流缓存 */
  function useAcl(name: string, acl: unknown): string {
    const p = path.join(dir, `${name}.json`);
    fs.writeFileSync(p, JSON.stringify(acl));
    set("aclFile", p);
    return p;
  }

  it("readAcl：文件缺失 → 空配置且无 error", () => {
    const r = readAcl({ config: testConfig, force: true, path: path.join(dir, "absent.json") });
    expect(r.exists).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual({
      clientIp: { whitelist: [], blacklist: [] },
      target: { whitelist: [], blacklist: [] },
      upstream: { whitelist: [], blacklist: [] },
    });
  });

  it("clientIp：黑名单命中优先于白名单", () => {
    useAcl("black-first", { clientIp: { whitelist: ["1.2.3.4"], blacklist: ["1.2.3.4"] } });
    expect(checkClientIp("1.2.3.4", testConfig)).toEqual({ allowed: false, reason: "blacklist" });
  });

  it("clientIp：白名单非空即默认拒绝，命中才放行", () => {
    useAcl("whitelist", { clientIp: { whitelist: ["10.0.0.0/8"] } });
    expect(checkClientIp("10.1.2.3", testConfig)).toEqual({ allowed: true });
    expect(checkClientIp("9.9.9.9", testConfig)).toEqual({ allowed: false, reason: "whitelist" });
  });

  it("clientIp：黑名单命中被拒、同族未命中放行", () => {
    useAcl("blacklist", { clientIp: { blacklist: ["2001:db8::/32"] } });
    expect(checkClientIp("2001:db8::1", testConfig)).toEqual({
      allowed: false,
      reason: "blacklist",
    });
    expect(checkClientIp("2001:db9::1", testConfig)).toEqual({ allowed: true });
  });

  it("clientIp：两组皆空 → 全部放行", () => {
    useAcl("empty", {});
    expect(checkClientIp("8.8.8.8", testConfig)).toEqual({ allowed: true });
    expect(checkClientIp("unknown", testConfig)).toEqual({ allowed: true });
  });

  it("clientIp：地址取不到（unknown）遇白名单被拒（fail-closed）", () => {
    useAcl("unknown-wl", { clientIp: { whitelist: ["10.0.0.0/8"] } });
    expect(checkClientIp("unknown", testConfig)).toEqual({ allowed: false, reason: "whitelist" });
  });

  it("target：黑名单优先，白名单非空即默认拒绝", () => {
    useAcl("target-black", { target: { blacklist: ["*.evil.com"] } });
    // `source: "global"` 是 Phase 4b 起拒绝必带的事实（哪一层拒的）：不带 `user` 参数时
    // 个人层中性放行，故此处恒为全局层。断言变**强**（多锁一个字段），不是放宽。
    expect(checkTargetHost("x.evil.com", testConfig)).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "global",
    });
    expect(checkTargetHost("good.com", testConfig)).toEqual({ allowed: true });

    useAcl("target-white", { target: { whitelist: ["example.com"] } });
    expect(checkTargetHost("example.com", testConfig)).toEqual({ allowed: true });
    expect(checkTargetHost("other.com", testConfig)).toEqual({
      allowed: false,
      reason: "whitelist",
      source: "global",
    });
  });

  it("target：IP 字面量与域名条目互不串味", () => {
    useAcl("target-ip", { target: { whitelist: ["10.0.0.0/8"] } });
    expect(checkTargetHost("10.1.2.3", testConfig)).toEqual({ allowed: true });
    expect(checkTargetHost("example.com", testConfig)).toEqual({
      allowed: false,
      reason: "whitelist",
      source: "global",
    });
  });

  it("upstream：皆空（含整组缺失/空组）→ 走上游", () => {
    useAcl("up-empty", {});
    expect(checkUpstreamRoute("a.com", testConfig)).toEqual({ direct: false });
    expect(checkUpstreamRoute("1.2.3.4", testConfig)).toEqual({ direct: false });

    useAcl("up-blank", { upstream: {} });
    expect(checkUpstreamRoute("a.com", testConfig)).toEqual({ direct: false });
  });

  it("upstream：黑名单命中优先直连，盖过白名单命中", () => {
    // whitelist `*.a.com` + blacklist `secret.a.com`：黑名单盖章 → 直连而非走上游
    useAcl("up-black", {
      upstream: { whitelist: ["*.a.com"], blacklist: ["secret.a.com"] },
    });
    expect(checkUpstreamRoute("secret.a.com", testConfig)).toEqual({
      direct: true,
      reason: "blacklist",
    });
    // 子域命中白名单 → 走上游
    expect(checkUpstreamRoute("sub.a.com", testConfig)).toEqual({ direct: false });
    // 白名单非空且未命中 → 直连
    expect(checkUpstreamRoute("other.com", testConfig)).toEqual({
      direct: true,
      reason: "whitelist",
    });
    // `*.a.com` 不含裸域 a.com → 未命中白名单 → 直连
    expect(checkUpstreamRoute("a.com", testConfig)).toEqual({ direct: true, reason: "whitelist" });
  });

  it("upstream：仅白名单时命中走上游、圈外直连", () => {
    useAcl("up-white", { upstream: { whitelist: ["example.com"] } });
    expect(checkUpstreamRoute("example.com", testConfig)).toEqual({ direct: false });
    expect(checkUpstreamRoute("other.com", testConfig)).toEqual({
      direct: true,
      reason: "whitelist",
    });
  });

  it("upstream：IP/CIDR 条目按 IP 字面量命中，与域名条目互不串味", () => {
    useAcl("up-ip", {
      upstream: { whitelist: ["10.0.0.0/8"], blacklist: ["192.168.1.1"] },
    });
    expect(checkUpstreamRoute("10.1.2.3", testConfig)).toEqual({ direct: false });
    expect(checkUpstreamRoute("192.168.1.1", testConfig)).toEqual({
      direct: true,
      reason: "blacklist",
    });
    expect(checkUpstreamRoute("9.9.9.9", testConfig)).toEqual({
      direct: true,
      reason: "whitelist",
    });
    // 域名请求不命中 IP 条目 → 白名单非空未命中 → 直连
    expect(checkUpstreamRoute("example.com", testConfig)).toEqual({
      direct: true,
      reason: "whitelist",
    });
  });

  it("resolveRoute：server 模式短路恒直连，不查 upstream 组（无 reason）", () => {
    useAcl("route-server", {
      upstream: { blacklist: ["a.com"], whitelist: ["b.com"] },
    });
    const prev = snapshotConfig(["proxyMode"]);
    try {
      set("proxyMode", "server");
      expect(resolveRoute({ host: "a.com", port: 80 }, testConfig)).toEqual({
        mode: "server",
        route: "direct",
      });
      expect(resolveRoute({ host: "other.com", port: 80 }, testConfig)).toEqual({
        mode: "server",
        route: "direct",
      });
    } finally {
      restoreConfig(prev);
    }
  });

  it("resolveRoute：client 模式三分支——命中回落直连（带 reason）、未命中走上游", () => {
    const prev = snapshotConfig(["proxyMode"]);
    try {
      set("proxyMode", "client");

      // 无 upstream 组 → 默认全走上游（向后兼容）
      useAcl("route-no-group", {});
      expect(resolveRoute({ host: "a.com", port: 80 }, testConfig)).toEqual({
        mode: "client",
        route: "upstream",
      });

      useAcl("route-groups", {
        upstream: { blacklist: ["a.com"], whitelist: ["b.com"] },
      });
      // blacklist 命中 → 直连（优先）
      expect(resolveRoute({ host: "a.com", port: 80 }, testConfig)).toEqual({
        mode: "server",
        route: "direct",
        reason: "blacklist",
      });
      // whitelist 非空且命中 → 走上游
      expect(resolveRoute({ host: "b.com", port: 80 }, testConfig)).toEqual({
        mode: "client",
        route: "upstream",
      });
      // whitelist 非空且未命中 → 直连
      expect(resolveRoute({ host: "c.com", port: 80 }, testConfig)).toEqual({
        mode: "server",
        route: "direct",
        reason: "whitelist",
      });
    } finally {
      restoreConfig(prev);
    }
  });

  it("loadAcl：经 store 指向的文件读取，非法内容保留上一份有效值并记 error", () => {
    const p = useAcl("load", { clientIp: { blacklist: ["1.2.3.4"] } });
    expect(loadAcl(testConfig).clientIp.blacklist).toEqual(["1.2.3.4"]);

    // clientIp 组写域名 → 非法
    fs.writeFileSync(p, JSON.stringify({ clientIp: { whitelist: ["example.com"] } }));
    const r = readAcl({ config: testConfig, force: true });
    expect(r.error).toBeTruthy();
    expect(r.value.clientIp.blacklist).toEqual(["1.2.3.4"]);
  });

  it("热加载：越过 1s 节流后新名单生效（fake timers 控制时钟）", () => {
    vi.useFakeTimers();
    try {
      const p = path.join(dir, "hot.json");
      fs.writeFileSync(p, JSON.stringify({ clientIp: { blacklist: ["1.2.3.4"] } }));
      set("aclFile", p);
      expect(checkClientIp("1.2.3.4", testConfig)).toEqual({ allowed: false, reason: "blacklist" });

      fs.writeFileSync(p, JSON.stringify({ clientIp: {} }));
      // 未越过节流：仍是旧名单
      expect(checkClientIp("1.2.3.4", testConfig)).toEqual({ allowed: false, reason: "blacklist" });

      vi.advanceTimersByTime(1500);
      expect(checkClientIp("1.2.3.4", testConfig)).toEqual({ allowed: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
