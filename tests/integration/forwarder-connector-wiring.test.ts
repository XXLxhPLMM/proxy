/**
 * @fileoverview 三个「纯管道」转发器（tunnel / socks / websocket）的上游连接器接线护栏
 * @description
 * Phase 2b-1 把这三条「拿到一条字节管道然后桥接」的路径改用 `forward/connector` 统一层后，
 * 本文件锁三件**一旦接线就可能悄悄漂移**的东西：
 *
 * 1. **守卫日志的 route 文本**：连接器不再各调用点自定义，统一按「信息最多的既有形态」给出
 *    （`[<prefix>] error <clientAddr> -> <dest>` 或 `... -> <dest> via socks<N> <upstream>`）。
 *    变强的那几处（socks 直连分支、socks 的 socks 上游分支、websocket 的 socks 上游分支，
 *    以及 2c 起 websocket 的**有效 client 经 http(s) 上游**那条）此前「短」是**各调点随手写出来的
 *    差异，不是契约**——**自本文件起，route 文本是逐字锁死的契约**，
 *    改它必须先改本文件并说明理由，否则「顺手调日志」会把排障线索抹掉。
 * 2. **`refusal` 透传**（tunnel 经 http(s) 上游）：上游 CONNECT 回非 200（如后级 407）时，
 *    **响应头 + 余量原样写给客户端再断链**（不断链语义——`Proxy-Authenticate` 必须送达客户端），
 *    绝不建隧、绝不回自己的 502/504。这是本切片最容易丢的行为，断言逐字节。
 * 3. **连接器选择**：有效路由是 direct 时必须走 `directConnector` 而不是 `connectorFor`。
 *    判别靠「双桩互斥」——真目标桩与上游代理桩同时在跑，拨了谁一目了然；
 *    配 `upstream` 路由名单让 client 模式请求回落 direct，若误用 `connectorFor`
 *    就会去拨上游桩，断言立刻抓住。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readAcl } from "@/config/index.js";
import { TunnelForwarder } from "@/core/forward/tunnel.js";
import { WsForwarder } from "@/core/forward/websocket.js";
import { inertTrafficAccount as INERT_TRAFFIC } from "@/core/traffic/index.js";
import { createRequestScope } from "@/core/request-scope.js";
import { RequestTerminal } from "@/core/request-terminal.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import type { EventSubscription } from "@/core/events/index.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { set, testConfig, testContext, testEvents } from "../helpers/config.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../helpers/config.js";
import { getFreePort, listen, sleep } from "../helpers/net.js";
import { withProxy } from "../helpers/proxy.js";
import { makeCollector, socks5ConnectIpv4, tcConnect } from "../helpers/socks-client.js";

/** 本文件涉及的配置键（逐键快照/恢复，不依赖生产全局 store） */
const KEYS = [
  "aclFile",
  "authEnabled",
  "authType",
  "host",
  "port",
  "proxyMode",
  "upstreamHost",
  "upstreamPort",
  "upstreamProtocol",
  "upstreamTimeout",
  "logLevel",
  "logFile",
] as const;

/** 起一个裸 TCP server 的可关闭句柄，并记录每条连接的远端地址（守卫 route 前半段同源） */
interface Tcp {
  port: number;
  close: () => Promise<void>;
  /** 收到的全部字节（判「上游桩到底有没有被碰过」） */
  received: () => Buffer;
}

async function startTcp(onConn?: (sock: net.Socket) => void): Promise<Tcp> {
  const chunks: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    sock.on("data", (c: Buffer) => chunks.push(c));
    onConn?.(sock);
  });

  const port = await getFreePort();

  await listen(server, port);

  return {
    port,
    received: () => Buffer.concat(chunks),
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) {
          s.destroy();
        }
        server.close(() => r());
      }),
  };
}

/**
 * 造一条请求作用域：直构 core 时没有 runtime 注入的 publisher，terminal 退化为纯 guard。
 * 身份维度与 pipe 事件出口都在这条 scope 里（与 `HttpProxy.handleForward` 同形）。
 */
