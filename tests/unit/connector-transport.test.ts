/**
 * @fileoverview 连接器端口新成员 `transport()` / `peerTarget()` 的契约护栏
 * @description
 * Phase 2b-2a 给 `UpstreamConnector` 加了「传输层」能力：`transport()` 打开一条到
 * **本连接器对端**的连接但**不做协议级协商**（配合 `http.request({ createConnection })`），
 * `peerTarget(dest)` 声明这条管道**实际落到哪个 TCP 对端**。
 *
 * 本文件与 `connector-open.test.ts` / `connector-registry.test.ts` 的分工：
 * 那两份是 2b-1 的合同（`open()` 发出的真实字节、6 协议 → 4 类的映射表），**断言不得改**；
 * 本文件只锁新成员，核心三条：
 * 1. `HttpConnectConnector.transport()` **只拨号、不发 CONNECT、不等状态行**（最容易被
 *    「顺手复用 open()」破坏的一条——多发一个 CONNECT 会把上游代理的协议状态机带偏：
 *    它会先回 200 再等 CONNECT，而 `http.request` 已经在等 HTTP 响应 → 死锁）；
 * 2. `peerTarget(dest)` 的四类取值：代理型 = 上游地址，直连/SOCKS = 目标地址；
 * 3. `transport()` 与 `open()` 在直连/SOCKS 上同源（`rest` 契约上恒空，故无字节丢失）。
 */
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { once } from "node:events";
import { PassThrough, type Duplex } from "node:stream";
import {
  DirectConnector,
  HttpConnectConnector,
  Socks4Connector,
  Socks5Connector,
  type UpstreamConnector,
} from "@/core/forward/upstream/connector/index.js";
import { restoreConfig, set, snapshotConfig, testContext } from "../helpers/config.js";
import { getFreePort, listen } from "../helpers/net.js";

/** 上游地址（http-connect 的 peerTarget 必须逐字等于它，而不是 dest） */
const UPSTREAM = { host: "proxy.internal", port: 8080 };
/** 目标三元组（域名型，避开本机解析差异） */
const DEST = { host: "target.example", port: 8443 };

/** 裸 TCP 桩：自持 socket 集合，afterEach 逐条销毁后 close（net.Server 无 closeAllConnections） */
interface Stub {
  port: number;
  /** 收到的全部字节（证明「没有发任何协议报文」） */
  received: () => Buffer;
  close: () => Promise<void>;
}

const STUBS: Stub[] = [];
const SOCKS: Duplex[] = [];

afterEach(async () => {
  for (const s of SOCKS.splice(0)) {
    if (!s.destroyed) {
      s.destroy();
    }
  }

  while (STUBS.length) {
    await (STUBS.pop() as Stub).close();
  }
});

async function startStub(onData?: (c: Buffer, sock: net.Socket) => void): Promise<Stub> {
  const chunks: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    sock.on("data", (c: Buffer) => {
      chunks.push(c);
      onData?.(c, sock);
    });
  });
  const port = await getFreePort();

  await listen(server, port);

  const stub: Stub = {
    port,
    received: () => Buffer.concat(chunks),
    close: async () => {
      for (const s of sockets) {
        s.destroy();
      }
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  STUBS.push(stub);
  return stub;
}

/** 建一个哑 client（PassThrough）；只供拨号守卫取地址，连接器绝不向它写字节 */
function makeClient(): Duplex {
  const client = new PassThrough() as unknown as Duplex;
  client.on("error", () => {});
  return client;
}

/** 假 SOCKS5 上游：方法协商挑 0x00，CONNECT 回成功应答（只回字节，不做真隧道） */
function startFakeSocks5(): Promise<Stub> {
  let stage: "method" | "connect" = "method";

  return startStub((_c, sock) => {
    if (stage === "method") {
      stage = "connect";
      sock.write(Buffer.from([0x05, 0x00]));
      return;
    }
    sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
  });
}

// ---------------------------------------------------------------------------
// HttpConnectConnector.transport()：只拨号，绝不 CONNECT
// ---------------------------------------------------------------------------

describe("core/forward/upstream/connector transport(): http-connect", () => {
  it("沉默上游：只拨号就返回（不发 CONNECT、不等状态行），上游零字节", async () => {
    // 上游 accept 后永不说话：若 transport() 内部去等状态行（awaitStatusLine），
    // 这里会在 upstreamTimeout 之后 reject —— 返回成功本身就是「没有等状态行」的证据
    const up = await startStub();
    const prev = snapshotConfig(["upstreamHost", "upstreamPort", "upstreamTimeout"]);
    const client = makeClient();

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", up.port);
      set("upstreamTimeout", 5000);

      const sock = await new HttpConnectConnector(testContext, false).transport({
        client,
        dest: DEST,
        onEvent: () => {},
        logPrefix: "tunnel",
      });

      SOCKS.push(sock);
      expect(sock.destroyed).toBe(false);
      expect(up.received().length).toBe(0);
      // 硬不变量：连接器绝不允许向 client 写任何字节（应答归 channel）
      expect(client.writableLength).toBe(0);
    } finally {
      restoreConfig(prev);
    }
  });

  it("peerTarget 是上游地址（不是 dest），且与 selfLoopTarget 同源", () => {
    const prev = snapshotConfig(["upstreamHost", "upstreamPort"]);

    try {
      set("upstreamHost", UPSTREAM.host);
      set("upstreamPort", UPSTREAM.port);

      for (const secure of [false, true]) {
        // 经**端口类型**调用（与 http.ts 的实际用法同形）：连接器工厂返回的就是这个类型
        const c: UpstreamConnector = new HttpConnectConnector(testContext, secure);

        expect(c.peerTarget(DEST)).toEqual(UPSTREAM);
        // 与自环预检的数据同源（不允许两个成员各自读一次配置）
        expect(c.peerTarget(DEST)).toEqual(c.selfLoopTarget());
      }
    } finally {
      restoreConfig(prev);
    }
  });
});

