import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { get, set } from "@/config/store.js";
import { readUpstreamCa } from "@/utils/cert.js";

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
    expect(readUpstreamCa()).toBeUndefined();
  });

  it("配置为普通文件时返回其内容", () => {
    const p = path.join(dir, "ca.crt");
    fs.writeFileSync(p, "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
    set("upstreamCa", p);
    expect(readUpstreamCa()?.toString()).toContain("BEGIN CERTIFICATE");
  });

  it("路径不存在时返回 undefined（回退系统信任库）", () => {
    set("upstreamCa", path.join(dir, "missing.crt"));
    expect(readUpstreamCa()).toBeUndefined();
  });

  it("路径是目录时返回 undefined（避免 readFileSync EISDIR）", () => {
    set("upstreamCa", dir);
    expect(readUpstreamCa()).toBeUndefined();
  });
});
