import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readAcl } from "@/config/acl.js";
import { set } from "@/config/store.js";
import type { ConfigKey } from "@/config/store.js";
import { HttpProxy } from "@/core/server/http.js";
import { getFreePort, listen, sleep } from "../helpers/net.js";
import { withProxy } from "../helpers/proxy.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../helpers/config.js";

/**
 * client 模式（串联上游）下的目标名单语义 —— 与 server 模式同一套：
 * - 判定对象永远是「客户端请求的目标」：absolute-form 的 authority，缺失时回退 Host（不做 DNS）
 * - 上游的协议/地址/端口只来自 `UPSTREAM_*`，**不受名单约束**：上游属基础设施，不是「目标网站」。
 *   旧实现把上游当目标送进判定，后果是双向的：黑名单写上上游会拦掉自己的串联，
 *   而客户端真正要访问的站点反而无人检查。
 * 上游用 http 桩（记命中数、request-target 与 Upgrade 握手 Host），无需起第二个真代理。
 */

const KEYS: readonly ConfigKey[] = [
  "aclFile",
  "proxyMode",
  "upstreamProtocol",
  "upstreamHost",
  "upstreamPort",
  "authEnabled",
  "authType",
  "logLevel",
  "logFile",
];

/** 采集一次原始往返（给整段原始报文，Upgrade 与普通请求共用；不加任何额外头） */
function rawRequest(port: number, raw: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(raw);
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

/** 标准 Upgrade 握手报文（Host 即「客户端请求的目标」） */
function upgradeReq(host: string): string {
  return [
    "GET /ws HTTP/1.1",
    `Host: ${host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
}

describe("integration/client-mode-acl", () => {
  let snap: Record<string, unknown>;
  let dir: string;
  let aclPath: string;
  let upstream: http.Server;
  let upstreamPort: number;
  let upstreamHits: number;
  let upgradeHosts: string[];

  beforeEach(async () => {
    snap = snapshotConfig(KEYS);
    silenceLogs();
    set("authEnabled", false);
    set("authType", "none");

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-client-acl-"));
    aclPath = path.join(dir, "acl.json");
    set("aclFile", aclPath);

    upstreamHits = 0;
    upgradeHosts = [];
    upstream = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      upstreamHits++;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`upstream-ok:${req.url}`);
    });
    // Upgrade 通道：只记录握手 Host —— 它必须是「被访问的站点」，而不是上游地址
    upstream.on("upgrade", (req: http.IncomingMessage, socket: net.Socket) => {
      upgradeHosts.push(req.headers.host ?? "");
      socket.destroy();
    });
    upstreamPort = await getFreePort();
    await listen(upstream, upstreamPort);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      upstream.closeAllConnections?.();
      upstream.close(() => resolve());
    });
    fs.rmSync(dir, { recursive: true, force: true });
    restoreConfig(snap);
  });

  /** 写 acl.json 并强制重读（跳过 1s 节流，等价于节流窗口已过） */
  function writeAcl(acl: unknown): void {
    fs.writeFileSync(aclPath, JSON.stringify(acl));
    readAcl({ force: true });
  }

  /** client 模式起前置代理：拨号目标是上游桩，名单判定的应是客户端请求的目标 */
  async function withClientProxy(fn: (port: number) => Promise<void>): Promise<void> {
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", upstreamPort);
    await withProxy(HttpProxy, {}, (port) => fn(port));
  }

  it("上游地址写进目标黑名单：不影响串联（名单不判上游）", async () => {
    writeAcl({ target: { blacklist: ["127.0.0.1", "::1"] } });

    await withClientProxy(async (port) => {
      const res = await rawRequest(
        port,
        "GET http://allowed.invalid/x HTTP/1.1\r\nHost: allowed.invalid\r\n\r\n",
      );
      expect(res.startsWith("HTTP/1.1 200")).toBe(true);
      expect(res).toContain("upstream-ok:");
      expect(upstreamHits).toBe(1);
    });
  });

  it("客户端目标命中黑名单：403 且不拨号（absolute-form 与 Host 两种形态一致）", async () => {
    writeAcl({ target: { blacklist: ["blocked.invalid"] } });

    await withClientProxy(async (port) => {
      // absolute-form：目标在 request-target 的 authority
      const abs = await rawRequest(
        port,
        "GET http://blocked.invalid/a HTTP/1.1\r\nHost: blocked.invalid\r\n\r\n",
      );
      expect(abs.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);

      // origin-form（本地应用不认代理协议时的典型形态）：目标只在 Host
      const origin = await rawRequest(port, "GET /b HTTP/1.1\r\nHost: blocked.invalid\r\n\r\n");
      expect(origin.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);

      expect(upstreamHits).toBe(0);
    });
  });

  it("目标白名单只写站点即可：上游地址不在名单里也照样串联", async () => {
    writeAcl({ target: { whitelist: ["allowed.invalid"] } });

    await withClientProxy(async (port) => {
      const ok = await rawRequest(
        port,
        "GET http://allowed.invalid/c HTTP/1.1\r\nHost: allowed.invalid\r\n\r\n",
      );
      expect(ok.startsWith("HTTP/1.1 200")).toBe(true);

      // 白名单非空且目标未命中 → 拒（上游在不在名单里与此无关）
      const denied = await rawRequest(
        port,
        "GET http://other.invalid/d HTTP/1.1\r\nHost: other.invalid\r\n\r\n",
      );
      expect(denied.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);
      expect(upstreamHits).toBe(1);
    });
  });

  it("WebSocket：名单判目标站点，握手 Host 按目标回写（不是上游地址）", async () => {
    writeAcl({ target: { whitelist: ["allowed.invalid"] } });

    await withClientProxy(async (port) => {
      const denied = await rawRequest(port, upgradeReq("blocked.invalid"));
      expect(denied.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);
      expect(upgradeHosts).toHaveLength(0);

      void rawRequest(port, upgradeReq("allowed.invalid"));
      for (let i = 0; i < 40 && upgradeHosts.length === 0; i++) {
        await sleep(25);
      }

      expect(upgradeHosts).toEqual(["allowed.invalid:80"]);
    });
  });
});
