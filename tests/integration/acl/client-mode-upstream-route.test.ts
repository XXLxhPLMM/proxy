/**
 * 这一档管 client 模式的**上游路由名单**（`acl.json` 第三组）：命中动作 = 直连、不交上游，
 * 真值表 + 三种通道形态 + server 模式短路 + `[route]` 事件。
 *
 * @module tests/integration/acl
 * 档级不变量（判定对象永远是客户端请求的目标、路由名单为什么答不出「哪一组」、双源站判别法）
 * 见 `./AGENTS.md`；装配面见 `./client-mode-fixture.js`。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import type { EventSubscription } from "@/core/events/index.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { HttpProxy } from "@/core/server/http.js";
import { getFreePort, listen, sleep } from "../../helpers/net.js";
import { makeCollector } from "../../helpers/socks-client.js";
import {
  rawRequest,
  upgradeHosts,
  upgradeReq,
  upstreamConnects,
  upstreamHits,
  withClientProxy,
  withServerProxy,
  writeAcl,
} from "./client-mode-fixture.js";

/** 本档用例会挂到共享测试总线上的订阅，afterEach 统一 dispose。 */
const pipeSubscriptions: EventSubscription[] = [];

/**
 * upstream 组（acl.json 第三组）：client 模式的路由名单——命中动作 = 直连，不交上游。
 * 真值表：走上游 ⇔ 命中 whitelist ∧ 未命中 blacklist；server 模式短路不查该组。
 * 判别靠双源站：本地 target 桩（直连命中）vs 外层 upstream 桩（串联命中），
 * 应答体 `target-ok:` / `upstream-ok:` 互斥，实际拨到谁一目了然。
 */
describe("acl · client-mode-upstream-route（acl.json 第三组：上游路由名单）", () => {
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
    // pipe 订阅挂在共享测试总线上，不 dispose 会跨用例累积（旧实现订阅 core emitter，
    // 随 proxy.stop() 自然消失，故无需清理）
    for (const subscription of pipeSubscriptions.splice(0)) {
      subscription.dispose();
    }
    await new Promise<void>((resolve) => {
      target.closeAllConnections?.();
      target.close(() => resolve());
    });
  });

  /**
   * 裸 TCP 回显桩：CONNECT 隧道的真实目标
   * @description 直连 CONNECT 隧道是**裸 TCP 直连**（不向目标发任何 CONNECT 报文），
   * 所以隧道目标必须是 `net.Server`。给 `http.Server` 的话它会把隧道字节当 HTTP 请求解析
   * （首字节不是合法方法名时直接回 400 并断链），测到的就成了协议解析而不是连接器选择。
   */
  async function startTcpEcho(): Promise<{
    port: number;
    received: () => Buffer;
    close: () => Promise<void>;
  }> {
    const chunks: Buffer[] = [];
    const sockets = new Set<net.Socket>();
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on("error", () => {});
      sock.on("close", () => sockets.delete(sock));
      sock.on("data", (c: Buffer) => {
        chunks.push(c);
        sock.write(c);
      });
    });
    const port = await getFreePort();
    await listen(server, port);
    return {
      port,
      received: () => Buffer.concat(chunks),
      close: () =>
        new Promise<void>((resolve) => {
          for (const s of sockets) {
            s.destroy();
          }
          server.close(() => resolve());
        }),
    };
  }

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
   * 收集 pipe 通道的 route 事件：core → server 落 `[route]` info 行的唯一源头
   *
   * 订阅源是注入的 `ctx.events`（取自 `proxy.options.ctx.events`，不硬编码测试总线）——
   * core 直接把 pipe 事实发布到那条总线。
   * 订阅登记进 `pipeSubscriptions`，由本档已有的 afterEach 统一 dispose——共享总线不清理会跨用例累积。
   */
  function collectRoutes(proxy: HttpProxy): PipeEvent[] {
    const routes: PipeEvent[] = [];
    const subscription = proxy.options.ctx.events.subscribe("pipe", (e) => {
      if (e.data.type === "route") {
        routes.push(e.data);
      }
    });
    pipeSubscriptions.push(subscription);
    return routes;
  }

  /** 等条件成立（超时抛错，避免固定 sleep 抖动） */
  async function waitUntil(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
    for (let waited = 0; waited < timeoutMs; waited += 25) {
      if (cond()) {
        return;
      }
      await sleep(25);
    }
    throw new Error(`waitUntil 超时：${label}`);
  }

  /**
   * CONNECT 通道的连接器选择（与 http 通道同一套 `resolveRoute` 有效模式）
   *
   * 这条覆盖要求真 `HttpProxy` + 真 CONNECT（不能用裸 `net.Server` 转发器绕开
   * `BaseProxy` 生命周期）：活着的 CONNECT 隧道不在 Node 连接表里，
   * `ConnRegistry.drain` 若只有原生 `closeAllConnections()` 就拆不掉它，`stop()` 会挂死。
   *
   * 判别力：真目标桩收到探针字节（走的是 `connectors.direct()`）**且**上游桩零字节
   * （既无 CONNECT 记录、也无普通请求/Upgrade 命中，即绝没走 connectorFor）。
   */
  it("CONNECT 通道：client 模式 + upstream 路由名单命中 → 直连（真目标收到字节 / 上游桩零字节）", async () => {
    writeAcl({ upstream: { blacklist: ["127.0.0.1"] } });
    const direct = await startTcpEcho();

    try {
      await withClientProxy(async (port) => {
        const sock = net.connect(port, "127.0.0.1");
        const c = makeCollector(sock);
        sock.on("error", () => {});

        sock.write(
          `CONNECT 127.0.0.1:${direct.port} HTTP/1.1\r\nHost: 127.0.0.1:${direct.port}\r\n\r\n`,
        );
        await c.waitFor((b) => b.includes(Buffer.from("200 Connection Established")), 3000);

        // 探针经隧道到达真目标 = 走的是 directConnector
        sock.write("probe-through-connect");
        await waitUntil(
          () => direct.received().includes(Buffer.from("probe-through-connect")),
          "真目标收到 CONNECT 隧道探针",
        );
        expect(direct.received().toString()).toContain("probe-through-connect");

        // 上游桩一个字节都没收到 = 绝没有走 connectorFor（三种通道形态都断言一遍）
        expect(upstreamConnects).toEqual([]);
        expect(upstreamHits).toBe(0);
        expect(upgradeHosts).toEqual([]);

        sock.destroy();
      });
    } finally {
      await direct.close();
    }
  });

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