function requestScope(): ReturnType<typeof createRequestScope> {
  return createRequestScope({ ctx: testContext, terminal: new RequestTerminal() });
}

/**
 * 转发器实例**在模块加载时建一次**、跨所有用例与连接复用
 * @description
 * 与 `HttpProxy` 构造期组装转发器的形态刻意同形：转发器无请求态，逐请求数据全在 `scope` 里，
 * 所以「建一次、多连接复用」是合法的（也正是 `integration/forwarder-instance-reuse.test.ts`
 * 锁的那条不变性）。`testContext` 是常量，故这里可以安全地提到模块级。
 */
const tunnelFwd = new TunnelForwarder(testContext, INERT_TRAFFIC());
const wsFwd = new WsForwarder(testContext, INERT_TRAFFIC());

/**
 * 本地转发器：把每条连接 socket 原样交给 forward（模拟 HttpProxy 的 connect/upgrade 委派），
 * forward 内部按当前 store 配置拨上游
 */
async function startForwarder(
  forward: (req: unknown, socket: net.Socket, head: Buffer) => void,
  fakeReq: unknown,
): Promise<Tcp> {
  return startTcp((sock) => {
    forward(fakeReq, sock, Buffer.alloc(0));
  });
}

/** CONNECT 伪请求：`parseAuthority` 只认 url */
function connectReq(host: string, port: number): unknown {
  return { url: `${host}:${port}`, headers: {}, method: "CONNECT" };
}

/** Upgrade 伪请求：目标在 Host 头（origin-form 形态，与真实客户端一致） */
function upgradeReq(host: string, port: number): unknown {
  return {
    url: "/ws",
    method: "GET",
    httpVersion: "1.1",
    headers: { host: `${host}:${port}` },
    rawHeaders: ["Host", `${host}:${port}`, "Upgrade", "websocket", "Connection", "Upgrade"],
  };
}

/** 从事件流里取第一条 `type === "upstream-error"` 且 message 带指定前缀的事件文本 */
function guardError(events: PipeEvent[], prefix: string): string {
  for (const e of events) {
    if (e.type === "upstream-error" && typeof e.message === "string" && e.message.startsWith(prefix)) {
      return e.message;
    }
  }

  throw new Error(
    `未找到前缀为 "${prefix}" 的 upstream-error 事件；实得：${JSON.stringify(
      events.map((e) => [e.type, "message" in e ? e.message : ""]),
    )}`,
  );
}

/** 读满 n 字节才 resolve（跨 TCP 分段安全；只用于 SOCKS 握手这种定长应答） */
function readBytes(sock: net.Socket, n: number, ms = 3000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const acc: Buffer[] = [];
    let len = 0;

    const cleanup = (): void => {
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("error", onError);
    };

    const onData = (c: Buffer): void => {
      acc.push(c);
      len += c.length;

      if (len < n) {
        return;
      }

      cleanup();
      resolve(Buffer.concat(acc).subarray(0, n));
    };

    const onError = (e: Error): void => {
      cleanup();
      reject(e);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`readBytes 超时：只读到 ${len}/${n} 字节`));
    }, ms);

    sock.on("data", onData);
    sock.on("error", onError);
  });
}

/** 轮询等待条件成立，超时抛错（避免固定 sleep 抖动） */
async function waitUntil(cond: () => boolean, timeoutMs = 3000, label = ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (cond()) {
      return;
    }

    await sleep(10);
  }

  throw new Error(`waitUntil 超时${label ? `：${label}` : ""}`);
}

// ---------------------------------------------------------------------------

