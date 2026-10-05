/**
 * 转发器「构造期组装、跨请求复用」：探针子类把 `protected` 字段暴露出来 → 在被 spy 的**那一个
 * 实例**上调 spy → 发多个请求 → 断言调用次数等于请求数（等价于「构造次数不随请求数增长」）。
 *
 * 静态那一半（构造点恰好 4 个、都在构造函数 / 字段初始化器里）在
 * `tests/unit/core/request-scope/allocation.test.ts`；身份维度那一面在
 * `instance-reuse-identity.test.ts`。两档共用的装配面归 `./instance-reuse-fixture.ts`，
 * 主题级判据与本目录清单见 `./AGENTS.md`。
 *
 * @module tests/integration/forward
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import { HttpProxy } from "@/core/server/http.js";
import type { HttpForwarder } from "@/core/forward/channel/http.js";
import type { TunnelForwarder } from "@/core/forward/channel/tunnel.js";
import type { WsForwarder } from "@/core/forward/channel/upgrade.js";
import { getFreePort, listen, sleep } from "../../helpers/net.js";
import { socks5ConnectIpv4, tcConnect } from "../../helpers/socks-client.js";
import { restoreConfig, set, snapshotConfig } from "../../helpers/config.js";
import { openAccessControl } from "../../helpers/access.js";
import {
  KEYS,
  ProbeSocks5Proxy,
  ctx,
  discardOpenSockets,
  openSockets,
  proxyGet,
  readBytes,
  sentinelBaseConfig,
  startRaw,
  startRawTarget,
} from "./instance-reuse-fixture.js";

/** 探针子类：把 `protected` 的转发器字段暴露给断言（不扩大生产代码的可观测面） */
class ProbeHttpProxy extends HttpProxy {
  get forwarders(): { http: HttpForwarder; tunnel: TunnelForwarder; ws: WsForwarder } {
    return { http: this.httpForwarder, tunnel: this.tunnelForwarder, ws: this.wsForwarder };
  }
}

/** 起一个 http 源站（普通请求的目标）
 * @description
 * 响应里**显式**写 `connection: keep-alive`：本代理强制出站 `Connection: close`，
 * 源站若照抄 `close` 回来，入站连接会被一起关掉（那是既有行为，不是本文件要测的东西）。
 * 这与 `inbound/keepalive-decoupled.test.ts` 的源站桩同形。
 */
async function startOrigin(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/plain");
    // 正文 "origin-ok" 是 9 字节（写错长度会让响应被截断，客户端侧表现为下一次请求 ECONNRESET）
    res.setHeader("content-length", "9");
    res.setHeader("connection", "keep-alive");
    res.end("origin-ok");
  });
  server.on("connection", (s: net.Socket) => {
    sockets.add(s);
    s.on("error", () => {});
    s.on("close", () => sockets.delete(s));
  });
  const port = await getFreePort();
  await listen(server, port);

  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) {
          s.destroy();
        }
        server.close(() => r());
      }),
  };
}

/** 裸 TCP 桩：Upgrade 的对端（见到完整请求头就回 101，之后回声） */
async function startUpgradeTarget(): Promise<{ port: number; close: () => Promise<void> }> {
  return startRaw((sock) => {
    let seen = false;
    sock.on("data", (c) => {
      if (!seen && c.includes(Buffer.from("\r\n\r\n"))) {
        seen = true;
        sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
        return;
      }
      sock.write(c);
    });
  });
}

/** 一次 CONNECT 隧道：等 `HTTP/1.1 200 Connection Established` */
async function connectTunnel(proxyPort: number, targetPort: number): Promise<net.Socket> {
  const socket = await tcConnect(proxyPort);
  socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
  const head = await readBytes(socket, 39);

  expect(head.toString("latin1")).toContain("200 Connection Established");

  return socket;
}

