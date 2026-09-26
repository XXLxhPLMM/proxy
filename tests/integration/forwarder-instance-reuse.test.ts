/**
 * 转发器「构造期组装、跨请求复用」+「身份维度绝不串号」的行为护栏
 *
 * @description
 * 护两件事，两件都**只能用运行期身份**来证，光看源码不够：
 *
 * 1. **实例复用**（5a）：四个转发器在服务**构造期**一次建好，请求期只调它们的方法。
 *    做法：探针子类把 `protected` 字段暴露出来 → 在被 spy 的**那一个实例**上调 spy →
 *    发多个请求 → 断言 spy 的调用次数等于请求数。
 *    「实例身份不变」本身是 trivially true（字段是 readonly），所以真正的证据是
 *    **同一个对象**被调了 N 次；这正好等价于「构造次数不随请求数增长」。
 *    静态那一半（构造点恰好 4 个、都在构造函数/字段初始化器里）在
 *    `unit/forwarder-request-path-allocation.test.ts`。
 *
 * 2. **身份不串号**（5c）：转发器是**跨请求/跨会话共享**的，而 `user` / `requestId` /
 *    `connectionId` 是**逐请求**的。这两件事凑在一起就是「A 的请求被记到 B 头上」那个雷。
 *    做法：两个不同身份的请求（或两个不同用户的并发 SOCKS 会话）共享同一个转发器实例，
 *    收集 `PipeEvent`，按 `requestId` 分组后逐组断言身份维度自洽、且与该请求的
 *    `request.started` context 完全一致。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import { HttpProxy } from "@/core/server/http.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import { Auth } from "@/core/auth.js";
import type { HttpForwarder } from "@/core/forward/http.js";
import type { TunnelForwarder } from "@/core/forward/tunnel.js";
import type { WsForwarder } from "@/core/forward/websocket.js";
import type { SocksForwarder } from "@/core/forward/socks.js";
import { EventHub, type EventEnvelope, type EventName, type EventSubscription } from "@/core/events/index.js";
import type { CoreContext } from "@/core/context.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { getFreePort, listen, sleep } from "../helpers/net.js";
import { rfc1929, socks5ConnectIpv4, tcConnect } from "../helpers/socks-client.js";
import { restoreConfig, set, silenceLogs, snapshotConfig, testConfig, testLogger } from "../helpers/config.js";

/** 本文件自建一条总线：往共享测试总线上挂长期订阅会跨用例累积 */
const bus = new EventHub({ onListenerError: () => undefined });
const ctx: CoreContext = { config: testConfig, logger: testLogger, events: bus };

/** 探针子类：把 `protected` 的转发器字段暴露给断言（不扩大生产代码的可观测面） */
class ProbeHttpProxy extends HttpProxy {
  get forwarders(): { http: HttpForwarder; tunnel: TunnelForwarder; ws: WsForwarder } {
    return { http: this.httpForwarder, tunnel: this.tunnelForwarder, ws: this.wsForwarder };
  }
}

class ProbeSocks5Proxy extends Socks5Proxy {
  get socksForwarder(): SocksForwarder {
    return this.forwarder;
  }
}

const KEYS = [
  "host",
  "port",
  "proxyMode",
  "upstreamProtocol",
  "upstreamHost",
  "upstreamPort",
  "upstreamTimeout",
  "logLevel",
  "logFile",
] as const;

/** 消费式读满 n 字节（跨 TCP 分段安全；**逐次消费**——累积缓冲的绝对下标在多段报文里会错位） */
function readBytes(sock: net.Socket, n: number, ms = 5000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = (): void => {
      sock.off("data", onData);
      sock.off("error", onError);
      clearTimeout(timer);
    };
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < n) {
        return;
      }
      cleanup();
      resolve(buf.subarray(0, n));
    };
    const onError = (e: Error): void => {
      cleanup();
      reject(e);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`readBytes 超时：只读到 ${buf.length}/${n} 字节`));
    }, ms);
    sock.on("data", onData);
    sock.on("error", onError);
  });
}

