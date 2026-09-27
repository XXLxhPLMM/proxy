import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkClientIp, checkTargetHost, loadAcl, readAcl, validateAcl } from "@/config/acl.js";
import { set } from "@/config/store.js";
import { restoreConfig, snapshotConfig } from "../helpers/config.js";

describe("config/acl validateAcl 结构校验", () => {
  it("合法：缺省的组/键补空", () => {
    expect(validateAcl({})).toEqual({
      clientIp: { whitelist: [], blacklist: [] },
      target: { whitelist: [], blacklist: [] },
    });
    expect(validateAcl({ clientIp: { blacklist: ["1.2.3.4"] } })).toEqual({
      clientIp: { whitelist: [], blacklist: ["1.2.3.4"] },
      target: { whitelist: [], blacklist: [] },
    });
  });

  it("合法：target 接受 IP/CIDR/域名/通配域名", () => {
    const acl = validateAcl({
      target: { whitelist: ["example.com", "*.a.com", "10.0.0.0/8", "::1"] },
    });
    expect(acl?.target.whitelist).toEqual(["example.com", "*.a.com", "10.0.0.0/8", "::1"]);
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

  it("clientIp 只收 IP/CIDR（写域名非法）；target 可用通配域名", () => {
    expect(validateAcl({ clientIp: { whitelist: ["example.com"] } })).toBeUndefined();
    expect(validateAcl({ clientIp: { blacklist: ["10.0.0.0/33"] } })).toBeUndefined();
    expect(validateAcl({ target: { whitelist: ["*.a.com"] } })).toBeDefined();
  });
});

describe("config/acl 判定语义与热加载", () => {
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
    const r = readAcl({ force: true, path: path.join(dir, "absent.json") });
    expect(r.exists).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual({
      clientIp: { whitelist: [], blacklist: [] },
      target: { whitelist: [], blacklist: [] },
    });
  });

  it("clientIp：黑名单命中优先于白名单", () => {
    useAcl("black-first", { clientIp: { whitelist: ["1.2.3.4"], blacklist: ["1.2.3.4"] } });
    expect(checkClientIp("1.2.3.4")).toEqual({ allowed: false, reason: "blacklist" });
  });

  it("clientIp：白名单非空即默认拒绝，命中才放行", () => {
    useAcl("whitelist", { clientIp: { whitelist: ["10.0.0.0/8"] } });
    expect(checkClientIp("10.1.2.3")).toEqual({ allowed: true });
    expect(checkClientIp("9.9.9.9")).toEqual({ allowed: false, reason: "whitelist" });
  });

  it("clientIp：黑名单命中被拒、同族未命中放行", () => {
    useAcl("blacklist", { clientIp: { blacklist: ["2001:db8::/32"] } });
    expect(checkClientIp("2001:db8::1")).toEqual({ allowed: false, reason: "blacklist" });
    expect(checkClientIp("2001:db9::1")).toEqual({ allowed: true });
  });

  it("clientIp：两组皆空 → 全部放行", () => {
    useAcl("empty", {});
    expect(checkClientIp("8.8.8.8")).toEqual({ allowed: true });
    expect(checkClientIp("unknown")).toEqual({ allowed: true });
  });

  it("clientIp：地址取不到（unknown）遇白名单被拒（fail-closed）", () => {
    useAcl("unknown-wl", { clientIp: { whitelist: ["10.0.0.0/8"] } });
    expect(checkClientIp("unknown")).toEqual({ allowed: false, reason: "whitelist" });
  });

  it("target：黑名单优先，白名单非空即默认拒绝", () => {
    useAcl("target-black", { target: { blacklist: ["*.evil.com"] } });
    expect(checkTargetHost("x.evil.com")).toEqual({ allowed: false, reason: "blacklist" });
    expect(checkTargetHost("good.com")).toEqual({ allowed: true });

    useAcl("target-white", { target: { whitelist: ["example.com"] } });
    expect(checkTargetHost("example.com")).toEqual({ allowed: true });
    expect(checkTargetHost("other.com")).toEqual({ allowed: false, reason: "whitelist" });
  });

  it("target：IP 字面量与域名条目互不串味", () => {
    useAcl("target-ip", { target: { whitelist: ["10.0.0.0/8"] } });
    expect(checkTargetHost("10.1.2.3")).toEqual({ allowed: true });
    expect(checkTargetHost("example.com")).toEqual({ allowed: false, reason: "whitelist" });
  });

  it("loadAcl：经 store 指向的文件读取，非法内容保留上一份有效值并记 error", () => {
    const p = useAcl("load", { clientIp: { blacklist: ["1.2.3.4"] } });
    expect(loadAcl().clientIp.blacklist).toEqual(["1.2.3.4"]);

    // clientIp 组写域名 → 非法
    fs.writeFileSync(p, JSON.stringify({ clientIp: { whitelist: ["example.com"] } }));
    const r = readAcl({ force: true });
    expect(r.error).toBeTruthy();
    expect(r.value.clientIp.blacklist).toEqual(["1.2.3.4"]);
  });

  it("热加载：越过 1s 节流后新名单生效（fake timers 控制时钟）", () => {
    vi.useFakeTimers();
    try {
      const p = path.join(dir, "hot.json");
      fs.writeFileSync(p, JSON.stringify({ clientIp: { blacklist: ["1.2.3.4"] } }));
      set("aclFile", p);
      expect(checkClientIp("1.2.3.4")).toEqual({ allowed: false, reason: "blacklist" });

      fs.writeFileSync(p, JSON.stringify({ clientIp: {} }));
      // 未越过节流：仍是旧名单
      expect(checkClientIp("1.2.3.4")).toEqual({ allowed: false, reason: "blacklist" });

      vi.advanceTimersByTime(1500);
      expect(checkClientIp("1.2.3.4")).toEqual({ allowed: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