// ---------------------------------------------------------------------------
// direct / socks4 / socks5：transport = open().sock，peerTarget = dest
// ---------------------------------------------------------------------------

describe("core/forward/upstream/connector transport()/peerTarget(): direct 与 socks*", () => {
  it("DirectConnector：peerTarget 就是 dest 原样（直连没有中间代理，不做任何归一）", () => {
    const c = new DirectConnector(testContext);

    expect(c.peerTarget(DEST)).toEqual(DEST);
    expect(c.peerTarget({ host: "::1", port: 443 })).toEqual({ host: "::1", port: 443 });
  });

  it("Socks4/Socks5Connector：peerTarget 也是 dest（SOCKS 隧道直达源站，不是上游）", () => {
    for (const c of [new Socks4Connector(testContext, false), new Socks5Connector(testContext, false)]) {
      expect(c.peerTarget(DEST)).toEqual(DEST);
      // 与 http-connect 形成对照：代理型走 selfLoopTarget，SOCKS 刻意不走
      expect(c.selfLoopTarget()).toBeDefined();
      expect(c.peerTarget(DEST)).not.toEqual(c.selfLoopTarget());
    }
  });

  it("DirectConnector.transport()：源站收到完整 HTTP 请求（与 open() 同源，无字节丢失）", async () => {
    const received: Buffer[] = [];
    const up = await startStub((c, sock) => {
      received.push(c);
      sock.write("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
    });
    const client = makeClient();
    const sock = await new DirectConnector(testContext).transport({
      client,
      dest: { host: "127.0.0.1", port: up.port },
      onEvent: () => {},
      logPrefix: "tunnel",
    });

    SOCKS.push(sock);
    sock.write("GET /hello HTTP/1.1\r\nHost: origin.example\r\n\r\n");

    const [res] = (await once(sock, "data")) as [Buffer];
    expect(res.toString()).toBe("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
    expect(Buffer.concat(received).toString()).toBe(
      "GET /hello HTTP/1.1\r\nHost: origin.example\r\n\r\n",
    );
    expect(client.writableLength).toBe(0);
  });

  it("Socks5Connector.transport()：SOCKS 握手与 open() 逐字同形（greeting + CONNECT）", async () => {
    const up = await startFakeSocks5();
    const prev = snapshotConfig(["upstreamHost", "upstreamPort", "upstreamUsername"]);
    const client = makeClient();

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", up.port);
      set("upstreamUsername", "");

      const sock = await new Socks5Connector(testContext, false).transport({
        client,
        dest: DEST,
        onEvent: () => {},
        logPrefix: "tunnel",
      });

      SOCKS.push(sock);
      const bytes = up.received();
      // greeting：VER=0x05 NMETHODS=1 METHOD=0x00（无上游账号 → 只报无鉴权）
      expect([...bytes.subarray(0, 3)]).toEqual([0x05, 0x01, 0x00]);
      // CONNECT：ATYP=DOMAIN + 长度域 + 目标 + 端口（与 open() 的逐字断言同源）
      // 偏移量 3 = greeting 的字节数（VER + NMETHODS + METHOD）
      const expected = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, DEST.host.length]),
        Buffer.from(DEST.host),
        Buffer.from([(DEST.port >> 8) & 0xff, DEST.port & 0xff]),
      ]);
      expect(bytes.subarray(3).equals(expected)).toBe(true);
      expect(client.writableLength).toBe(0);
    } finally {
      restoreConfig(prev);
    }
  });

  it("Socks4Connector.transport()：SOCKS4a 哨兵 0.0.0.1 + 尾部域名（与 open() 同源）", async () => {
    const up = await startStub((_c, sock) => {
      sock.write(Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0]));
    });
    const prev = snapshotConfig(["upstreamHost", "upstreamPort", "upstreamUsername"]);
    const client = makeClient();

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", up.port);
      set("upstreamUsername", "up-user");

      const sock = await new Socks4Connector(testContext, false).transport({
        client,
        dest: DEST,
        onEvent: () => {},
        logPrefix: "tunnel",
      });

      SOCKS.push(sock);
      const expected = Buffer.concat([
        Buffer.from([0x04, 0x01, (DEST.port >> 8) & 0xff, DEST.port & 0xff, 0x00, 0x00, 0x00, 0x01]),
        Buffer.from("up-user"),
        Buffer.from([0x00]),
        Buffer.from(DEST.host),
        Buffer.from([0x00]),
      ]);
      expect(up.received().equals(expected)).toBe(true);
      expect(client.writableLength).toBe(0);
    } finally {
      restoreConfig(prev);
    }
  });
});
