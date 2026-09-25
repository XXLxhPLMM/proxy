import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { get, set, testConfig } from "../helpers/config.js";
import { loadCerts, readUpstreamCa, requiresClientCert } from "@/utils/cert.js";
import { TEST_CA_PATH, TEST_TLS_PATHS } from "../helpers/certs.js";

describe("utils/cert:readUpstreamCa", () => {
  let prev: string;
  let dir: string;

  beforeEach(() => {
    prev = get("upstreamCa");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-ca-"));
  });

  afterEach(() => {
    set("upstreamCa", prev);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("未配置时返回 undefined（回退系统信任库，公网上游才能校验通过）", () => {
    set("upstreamCa", "");
    expect(readUpstreamCa(testConfig)).toBeUndefined();
  });

  it("配置为普通文件时返回其内容", () => {
    const p = path.join(dir, "ca.crt");
    fs.writeFileSync(p, "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
    set("upstreamCa", p);
    expect(readUpstreamCa(testConfig)?.toString()).toContain("BEGIN CERTIFICATE");
  });

  it("路径不存在时返回 undefined（回退系统信任库）", () => {
    set("upstreamCa", path.join(dir, "missing.crt"));
    expect(readUpstreamCa(testConfig)).toBeUndefined();
  });

  it("路径是目录时返回 undefined（避免 readFileSync EISDIR）", () => {
    set("upstreamCa", dir);
    expect(readUpstreamCa(testConfig)).toBeUndefined();
  });
});

describe("utils/cert:loadCerts 的 mTLS 语义", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "load-certs-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("未配 ca：不要求客户端证书（只做服务端 TLS）", () => {
    const certs = loadCerts(TEST_TLS_PATHS);
    expect(certs.ca).toBeUndefined();
    expect(requiresClientCert(certs)).toBe(false);
  });

  it("ca 为空串：等同未配，不要求客户端证书", () => {
    const certs = loadCerts({ ...TEST_TLS_PATHS, ca: "" });
    expect(certs.ca).toBeUndefined();
    expect(requiresClientCert(certs)).toBe(false);
  });

  it("配了 ca：加载成功即要求客户端证书（mTLS 开关）", () => {
    const certs = loadCerts({ ...TEST_TLS_PATHS, ca: TEST_CA_PATH });
    expect(certs.ca?.toString()).toContain("BEGIN CERTIFICATE");
    expect(requiresClientCert(certs)).toBe(true);
  });

  it("配了 ca 但文件不存在：抛错（绝不静默降级为不校验）", () => {
    expect(() => loadCerts({ ...TEST_TLS_PATHS, ca: path.join(dir, "missing-ca.crt") })).toThrow(
      /ENOENT/,
    );
  });

  it("配了 ca 但路径是目录：抛错（旧实现静默跳过，等于谎称已开 mTLS）", () => {
    expect(() => loadCerts({ ...TEST_TLS_PATHS, ca: dir })).toThrow();
  });

  it("加载失败时错误日志带 ca 路径，便于定位挂载错误", () => {
    const missing = path.join(dir, "missing-ca.crt");
    const logs: string[] = [];
    const fakeLogger = { error: (msg: string): void => void logs.push(msg) };
    expect(() => loadCerts({ ...TEST_TLS_PATHS, ca: missing }, fakeLogger, "[test]")).toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(missing);
  });
});