/** 一次 Upgrade：等目标回 101 */
async function upgradeOnce(proxyPort: number, targetPort: number): Promise<net.Socket> {
  const socket = await tcConnect(proxyPort);
  socket.write(
    `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
  );
  const head = await readBytes(socket, 36);

  expect(head.toString("latin1")).toContain("101 Switching Protocols");

  return socket;
}

describe("forward · instance-reuse（构造期组装、跨请求复用）", () => {
  const prev = snapshotConfig(KEYS);
  let origin: Awaited<ReturnType<typeof startOrigin>>;
  let rawTarget: Awaited<ReturnType<typeof startRawTarget>>;
  let upgradeTarget: Awaited<ReturnType<typeof startUpgradeTarget>>;

  beforeAll(async () => {
    sentinelBaseConfig();
    origin = await startOrigin();
    rawTarget = await startRawTarget();
    upgradeTarget = await startUpgradeTarget();
  });

  afterEach(() => {
    discardOpenSockets();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await origin.close();
    await rawTarget.close();
    await upgradeTarget.close();
    restoreConfig(prev);
  });

  it("HttpForwarder：同一条 keep-alive 连接上连发 3 个请求，全程复用同一个实例（构造次数不随请求数增长）", async () => {
    set("proxyMode", "server");
    const port = await getFreePort();
    // 实例复用用例与名单无关 → 显式点名「不判名单」（core 侧已无 access 缺省）
    const proxy = new ProbeHttpProxy({ host: "127.0.0.1", port, ctx, access: openAccessControl() });

    // 关键：在**被探针暴露的那一个实例**上挂 spy。若实现是「每请求 new 一个」，
    // 这个 spy 一次都不会被调用，断言立刻变红。
    const before = proxy.forwarders.http;
    const spy = vi.spyOn(before, "handleRequest");

    await proxy.start();
    // maxSockets/maxFreeSockets 都钉 1：客户端只肯复用，不会「开新连接」绕过断言
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });

    try {
      const results: { status: number; conn: number }[] = [];
      for (const p of ["/a", "/b", "/c"]) {
        results.push(await proxyGet(port, origin.port, p, { agent }));
        // 让上一条响应的收尾彻底落地（与 inbound/keepalive-decoupled 同一节奏）
        await sleep(80);
      }

      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      // 三个请求确实跑在同一条入站连接上（否则「跨请求复用」这条断言的前提不成立）
      expect(
        new Set(results.map((r) => r.conn)).size,
        "三个请求必须是同一条入站 TCP 连接",
      ).toBe(1);
      // 同一个实例服务了 3 个请求
      expect(spy, "三个请求必须由构造期建好的那一个转发器实例处理").toHaveBeenCalledTimes(3);
      expect(proxy.forwarders.http, "实例身份在多次请求间不变").toBe(before);
    } finally {
      agent.destroy();
      await proxy.stop();
    }
  });

  it("TunnelForwarder / WsForwarder：多条连接上的多条通道请求，同样复用构造期那一个实例", async () => {
    set("proxyMode", "server");
    const port = await getFreePort();
    // 实例复用用例与名单无关 → 显式点名「不判名单」（core 侧已无 access 缺省）
    const proxy = new ProbeHttpProxy({ host: "127.0.0.1", port, ctx, access: openAccessControl() });

    const tunnelBefore = proxy.forwarders.tunnel;
    const wsBefore = proxy.forwarders.ws;
    const tunnelSpy = vi.spyOn(tunnelBefore, "handleConnect");
    const wsSpy = vi.spyOn(wsBefore, "handleUpgrade");

    await proxy.start();

    try {
      for (let i = 0; i < 2; i++) {
        openSockets.push(await connectTunnel(port, rawTarget.port));
      }
      for (let i = 0; i < 2; i++) {
        openSockets.push(await upgradeOnce(port, upgradeTarget.port));
      }

      expect(tunnelSpy, "两次 CONNECT 由同一个 TunnelForwarder 实例处理").toHaveBeenCalledTimes(2);
      expect(wsSpy, "两次 Upgrade 由同一个 WsForwarder 实例处理").toHaveBeenCalledTimes(2);
      expect(proxy.forwarders.tunnel).toBe(tunnelBefore);
      expect(proxy.forwarders.ws).toBe(wsBefore);
    } finally {
      await proxy.stop();
    }
  });

  it("SocksForwarder：两条独立 SOCKS 会话（跨连接）复用同一个实例", async () => {
    set("proxyMode", "server");
    const port = await getFreePort();
    // 实例复用用例与名单无关 → 显式点名「不判名单」
    const proxy = new ProbeSocks5Proxy({ host: "127.0.0.1", port, ctx, access: openAccessControl() });

    const before = proxy.socksForwarder;
    const spy = vi.spyOn(before, "serveSocks5Connect");

    await proxy.start();

    try {
      for (let i = 0; i < 2; i++) {
        const sock = await tcConnect(port);
        openSockets.push(sock);
        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        expect((await readBytes(sock, 2)).toString("hex")).toBe("0500");
        sock.write(socks5ConnectIpv4("127.0.0.1", rawTarget.port));
        expect((await readBytes(sock, 10)).toString("hex")).toBe("05000001000000000000");
      }

      expect(spy, "两条 SOCKS 会话由同一个 SocksForwarder 实例处理").toHaveBeenCalledTimes(2);
      expect(proxy.socksForwarder, "实例身份在多条会话间不变").toBe(before);
    } finally {
      await proxy.stop();
    }
  });
});
