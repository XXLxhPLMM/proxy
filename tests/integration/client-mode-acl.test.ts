import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readAcl } from "@/config/index.js";
import { set, testConfig } from "../helpers/config.js";
import type { ConfigKey } from "@/config/index.js";
import { HttpProxy } from "@/core/server/http.js";
import type { PipeEvent } from "@/core/types/proxy.js";
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
    readAcl({ config: testConfig, force: true });
  }

  /** client 模式起前置代理：拨号目标是上游桩，名单判定的应是客户端请求的目标 */
  async function withClientProxy(
    fn: (port: number, proxy: HttpProxy) => Promise<void>,
  ): Promise<void> {
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", upstreamPort);
    await withProxy(HttpProxy, {}, fn);
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

  /**
   * upstream 组（acl.json 第三组）：client 模式的路由名单——命中动作 = 直连，不交上游。
   * 真值表：走上游 ⇔ 命中 whitelist ∧ 未命中 blacklist；server 模式短路不查该组。
   * 判别靠双源站：本地 target 桩（直连命中）vs 外层 upstream 桩（串联命中），
   * 应答体 `target-ok:` / `upstream-ok:` 互斥，实际拨到谁一目了然。
   */
  describe("upstream 路由名单（acl.json 第三组）", () => {
    let target: http.Server;
    let targetPort: number;
    let targetHits: number;

    beforeEach(async () => {
      targetHits = 0;
      target = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
        targetHits++;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`target-ok:${req.url}`);
      });
      targetPort = await getFreePort();
      await listen(target, targetPort);
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        target.closeAllConnections?.();
        target.close(() => resolve());
      });
    });

    /**
     * 经前置代理发一次 absolute-form 请求
     * @description 带 `Connection: close`：让 403/502 等早失败路径也即时断开，
     * 不等 keep-alive 超时（rawRequest 只在 socket close 时 resolve）
     */
    function absReq(proxyPort: number, authority: string, p = "/"): Promise<string> {
      return rawRequest(
        proxyPort,
        `GET http://${authority}${p} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`,
      );
    }

    /**
     * server 模式起前置代理（上游桩照常配置）：验证 upstream 组被短路——
     * 若组被误查，请求会被错误地串联到上游桩（应答体变成 upstream-ok:），断言即可抓住
     */
    async function withServerProxy(
      fn: (port: number, proxy: HttpProxy) => Promise<void>,
    ): Promise<void> {
      set("proxyMode", "server");
      set("upstreamProtocol", "http");
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", upstreamPort);
      await withProxy(HttpProxy, {}, fn);
    }

    /** 收集 pipe 通道的 route 事件：core → server 落 `[route]` info 行的唯一源头 */
    function collectRoutes(proxy: HttpProxy): PipeEvent[] {
      const routes: PipeEvent[] = [];
      proxy.on("pipe", (e: PipeEvent) => {
        if (e.type === "route") {
          routes.push(e);
        }
      });
      return routes;
    }

    it("默认（无 upstream 组 / 空组）：一律走上游", async () => {
      writeAcl({});

      await withClientProxy(async (port) => {
        const miss = await absReq(port, `127.0.0.1:${targetPort}`);
        expect(miss.startsWith("HTTP/1.1 200")).toBe(true);
        expect(miss).toContain("upstream-ok:");

        // 整组缺失与显式空名单等价（皆空 → 走上游）
        writeAcl({ upstream: { whitelist: [], blacklist: [] } });
        const empty = await absReq(port, `127.0.0.1:${targetPort}`);
        expect(empty.startsWith("HTTP/1.1 200")).toBe(true);
        expect(empty).toContain("upstream-ok:");

        expect(upstreamHits).toBe(2);
        expect(targetHits).toBe(0);
      });
    });

    it("upstream 黑名单命中 → 直连；未命中 → 走上游", async () => {
      writeAcl({ upstream: { blacklist: ["127.0.0.1"] } });

      await withClientProxy(async (port) => {
        const direct = await absReq(port, `127.0.0.1:${targetPort}`);
        expect(direct.startsWith("HTTP/1.1 200")).toBe(true);
        expect(direct).toContain("target-ok:");
        expect(targetHits).toBe(1);

        const via = await absReq(port, "other.test");
        expect(via.startsWith("HTTP/1.1 200")).toBe(true);
        expect(via).toContain("upstream-ok:");
        expect(upstreamHits).toBe(1);
        expect(targetHits).toBe(1);
      });
    });

    it("upstream 白名单非空：圈内（命中）走上游，圈外（未命中）直连", async () => {
      writeAcl({ upstream: { whitelist: ["in.test"] } });

      await withClientProxy(async (port) => {
        const inside = await absReq(port, "in.test");
        expect(inside.startsWith("HTTP/1.1 200")).toBe(true);
        expect(inside).toContain("upstream-ok:");
        expect(upstreamHits).toBe(1);

        const outside = await absReq(port, `127.0.0.1:${targetPort}`);
        expect(outside.startsWith("HTTP/1.1 200")).toBe(true);
        expect(outside).toContain("target-ok:");
        expect(targetHits).toBe(1);
        expect(upstreamHits).toBe(1);
      });
    });

    it("黑白名单同时命中：黑名单优先 → 仍直连", async () => {
      writeAcl({ upstream: { whitelist: ["127.0.0.1"], blacklist: ["127.0.0.1"] } });

      await withClientProxy(async (port) => {
        const res = await absReq(port, `127.0.0.1:${targetPort}`);
        expect(res.startsWith("HTTP/1.1 200")).toBe(true);
        expect(res).toContain("target-ok:");
        expect(targetHits).toBe(1);
        expect(upstreamHits).toBe(0);
      });
    });

    it("目标黑名单先于路由判定：403 收尾，不拨任何一端", async () => {
      writeAcl({
        target: { blacklist: ["blocked.test"] },
        upstream: { blacklist: ["blocked.test"] },
      });

      await withClientProxy(async (port) => {
        const res = await absReq(port, "blocked.test");
        expect(res.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);
        expect(targetHits).toBe(0);
        expect(upstreamHits).toBe(0);
      });
    });

    it("server 模式短路 upstream 组：命中白名单仍直连；死端口即时 502 而非上游 200", async () => {
      writeAcl({ upstream: { whitelist: ["127.0.0.1"] } });
      // 未监听的死端口：直连必拨号失败（502），若被误判串联则上游桩照回 200 —— 状态码即可判别
      const deadPort = await getFreePort();

      await withServerProxy(async (port) => {
        const direct = await absReq(port, `127.0.0.1:${targetPort}`);
        expect(direct.startsWith("HTTP/1.1 200")).toBe(true);
        expect(direct).toContain("target-ok:");

        const t0 = Date.now();
        const dead = await absReq(port, `127.0.0.1:${deadPort}`);
        expect(dead.startsWith("HTTP/1.1 502")).toBe(true);
        expect(Date.now() - t0).toBeLessThan(2000);

        expect(upstreamHits).toBe(0);
      });
    });

    it("[route] 事件：client 模式过 preDial 每请求恰一条，拒绝路径零条", async () => {
      writeAcl({
        target: { blacklist: ["deny.test"] },
        upstream: { blacklist: ["127.0.0.1"] },
      });

      await withClientProxy(async (port, proxy) => {
        const routes = collectRoutes(proxy);

        // 1) upstream 黑名单命中 → direct + reason（有效模式回落 server，事件照发）
        const direct = await absReq(port, `127.0.0.1:${targetPort}`, "/a");
        expect(direct).toContain("target-ok:");

        // 2) 未命中、白名单空 → upstream
        const via = await absReq(port, "up.test", "/b");
        expect(via).toContain("upstream-ok:");

        // 3) 目标黑名单拒绝：到不了路由分支，不发事件
        const denied = await absReq(port, "deny.test");
        expect(denied.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);

        expect(routes).toHaveLength(2);
        expect(routes[0]).toMatchObject({
          type: "route",
          target: `127.0.0.1:${targetPort}`,
          mode: "server",
          route: "direct",
          reason: "blacklist",
        });
        expect(routes[1]).toMatchObject({
          type: "route",
          target: "up.test:80",
          mode: "client",
          route: "upstream",
        });
        expect(routes[1].reason).toBeUndefined();

        // 4) websocket 允许路径同样恰一条（四转发器共用 emitRoute）
        void rawRequest(port, upgradeReq("ws.test"));
        for (let i = 0; i < 40 && upgradeHosts.length === 0; i++) {
          await sleep(25);
        }
        expect(upgradeHosts).toEqual(["ws.test:80"]);
        expect(routes).toHaveLength(3);
        expect(routes[2]).toMatchObject({
          type: "route",
          target: "ws.test:80",
          mode: "client",
          route: "upstream",
        });
      });
    });

    it("[route] 事件：server 模式零条（组被短路，upstream 名单不参与判定）", async () => {
      writeAcl({ upstream: { whitelist: ["127.0.0.1"] } });

      await withServerProxy(async (port, proxy) => {
        const routes = collectRoutes(proxy);
        const res = await absReq(port, `127.0.0.1:${targetPort}`);
        // 短路：白名单虽给了上游资格，server 模式仍直连，且一条 route 事件都不发
        expect(res).toContain("target-ok:");
        expect(routes).toHaveLength(0);
      });
    });
  });
});