/** 起一个 http 源站（普通请求的目标）
 * @description
 * 响应里**显式**写 `connection: keep-alive`：本代理强制出站 `Connection: close`，
 * 源站若照抄 `close` 回来，入站连接会被一起关掉（那是既有行为，不是本文件要测的东西）。
 * 这与 `http-inbound-keepalive-decoupled.test.ts` 的源站桩同形。
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

/** 裸 TCP 桩：CONNECT 隧道的对端（绝不能给 http.Server，否则测到的会是协议解析） */
async function startRawTarget(): Promise<{ port: number; close: () => Promise<void> }> {
  return startRaw((sock) => {
    sock.on("data", (c) => sock.write(c));
  });
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

async function startRaw(onConn: (sock: net.Socket) => void): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    onConn(sock);
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

/** 入站 socket 对象的身份编号：用来判「两个请求是不是同一条 TCP 连接」 */
const connIds = new Map<net.Socket, number>();
let nextConnId = 0;

/** 经代理发一个 absolute-form GET；返回 `conn`（入站连接身份，同一条连接上多次请求恒等） */
function proxyGet(
  proxyPort: number,
  targetPort: number,
  path: string,
  opts: { agent?: http.Agent; headers?: Record<string, string> } = {},
): Promise<{ status: number; conn: number }> {
  return new Promise((resolve, reject) => {
    let conn = -1;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: `http://127.0.0.1:${targetPort}${path}`,
        headers: { Host: `127.0.0.1:${targetPort}`, ...(opts.headers ?? {}) },
        ...(opts.agent ? { agent: opts.agent } : {}),
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, conn }));
      },
    );
    req.on("socket", (s) => {
      let id = connIds.get(s);
      if (id === undefined) {
        id = ++nextConnId;
        connIds.set(s, id);
      }
      conn = id;
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
    req.end();
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

interface Recorded {
  name: EventName;
  context: EventEnvelope["context"];
  pipe?: PipeEvent;
}

describe("integration/forwarder-instance-reuse", () => {
  const prev = snapshotConfig(KEYS);
  const subs: EventSubscription[] = [];
  const openSockets: net.Socket[] = [];
  let origin: Awaited<ReturnType<typeof startOrigin>>;
  let rawTarget: Awaited<ReturnType<typeof startRawTarget>>;
  let upgradeTarget: Awaited<ReturnType<typeof startUpgradeTarget>>;

  function record(...names: EventName[]): Recorded[] {
    const out: Recorded[] = [];
    for (const name of names) {
      subs.push(
        bus.subscribe(name, (e) => {
          out.push({
            name,
            context: e.context,
            ...(name === "pipe" ? { pipe: e.data as unknown as PipeEvent } : {}),
          });
        }),
      );
    }

    return out;
  }

  beforeAll(async () => {
    silenceLogs();
    set("host", "127.0.0.1");
    // 哨兵端口：确保 isSelfLoop 不会把测试内的随机临时端口误判为自环
    set("port", 1);
    set("proxyMode", "server");
    origin = await startOrigin();
    rawTarget = await startRawTarget();
    upgradeTarget = await startUpgradeTarget();
  });

  afterEach(() => {
    for (const s of subs.splice(0)) {
      s.dispose();
    }
    for (const s of openSockets.splice(0)) {
      s.destroy();
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await origin.close();
    await rawTarget.close();
    await upgradeTarget.close();
    restoreConfig(prev);
  });

  // -------------------------------------------------------------------------
  // 5a：实例复用
  // -------------------------------------------------------------------------

  it("HttpForwarder：同一条 keep-alive 连接上连发 3 个请求，全程复用同一个实例（构造次数不随请求数增长）", async () => {
    set("proxyMode", "server");
    const port = await getFreePort();
    const proxy = new ProbeHttpProxy({ host: "127.0.0.1", port, ctx });

    // 关键：在**被探针暴露的那一个实例**上挂 spy。若实现是「每请求 new 一个」，
    // 这个 spy 一次都不会被调用，断言立刻变红。
    const before = proxy.forwarders.http;
    const spy = vi.spyOn(before, "handle");

    await proxy.start();
    // maxSockets/maxFreeSockets 都钉 1：客户端只肯复用，不会「开新连接」绕过断言
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });

    try {
      const results: { status: number; conn: number }[] = [];
      for (const p of ["/a", "/b", "/c"]) {
        results.push(await proxyGet(port, origin.port, p, { agent }));
        // 让上一条响应的收尾彻底落地（与 http-inbound-keepalive-decoupled 同一节奏）
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
    const proxy = new ProbeHttpProxy({ host: "127.0.0.1", port, ctx });

    const tunnelBefore = proxy.forwarders.tunnel;
    const wsBefore = proxy.forwarders.ws;
    const tunnelSpy = vi.spyOn(tunnelBefore, "handle");
    const wsSpy = vi.spyOn(wsBefore, "handle");

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
    const proxy = new ProbeSocks5Proxy({ host: "127.0.0.1", port, ctx });

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

  // -------------------------------------------------------------------------
  // 5c：身份不串号
  // -------------------------------------------------------------------------

  it("Http：同一条连接上两个不同用户的请求，PipeEvent 上的 user/requestId 各自正确、互不串", async () => {
    set("proxyMode", "server");
    // 目标是一个**没人监听**的端口：每个请求稳定地产生一条 `upstream-error` pipe 事件，
    // 且不依赖任何上游协议桩（server 模式直连，回落语义最简）
    const dead = await getFreePort();
    const port = await getFreePort();
    const auth = new Auth({
      enabled: true,
      type: "basic",
      accounts: [
        { username: "alice", password: "pw1" },
        { username: "bob", password: "pw2" },
      ],
      enableLogging: false,
    });
    const proxy = new HttpProxy({ host: "127.0.0.1", port, auth, ctx });
    const seen = record("pipe", "request.started");

    await proxy.start();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const basic = (u: string, p: string): string =>
      `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

    try {
      const asAlice = await proxyGet(port, dead, "/alice", {
        agent,
        headers: { "Proxy-Authorization": basic("alice", "pw1") },
      });
      const asBob = await proxyGet(port, dead, "/bob", {
        agent,
        headers: { "Proxy-Authorization": basic("bob", "pw2") },
      });

      expect([asAlice.status, asBob.status], "两个请求都真的走到了转发层（上游拨不通 → 502）").toEqual([
        502, 502,
      ]);
      expect(
        asBob.conn,
        "两个请求跑在同一条入站连接上（connectionId 相同、requestId 不同）",
      ).toBe(asAlice.conn);

      // requestId → user 的权威映射取自 `request.started` 的 context（它与终态同 requestId）
      const userOf = new Map<string, string | undefined>();
      const connectionIds = new Set<string>();
      for (const r of seen) {
        if (r.name === "request.started") {
          userOf.set(r.context.requestId ?? "", r.context.user);
          connectionIds.add(r.context.connectionId ?? "");
        }
      }

      expect(userOf.size, "两个请求各自带 requestId").toBe(2);
      expect([...userOf.values()].sort()).toEqual(["alice", "bob"]);
      expect(connectionIds.size, "同一条入站连接 → 同一个 connectionId").toBe(1);

      // 逐条 pipe 事件断言：身份维度必须与该 requestId 的真实归属完全一致
      const pipes = seen.filter((r) => r.name === "pipe" && r.pipe !== undefined);
      expect(pipes.length, "两个请求都应产生 pipe 事件（上游拨不通的 upstream-error）").toBeGreaterThan(1);

      for (const p of pipes) {
        const rid = p.pipe?.requestId;
        expect(rid, "每条 pipe 事件都必须带 requestId").toBeTruthy();
        expect(
          p.pipe?.user,
          `requestId=${rid} 的 pipe 事件 user 必须与该请求的真实身份一致（不串号）`,
        ).toBe(userOf.get(rid ?? ""));
        // 载荷与 context 同源，不是两套事实
        expect(p.context.user).toBe(p.pipe?.user);
        expect(p.context.requestId).toBe(rid);
      }

      // 反向也锁一道：两个身份各自都被自己的 pipe 事件覆盖（防止「全都串成同一个」也被上面放过）
      for (const [rid, user] of userOf) {
        expect(
          pipes.filter((p) => p.pipe?.requestId === rid && p.pipe?.user === user).length,
          `requestId=${rid} 至少要有一条属于 ${user} 的 pipe 事件`,
        ).toBeGreaterThan(0);
      }
    } finally {
      agent.destroy();
      await proxy.stop();
    }
  });

  it("Socks：两个不同用户的并发会话共享同一个 SocksForwarder，[socks] 事件各自带对的用户名", async () => {
    set("proxyMode", "server");
    const port = await getFreePort();
    const auth = new Auth({
      enabled: true,
      type: "basic",
      accounts: [
        { username: "alice", password: "pw1" },
        { username: "bob", password: "pw2" },
      ],
      enableLogging: false,
    });
    const proxy = new ProbeSocks5Proxy({ host: "127.0.0.1", port, auth, ctx });
    const seen = record("pipe");

    await proxy.start();

    try {
      // 两条会话**同时**在飞（SOCKS 共享单例最容易串号的形态）
      const socks = await Promise.all(
        (
          [
            ["alice", "pw1"],
            ["bob", "pw2"],
          ] as const
        ).map(async ([u, p]) => {
          const sock = await tcConnect(port);
          openSockets.push(sock);
          sock.write(Buffer.from([0x05, 0x01, 0x02]));
          expect((await readBytes(sock, 2)).toString("hex"), "只提供 USER_PASS → 选 0x02").toBe("0502");
          sock.write(rfc1929(u, p));
          expect((await readBytes(sock, 2)).toString("hex"), `${u} 的 RFC1929 子协商通过`).toBe("0100");
          sock.write(socks5ConnectIpv4("127.0.0.1", rawTarget.port));
          expect((await readBytes(sock, 10)).toString("hex"), "建隧成功应答").toBe("05000001000000000000");
          return u;
        }),
      );

      expect(socks).toEqual(["alice", "bob"]);

      // 每个用户名都必须看到**带自己身份**的 CONNECT 描述行，且行内目标与身份同源
      const described = seen
        .filter((r) => r.pipe?.type === "socks" && typeof r.pipe.message === "string")
        .map((r) => r.pipe as PipeEvent & { message: string; user?: string });

      for (const user of socks) {
        const line = described.find(
          (e) => e.user === user && e.message.includes("CONNECT (socks5)"),
        );
        expect(line, `${user} 必须有一条带自己身份的 CONNECT 描述行`).toBeTruthy();
        expect(line?.message).toContain(`-> 127.0.0.1:${rawTarget.port} CONNECT (socks5)`);
      }
      // 反向锁一道：会话事件上的身份集合恰好是这两个用户名（不多、不少、不串）
      expect(
        [...new Set(described.map((e) => e.user))].sort(),
        "共享单例上的会话事件不许出现第三个身份",
      ).toEqual(["alice", "bob"]);
    } finally {
      await proxy.stop();
    }
  });
});