describe("integration/forwarder-connector-wiring", () => {
  let snap: Record<string, unknown>;
  /** 挂在共享测试总线上的 pipe 订阅，由 afterEach 统一 dispose（共享总线不清理会跨用例累积） */
  const subs: EventSubscription[] = [];

  beforeEach(() => {
    snap = snapshotConfig(KEYS);
    silenceLogs();
    set("authEnabled", false);
    set("authType", "none");
    set("host", "127.0.0.1");
    // 哨兵端口：确保 isSelfLoop 不会把测试内的随机临时端口误判为自环
    set("port", 1);
  });

  afterEach(() => {
    for (const s of subs.splice(0)) {
      s.dispose();
    }

    restoreConfig(snap);
  });

  // -------------------------------------------------------------------------
  // tunnel：三条支路的守卫 route 文本 + refusal 透传
  // -------------------------------------------------------------------------

  describe("forward/tunnel", () => {
    it("直连：route 为 `<clientAddr> -> <host>:<port>`，不带任何上游尾巴", async () => {
      set("proxyMode", "server");
      const dead = await getFreePort();
      const events: PipeEvent[] = [];
      subs.push(collectPipe((e) => events.push(e)));
      const fwd = await startForwarder(
        (req, socket, head) => tunnelFwd.handle(req as never, socket, head, requestScope()),
        connectReq("127.0.0.1", dead),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
        expect(guardError(events, "[tunnel] error ")).toBe(
          `[tunnel] error 127.0.0.1 -> 127.0.0.1:${dead}`,
        );
        client.destroy();
      } finally {
        await fwd.close();
      }
    });

    it("经 http 上游：route 带 `via <upstreamHost>:<upstreamPort>`（与既有形态逐字一致）", async () => {
      set("proxyMode", "client");
      set("upstreamProtocol", "http");
      const dead = await getFreePort();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);
      const events: PipeEvent[] = [];
      subs.push(collectPipe((e) => events.push(e)));
      const fwd = await startForwarder(
        (req, socket, head) => tunnelFwd.handle(req as never, socket, head, requestScope()),
        connectReq("target.example", 8443),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
        expect(guardError(events, "[tunnel] error ")).toBe(
          `[tunnel] error 127.0.0.1 -> target.example:8443 via 127.0.0.1:${dead}`,
        );
        client.destroy();
      } finally {
        await fwd.close();
      }
    });

    it("经 socks5 上游：route 带 `via socks5 <upstreamHost>:<upstreamPort>`（与既有形态逐字一致）", async () => {
      set("proxyMode", "client");
      set("upstreamProtocol", "socks5");
      const dead = await getFreePort();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);
      const events: PipeEvent[] = [];
      subs.push(collectPipe((e) => events.push(e)));
      const fwd = await startForwarder(
        (req, socket, head) => tunnelFwd.handle(req as never, socket, head, requestScope()),
        connectReq("target.example", 8443),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
        expect(guardError(events, "[tunnel] error ")).toBe(
          `[tunnel] error 127.0.0.1 -> target.example:8443 via socks5 127.0.0.1:${dead}`,
        );
        client.destroy();
      } finally {
        await fwd.close();
      }
    });

    it("refusal 透传：上游 CONNECT 回 407 时响应头+余量逐字节写给客户端再断链（不断链语义）", async () => {
      set("proxyMode", "client");
      set("upstreamProtocol", "http");

      const head =
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="up"\r\n\r\n';
      const rest = "denied-by-upstream";
      // 假上游：读到完整 CONNECT 请求头后回 head+rest（rest 是响应头之后的先发字节）
      const upstream = await startTcp((sock) => {
        let buf = Buffer.alloc(0);
        const onData = (c: Buffer): void => {
          buf = Buffer.concat([buf, c]);

          if (buf.indexOf("\r\n\r\n") === -1) {
            return;
          }

          sock.off("data", onData);
          sock.write(head + rest);
        };
        sock.on("data", onData);
      });
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", upstream.port);

      const events: PipeEvent[] = [];
      subs.push(collectPipe((e) => events.push(e)));
      const fwd = await startForwarder(
        (req, socket, head2) => tunnelFwd.handle(req as never, socket, head2, requestScope()),
        connectReq("target.example", 8443),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        // 逐字节：Proxy-Authenticate 必须送达客户端，且余量不得被吞
        await c.waitFor((b) => b.includes(Buffer.from(rest)), 3000);
        expect(c.bytes().toString()).toBe(head + rest);
        // refusal 不是建链成功：绝不能回 200，绝不能建隧
        expect(c.bytes().toString()).not.toContain("200 Connection Established");
        // 断链语义：写完即断
        await c.waitClose(2000);
        // refusal 不是拨号失败：不得回自己的 502/504，也不得发 upstream-error
        expect(c.bytes().toString()).not.toContain("502");
        expect(c.bytes().toString()).not.toContain("504");
        expect(events.filter((e) => e.type === "upstream-error")).toHaveLength(0);
        client.destroy();
      } finally {
        await fwd.close();
        await upstream.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // socks：三条上游支路的守卫 route 文本
  // -------------------------------------------------------------------------

  describe("forward/socks", () => {
    /** 起一个真 Socks5Proxy，并把它的 pipe 事实收进数组 */
    async function withSocks5(
      fn: (port: number, events: PipeEvent[]) => Promise<void>,
    ): Promise<void> {
      const events: PipeEvent[] = [];

      subs.push(collectPipe((e) => events.push(e)));
      await withProxy(Socks5Proxy, {}, (port) => fn(port, events));
    }

    it("直连分支：route 补上了 `-> <host>:<port>`（此前只有客户端地址，是净改进）", async () => {
      set("proxyMode", "server");
      const dead = await getFreePort();

      await withSocks5(async (port, events) => {
        const sock = await tcConnect(port);

        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        await readBytes(sock, 2);
        sock.write(socks5ConnectIpv4("127.0.0.1", dead));
        await readBytes(sock, 10);

        await waitUntil(
          () => events.some((e) => e.type === "upstream-error"),
          3000,
          "socks 直连守卫事件",
        );
        expect(guardError(events, "[socks] error ")).toBe(`[socks] error 127.0.0.1 -> 127.0.0.1:${dead}`);
        sock.destroy();
      });
    });

    it("http 上游分支：route 带 `via <upstreamHost>:<upstreamPort>`（与既有形态逐字一致）", async () => {
      set("proxyMode", "client");
      set("upstreamProtocol", "http");
      const dead = await getFreePort();
      const dest = await getFreePort();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);

      await withSocks5(async (port, events) => {
        const sock = await tcConnect(port);

        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        await readBytes(sock, 2);
        sock.write(socks5ConnectIpv4("127.0.0.1", dest));
        await readBytes(sock, 10);

        await waitUntil(
          () => events.some((e) => e.type === "upstream-error"),
          3000,
          "socks http 上游守卫事件",
        );
        expect(guardError(events, "[socks] error ")).toBe(
          `[socks] error 127.0.0.1 -> 127.0.0.1:${dest} via 127.0.0.1:${dead}`,
        );
        sock.destroy();
      });
    });

    it("socks 上游分支：route 补上了 `-> <host>:<port> via socks5 <upstream>`（净改进）", async () => {
      set("proxyMode", "client");
      set("upstreamProtocol", "socks5");
      const dead = await getFreePort();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);

      await withSocks5(async (port, events) => {
        const sock = await tcConnect(port);

        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        await readBytes(sock, 2);
        sock.write(socks5ConnectIpv4("10.1.2.3", 8443));
        await readBytes(sock, 10);

        await waitUntil(
          () => events.some((e) => e.type === "upstream-error"),
          3000,
          "socks socks 上游守卫事件",
        );
        expect(guardError(events, "[socks] error ")).toBe(
          `[socks] error 127.0.0.1 -> 10.1.2.3:8443 via socks5 127.0.0.1:${dead}`,
        );
        sock.destroy();
      });
    });
  });

  // -------------------------------------------------------------------------
  // websocket：socks 早分支 + 主路径上游分流的守卫 route 文本
  // -------------------------------------------------------------------------

  describe("forward/websocket", () => {
    it("经 socks5 上游：route 补上了 `-> <host>:<port> via socks5 <upstream>`（净改进）", async () => {
      set("proxyMode", "client");
      set("upstreamProtocol", "socks5");
      const dead = await getFreePort();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);
      const events: PipeEvent[] = [];
      subs.push(collectPipe((e) => events.push(e)));
      const fwd = await startForwarder(
        (req, socket, head) => wsFwd.handle(req as never, socket, head, requestScope()),
        upgradeReq("target.example", 8443),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
        expect(guardError(events, "[upgrade] error ")).toBe(
          `[upgrade] error 127.0.0.1 -> target.example:8443 via socks5 127.0.0.1:${dead}`,
        );
        client.destroy();
      } finally {
        await fwd.close();
      }
    });

    it("有效 client 经 http 上游（2c 改走 connector.transport()）：route 补上了 `-> <host>:<port> via <upstream>`（旧文本是各调点随手写的差异，非契约）", async () => {
      // 2c 之前这条路径**不走连接器层**（是 websocket 里唯一一处 `this.dialer.choose` 直拨上游），
      // 它的守卫 `target` 只有 `${targets.dial.host}:${targets.dial.port}`，也就是**上游地址本身**、
      // **没有 `via` 尾巴、也看不出客户端要访问谁**。别的调点早就统一成信息最多的形态了，
      // 这里「短」纯属各调点随手写出来的差异、不是契约——2c 随「改走
      // `HttpConnectConnector.transport()`」一并统一为 "<dest> via <upstream>" 全量形式。
      set("proxyMode", "client");
      set("upstreamProtocol", "http");
      const dead = await getFreePort();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);
      const events: PipeEvent[] = [];
      subs.push(collectPipe((e) => events.push(e)));
      const fwd = await startForwarder(
        (req, socket, head) => wsFwd.handle(req as never, socket, head, requestScope()),
        upgradeReq("target.example", 8443),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
        expect(guardError(events, "[upgrade] error ")).toBe(
          `[upgrade] error 127.0.0.1 -> target.example:8443 via 127.0.0.1:${dead}`,
        );
        client.destroy();
      } finally {
        await fwd.close();
      }
    });

    it("主路径回落直连（server 模式）：route 为 `-> <host>:<port>`，无上游尾巴", async () => {
      set("proxyMode", "server");
      const dead = await getFreePort();
      const events: PipeEvent[] = [];
      subs.push(collectPipe((e) => events.push(e)));
      const fwd = await startForwarder(
        (req, socket, head) => wsFwd.handle(req as never, socket, head, requestScope()),
        upgradeReq("127.0.0.1", dead),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
        expect(guardError(events, "[upgrade] error ")).toBe(
          `[upgrade] error 127.0.0.1 -> 127.0.0.1:${dead}`,
        );
        client.destroy();
      } finally {
        await fwd.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 连接器选择：有效路由是 direct 时必须走 directConnector，绝不碰 connectorFor
  // -------------------------------------------------------------------------

  describe("连接器选择（有效路由 direct ⟺ directConnector）", () => {
    let dir: string;
    let aclPath: string;

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-connector-wiring-"));
      aclPath = path.join(dir, "acl.json");
    });

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    /** 写 acl.json 并强制重读（跳过 1s 节流，等价于节流窗口已过） */
    function writeAcl(acl: unknown): void {
      set("aclFile", aclPath);
      fs.writeFileSync(aclPath, JSON.stringify(acl));
      readAcl({ config: testConfig, force: true });
    }

    /**
     * 造「真目标桩 + 上游代理桩」一对：拨了谁由 `received()` 判别。
     * 上游桩刻意选 sockss5 承载的 `sockss5` 协议：它是**代理型**连接器，
     * 若接线误用 `connectorFor` 就一定会去拨它（明文握手首字节 0x05 一眼可辨）。
     */
    async function startPair(): Promise<{ target: Tcp; upstream: Tcp }> {
      const target = await startTcp();
      const upstream = await startTcp((sock) => {
        // 假 SOCKS5 上游：应请求就应答（这样「误走上游」会表现为真目标没收到任何字节）
        let stage: "method" | "connect" = "method";
        sock.on("data", () => {
          if (stage === "method") {
            stage = "connect";
            sock.write(Buffer.from([0x05, 0x00]));
            return;
          }

          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        });
      });

      return { target, upstream };
    }

    it("CONNECT：client 模式 + upstream 路由名单命中 → 直拨真目标，上游桩零字节", async () => {
      writeAcl({ upstream: { blacklist: ["127.0.0.1"] } });
      set("proxyMode", "client");
      set("upstreamProtocol", "socks5");
      const { target, upstream } = await startPair();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", upstream.port);

      const fwd = await startForwarder(
        (req, socket, head) => tunnelFwd.handle(req as never, socket, head, requestScope()),
        connectReq("127.0.0.1", target.port),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        client.write("probe-through-tunnel");
        await c.waitFor((b) => b.includes(Buffer.from("200 Connection Established")), 3000);
        // 探针经隧道到达真目标 = 走的是 directConnector
        await waitUntil(
          () => target.received().includes(Buffer.from("probe-through-tunnel")),
          3000,
          "真目标收到探针",
        );
        expect(target.received().length).toBeGreaterThan(0);
        // 上游桩一个字节都没收到 = 绝没有走 connectorFor
        expect(upstream.received().length).toBe(0);
        client.destroy();
      } finally {
        await fwd.close();
        await target.close();
        await upstream.close();
      }
    });

    it("WebSocket：client 模式 + upstream 路由名单命中 → 直拨真目标并等 101，上游桩零字节", async () => {
      writeAcl({ upstream: { blacklist: ["127.0.0.1"] } });
      set("proxyMode", "client");
      set("upstreamProtocol", "socks5");
      // 真目标会回 101（裸状态行 + CRLFCRLF 即可，relay 不校验 Upgrade 头）
      const target = await startTcp((sock) => {
        sock.on("data", (c: Buffer) => {
          if (c.includes(Buffer.from("\r\n\r\n"))) {
            sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
          }
        });
      });
      const upstream = await startTcp((sock) => {
        let stage: "method" | "connect" = "method";
        sock.on("data", () => {
          if (stage === "method") {
            stage = "connect";
            sock.write(Buffer.from([0x05, 0x00]));
            return;
          }

          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        });
      });
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", upstream.port);

      const fwd = await startForwarder(
        (req, socket, head) => wsFwd.handle(req as never, socket, head, requestScope()),
        upgradeReq("127.0.0.1", target.port),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        client.write("GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n\r\n");
        await c.waitFor((b) => b.includes(Buffer.from("101")), 3000);
        // origin-form + Host 回写真实目标（不是上游地址）
        await waitUntil(
          () => target.received().includes(Buffer.from("Host: 127.0.0.1")),
          3000,
          "真目标收到 Upgrade",
        );
        expect(target.received().toString().startsWith("GET /ws HTTP/1.1")).toBe(true);
        // 绝不带上游凭证头
        expect(target.received().toString().toLowerCase()).not.toContain("proxy-authorization");
        expect(upstream.received().length).toBe(0);
        client.destroy();
      } finally {
        await fwd.close();
        await target.close();
        await upstream.close();
      }
    });

    it("SOCKS：client 模式 + upstream 路由名单命中 → 直拨真目标并回成功应答，上游桩零字节", async () => {
      writeAcl({ upstream: { blacklist: ["127.0.0.1"] } });
      set("proxyMode", "client");
      set("upstreamProtocol", "socks5");
      const { target, upstream } = await startPair();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", upstream.port);

      const events: PipeEvent[] = [];

      subs.push(collectPipe((e) => events.push(e)));
      await withProxy(Socks5Proxy, {}, async (port) => {
        const sock = await tcConnect(port);

        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        await readBytes(sock, 2);
        sock.write(socks5ConnectIpv4("127.0.0.1", target.port));

        const reply = await readBytes(sock, 10);

        // 成功应答（REP=0x00）；误走 connectorFor 时真目标收不到任何字节
        expect(reply[1]).toBe(0x00);
        sock.write("probe-through-socks");
        await waitUntil(
          () => target.received().includes(Buffer.from("probe-through-socks")),
          3000,
          "真目标收到探针",
        );
        expect(upstream.received().length).toBe(0);
        sock.destroy();
      });
    });
  });
});

/** 订阅共享测试总线上的 `pipe` 事实（core 直发，订阅源取注入的 ctx.events） */
function collectPipe(sink: (e: PipeEvent) => void): EventSubscription {
  return testEvents.subscribe("pipe", (e) => sink(e.data));
}
