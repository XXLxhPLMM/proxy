import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readAcl } from "@/config/acl.js";
import { set, testConfig } from "../helpers/config.js";
import { HttpProxy } from "@/core/server/http.js";
import type { ConfigKey } from "@/config/store.js";
import { getFreePort, listen, sleep } from "../helpers/net.js";
import { withProxy } from "../helpers/proxy.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../helpers/config.js";

/**
 * 访问控制（acl.json）在 HTTP 入站的端到端行为：
 * - 客户端来源名单（黑名单命中 / 白名单非空未命中）→ 403 且不触达目标
 * - 目标名单（IP/CIDR 与域名两套规则）→ 403 且不拨号
 * - 空名单与缺失文件 → 不拦任何请求
 * - 热加载：改文件后无需重启（1s 节流窗口过后生效）
 */

const KEYS: readonly ConfigKey[] = [
  "aclFile",
  "authEnabled",
  "authType",
  "logLevel",
  "logFile",
];

/** 采集一次原始 HTTP 往返（绝对形式请求直发代理） */
function rawRequest(port: number, requestLine: string, headers: string[] = []): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write([requestLine, ...headers, "Connection: close", "", ""].join("\r\n"));
    });
    let buf = "";
    sock.on("data", (c: Buffer) => {
      buf += c.toString();
    });
    sock.on("close", () => resolve(buf));
    sock.on("error", () => {
      // close 仍会触发，结果按已收到的字节判定
    });
  });
}

describe("integration/http-acl-guard", () => {
  let snap: Record<string, unknown>;
  let dir: string;
  let aclPath: string;
  let origin: http.Server;
  let originPort: number;
  let originHits: number;

  beforeEach(async () => {
    snap = snapshotConfig(KEYS);
    silenceLogs();
    set("authEnabled", false);
    set("authType", "none");

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-acl-"));
    aclPath = path.join(dir, "acl.json");
    set("aclFile", aclPath);

    originHits = 0;
    origin = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      originHits++;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`origin-ok:${req.url}`);
    });
    originPort = await getFreePort();
    await listen(origin, originPort);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      origin.closeAllConnections?.();
      origin.close(() => resolve());
    });
    fs.rmSync(dir, { recursive: true, force: true });
    restoreConfig(snap);
  });

  /** 写 acl.json 并强制重读（跳过 1s 节流，等价于节流窗口已过） */
  function writeAcl(acl: unknown): void {
    fs.writeFileSync(aclPath, JSON.stringify(acl));
    readAcl({ config: testConfig, force: true });
  }

  it("名单文件缺失：不拦任何请求", async () => {
    fs.rmSync(aclPath, { force: true });
    readAcl({ config: testConfig, force: true });

    await withProxy(HttpProxy, {}, async (port) => {
      const res = await rawRequest(port, `GET http://127.0.0.1:${originPort}/a HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
      ]);
      expect(res.startsWith("HTTP/1.1 200")).toBe(true);
      expect(res).toContain("origin-ok:/a");
      expect(originHits).toBe(1);
    });
  });

  it("客户端 IP 黑名单命中：回 403 且不触达目标", async () => {
    writeAcl({ clientIp: { blacklist: ["127.0.0.1"] } });

    await withProxy(HttpProxy, {}, async (port) => {
      const res = await rawRequest(port, `GET http://127.0.0.1:${originPort}/b HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
      ]);
      expect(res.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);
      expect(originHits).toBe(0);
    });
  });

  it("客户端 IP 白名单：不含本机则拒，含本机则放行", async () => {
    writeAcl({ clientIp: { whitelist: ["10.0.0.0/8"] } });
    await withProxy(HttpProxy, {}, async (port) => {
      const res = await rawRequest(port, `GET http://127.0.0.1:${originPort}/c HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
      ]);
      expect(res.startsWith("HTTP/1.1 403")).toBe(true);
      expect(originHits).toBe(0);
    });

    writeAcl({ clientIp: { whitelist: ["127.0.0.0/8", "::1"] } });
    await withProxy(HttpProxy, {}, async (port) => {
      const res = await rawRequest(port, `GET http://127.0.0.1:${originPort}/d HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
      ]);
      expect(res.startsWith("HTTP/1.1 200")).toBe(true);
      expect(originHits).toBe(1);
    });
  });

  it("目标名单：IP/CIDR 与域名两套规则各自生效且不拨号", async () => {
    writeAcl({ target: { blacklist: ["127.0.0.0/8"] } });
    await withProxy(HttpProxy, {}, async (port) => {
      const res = await rawRequest(port, `GET http://127.0.0.1:${originPort}/e HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
      ]);
      expect(res.startsWith("HTTP/1.1 403")).toBe(true);
      expect(originHits).toBe(0);
    });

    // 域名条目按客户端请求的 host 字符串匹配，未拨号故不涉及 DNS
    writeAcl({ target: { blacklist: ["blocked.invalid"] } });
    await withProxy(HttpProxy, {}, async (port) => {
      const res = await rawRequest(port, "GET http://blocked.invalid/f HTTP/1.1", [
        "Host: blocked.invalid",
      ]);
      expect(res.startsWith("HTTP/1.1 403")).toBe(true);
    });

    // 通配只匹配子域：a.invalid 命中 *.invalid，裸 invalid 不命中
    writeAcl({ target: { blacklist: ["*.invalid"] } });
    await withProxy(HttpProxy, {}, async (port) => {
      const hit = await rawRequest(port, "GET http://a.invalid/g HTTP/1.1", ["Host: a.invalid"]);
      expect(hit.startsWith("HTTP/1.1 403")).toBe(true);

      const miss = await rawRequest(port, "GET http://invalid/h HTTP/1.1", ["Host: invalid"]);
      // 未命中黑名单 → 放行到拨号阶段（不存在的主机名 → 502，而非 403）
      expect(miss.startsWith("HTTP/1.1 403")).toBe(false);
    });
  });

  it("目标白名单非空：名单外一律拒，名单内放行（放行后失败于拨号而非名单）", async () => {
    writeAcl({ target: { whitelist: ["127.0.0.1"] } });
    await withProxy(HttpProxy, {}, async (port) => {
      const denied = await rawRequest(port, "GET http://other.invalid/i HTTP/1.1", [
        "Host: other.invalid",
      ]);
      expect(denied.startsWith("HTTP/1.1 403")).toBe(true);

      const allowed = await rawRequest(port, `GET http://127.0.0.1:${originPort}/j HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
      ]);
      expect(allowed.startsWith("HTTP/1.1 200")).toBe(true);
      expect(originHits).toBe(1);
    });
  });

  it("CONNECT 隧道同样受目标名单约束：403 而非 200", async () => {
    writeAcl({ target: { blacklist: ["127.0.0.1"] } });
    await withProxy(HttpProxy, {}, async (port) => {
      const res = await rawRequest(port, `CONNECT 127.0.0.1:${originPort} HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
      ]);
      expect(res.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);
      expect(originHits).toBe(0);
    });
  });

  it("热加载：改 acl.json 后无需重启即生效（1s 节流窗口过后）", async () => {
    writeAcl({});
    await withProxy(HttpProxy, {}, async (port) => {
      const before = await rawRequest(port, `GET http://127.0.0.1:${originPort}/k HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
      ]);
      expect(before.startsWith("HTTP/1.1 200")).toBe(true);

      // 直接改文件、不调用任何 force：靠 mtime 热加载
      fs.writeFileSync(aclPath, JSON.stringify({ clientIp: { blacklist: ["127.0.0.1"] } }));
      await sleep(1100);

      const after = await rawRequest(port, `GET http://127.0.0.1:${originPort}/l HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
      ]);
      expect(after.startsWith("HTTP/1.1 403")).toBe(true);
    });
  });

  it("名单条目非法：读取报错且不接管坏数据（沿用上一份有效值）", () => {
    const bad = { target: { blacklist: ["not a host"] }, clientIp: {} };
    fs.writeFileSync(aclPath, JSON.stringify(bad));
    const r = readAcl({ config: testConfig, force: true, path: aclPath });
    expect(r.error).toBeTruthy();
    // 坏内容不接管：沿用上一份有效值（该路径此前无有效值，故为空配置）
    expect(r.value.target.blacklist).toHaveLength(0);
  });
});
