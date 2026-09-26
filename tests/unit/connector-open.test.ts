import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { once } from "node:events";
import { PassThrough, type Duplex } from "node:stream";
import {
  DirectConnector,
  HttpConnectConnector,
  Socks4Connector,
  Socks5Connector,
  type OpenContext,
  type UpstreamConnector,
} from "@/core/forward/connector/index.js";
import { DialTimeoutError } from "@/core/forward/dial.js";
import type { HelperEvent } from "@/core/guard.js";
import { restoreConfig, set, snapshotConfig, testContext } from "../helpers/config.js";
import { getFreePort, listen } from "../helpers/net.js";

/** 本文件锁的是「连接器发出的**真实字节**」，不是返回值形状（registry 用例锁形状） */

const UPSTREAM_USER = "up-user";
const UPSTREAM_PASS = "up-pass";
const UPSTREAM_BASIC = `Basic ${Buffer.from(`${UPSTREAM_USER}:${UPSTREAM_PASS}`).toString("base64")}`;

/** 目标三元组（域名型，避开本机解析差异） */
const DEST = { host: "target.example", port: 8443 };
const DEST_PORT_HI = (DEST.port >> 8) & 0xff;
const DEST_PORT_LO = DEST.port & 0xff;

/** 每个用例登记自己起的 server / client，afterEach 统一收尾（禁止残留长跑进程） */
interface Tally {
  server?: net.Server;
  client?: Duplex;
  sock?: Duplex;
}

const OPEN_ENDS: Tally[] = [];

afterEach(async () => {
  while (OPEN_ENDS.length) {
    const t = OPEN_ENDS.pop() as Tally;

    for (const s of [t.sock, t.client]) {
      if (s && !s.destroyed) {
        s.destroy();
      }
    }

    if (t.server) {
      await new Promise<void>((resolve) => t.server?.close(() => resolve()));
    }
  }
});

/** 建一个哑 client（PassThrough）并登记收尾；同时收集它收到的字节（应恒为空） */
function makeClient(): { client: Duplex; seen: Buffer[] } {
  const client = new PassThrough() as unknown as Duplex;
  const seen: Buffer[] = [];

  client.on("data", (c: Buffer) => seen.push(c));
  client.on("error", () => {});
  OPEN_ENDS.push({ client });

  return { client, seen };
}

/** 组装 OpenContext（测试侧只提供 `onEvent`/`logPrefix`/`dest`，其余给缺省） */
function openCtx(partial: Partial<OpenContext> & { client: Duplex; dest: OpenContext["dest"] }) {
  const events: HelperEvent[] = [];

  return {
    events,
    ctx: {
      onEvent: (e: HelperEvent) => events.push(e),
      ...partial,
    } as OpenContext,
  };
}

const closeServer = (server: net.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

// ---------------------------------------------------------------------------
// direct：明文直拨真实目标
// ---------------------------------------------------------------------------

/** 假源站：收到任何字节即回一个最小 HTTP 响应 */
async function startFakeOrigin(): Promise<{ port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = net.createServer((sock) => {
    sock.on("error", () => {});

    sock.on("data", (chunk: Buffer) => {
      received.push(chunk);
      sock.write("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
    });
  });

  const port = await getFreePort();

  await listen(server, port);
  OPEN_ENDS.push({ server });

  return { port, received };
}

describe("core/forward/connector/direct open()", () => {
  it("直连真实目标：源站收到完整 HTTP 请求并回得出响应，rest 恒空且无 refusal", async () => {
    const { port, received } = await startFakeOrigin();
    const { client, seen } = makeClient();

    const opened = await new DirectConnector(testContext).open({
      client,
      dest: { host: "127.0.0.1", port },
      onEvent: () => {},
    });

    OPEN_ENDS.push({ sock: opened.sock });

    expect(opened.rest.length).toBe(0);
    expect(opened.refusal).toBeUndefined();

    opened.sock.write("GET /hello HTTP/1.1\r\nHost: origin.example\r\n\r\n");

    const [res] = (await once(opened.sock, "data")) as [Buffer];
    expect(res.toString()).toBe("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
    expect(Buffer.concat(received).toString()).toBe(
      "GET /hello HTTP/1.1\r\nHost: origin.example\r\n\r\n",
    );

    // 硬不变量：connector 绝不允许向 client 写任何字节（应答归 channel）
    expect(seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// http-connect：拨上游 → 发 CONNECT → 等状态行
// ---------------------------------------------------------------------------

/** 假 HTTP 上游代理：读到完整请求头后原样回 `raw`（应答文本完全由用例控制） */
async function startFakeConnectProxy(raw: string): Promise<{ port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = net.createServer((sock) => {
    let answered = false;

    sock.on("error", () => {});

    sock.on("data", (chunk: Buffer) => {
      received.push(chunk);

      if (!answered && Buffer.concat(received).includes("\r\n\r\n")) {
        answered = true;
        sock.write(raw);
      }
    });
  });

  const port = await getFreePort();

  await listen(server, port);
  OPEN_ENDS.push({ server });

  return { port, received };
}

describe("core/forward/connector/http-connect open()", () => {
  it("上游收到的第一行是 CONNECT dest，且响应头之后的先发字节如实进 rest", async () => {
    const { port, received } = await startFakeConnectProxy(
      "HTTP/1.1 200 Connection Established\r\nX-Marker: ok\r\n\r\nSSH-2.0-fake\r\n",
    );
    const prev = snapshotConfig(["upstreamHost", "upstreamPort"]);
    const { client, seen } = makeClient();

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", port);

      const opened = await new HttpConnectConnector(testContext, false).open({
        client,
        dest: DEST,
        onEvent: () => {},
      });

      OPEN_ENDS.push({ sock: opened.sock });

      const head = Buffer.concat(received).toString();
      const lines = head.split("\r\n");

      expect(lines[0]).toBe("CONNECT target.example:8443 HTTP/1.1");
      expect(lines[1]).toBe("Host: target.example:8443");
      expect(lines[2]).toBe("Proxy-Connection: keep-alive");
      expect(head.endsWith("\r\n\r\n")).toBe(true);
      // 未配上游账号：绝不注入 Proxy-Authorization（防 client 头透传泄漏）
      expect(head.toLowerCase()).not.toContain("proxy-authorization");

      expect(opened.refusal).toBeUndefined();
      // 响应头之后上游已发出的字节（server-speaks-first）必须留在 rest，不被吞掉
      expect(opened.rest.toString()).toBe("SSH-2.0-fake\r\n");
      expect(seen).toHaveLength(0);
    } finally {
      restoreConfig(prev);
    }
  });

  it("配了上游账号即在 CONNECT 报文注入 Proxy-Authorization 头值", async () => {
    const { port, received } = await startFakeConnectProxy(
      "HTTP/1.1 200 Connection Established\r\n\r\n",
    );
    const prev = snapshotConfig([
      "upstreamHost",
      "upstreamPort",
      "upstreamUsername",
      "upstreamPassword",
    ]);
    const { client } = makeClient();

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", port);
      set("upstreamUsername", UPSTREAM_USER);
      set("upstreamPassword", UPSTREAM_PASS);

      const opened = await new HttpConnectConnector(testContext, false).open({
        client,
        dest: DEST,
        onEvent: () => {},
      });

      OPEN_ENDS.push({ sock: opened.sock });

      const lines = Buffer.concat(received).toString().split("\r\n");
      expect(lines[0]).toBe("CONNECT target.example:8443 HTTP/1.1");
      expect(lines[2]).toBe(`Proxy-Authorization: ${UPSTREAM_BASIC}`);
    } finally {
      restoreConfig(prev);
    }
  });

  it("上游回非 200：refusal 如实报告（状态码/响应头/余量），且 sock 照常返回、销毁归 channel", async () => {
    const { port } = await startFakeConnectProxy(
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="up"\r\n\r\ndenied',
    );
    const prev = snapshotConfig(["upstreamHost", "upstreamPort"]);
    const { client, seen } = makeClient();

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", port);

      const opened = await new HttpConnectConnector(testContext, false).open({
        client,
        dest: DEST,
        onEvent: () => {},
      });

      OPEN_ENDS.push({ sock: opened.sock });

      expect(opened.refusal).toBeDefined();
      expect(opened.refusal?.statusCode).toBe("407");
      expect(opened.refusal?.head.toString()).toBe(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="up"\r\n\r\n',
      );
      expect(opened.refusal?.rest.toString()).toBe("denied");
      // refusal 存在时两处 rest 是同一缓冲（都描述响应头之后上游发出的字节）
      expect(opened.rest.equals(opened.refusal?.rest as Buffer)).toBe(true);
      // 成败应答归 channel：connector 不销毁、不替客户端写任何字节
      expect(opened.sock.destroyed).toBe(false);
      expect(seen).toHaveLength(0);
    } finally {
      restoreConfig(prev);
    }
  });
});

// ---------------------------------------------------------------------------
// socks5
// ---------------------------------------------------------------------------

/** 假 SOCKS5 上游：方法协商挑 0x00（无鉴权），CONNECT 回成功应答；两段请求分开记录 */
async function startFakeSocks5(): Promise<{
  port: number;
  methodReq: () => Buffer;
  connectReq: () => Buffer;
}> {
  const method: Buffer[] = [];
  const connect: Buffer[] = [];
  const server = net.createServer((sock) => {
    let stage: "method" | "connect" = "method";

    sock.on("error", () => {});

    sock.on("data", (chunk: Buffer) => {
      if (stage === "method") {
        method.push(chunk);
        stage = "connect";
        sock.write(Buffer.from([0x05, 0x00]));
        return;
      }

      connect.push(chunk);
      // CONNECT 成功应答（ATYP=IPv4 全零）
      sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    });
  });

  const port = await getFreePort();

  await listen(server, port);
  OPEN_ENDS.push({ server });

  return { port, methodReq: () => Buffer.concat(method), connectReq: () => Buffer.concat(connect) };
}

describe("core/forward/connector/socks5 open()", () => {
  it("域名目标：ATYP=DOMAIN，长度域与端口逐字节正确", async () => {
    const up = await startFakeSocks5();
    const prev = snapshotConfig(["upstreamHost", "upstreamPort", "upstreamUsername"]);
    const { client, seen } = makeClient();

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", up.port);
      set("upstreamUsername", "");

      const opened = await new Socks5Connector(testContext, false).open({
        client,
        dest: DEST,
        onEvent: () => {},
      });

      OPEN_ENDS.push({ sock: opened.sock });

      // 无上游账号：只报无鉴权方法
      expect([...up.methodReq()]).toEqual([0x05, 0x01, 0x00]);
      expect([...up.connectReq()]).toEqual([
        0x05,
        0x01,
        0x00,
        0x03,
        DEST.host.length,
        ...Buffer.from(DEST.host),
        DEST_PORT_HI,
        DEST_PORT_LO,
      ]);
      expect(opened.rest.length).toBe(0);
      expect(opened.refusal).toBeUndefined();
      expect(seen).toHaveLength(0);
    } finally {
      restoreConfig(prev);
    }
  });

  it("IPv6 字面量目标：ATYP=IPV6 且带 16 字节地址（域名型无 v6 语义）", async () => {
    const up = await startFakeSocks5();
    const prev = snapshotConfig(["upstreamHost", "upstreamPort"]);
    const { client } = makeClient();

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", up.port);

      const opened = await new Socks5Connector(testContext, false).open({
        client,
        dest: { host: "::1", port: 443 },
        onEvent: () => {},
      });

      OPEN_ENDS.push({ sock: opened.sock });

      const req = up.connectReq();
      const expected = Buffer.from([
        0x05,
        0x01,
        0x00,
        0x04,
        ...Array(15).fill(0),
        0x01,
        0x01,
        0xbb,
      ]);

      expect(req.equals(expected)).toBe(true);
    } finally {
      restoreConfig(prev);
    }
  });

  it("IPv4 字面量目标：仍用 ATYP=DOMAIN 承载（既有的刻意简化，锁死不许被「修正」）", async () => {
    const up = await startFakeSocks5();
    const prev = snapshotConfig(["upstreamHost", "upstreamPort"]);
    const { client } = makeClient();

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", up.port);

      const opened = await new Socks5Connector(testContext, false).open({
        client,
        dest: { host: "10.1.2.3", port: 8080 },
        onEvent: () => {},
      });

      OPEN_ENDS.push({ sock: opened.sock });

      const expected = Buffer.from([
        0x05,
        0x01,
        0x00,
        0x03,
        0x08,
        ...Buffer.from("10.1.2.3"),
        0x1f,
        0x90,
      ]);

      expect(up.connectReq().equals(expected)).toBe(true);
    } finally {
      restoreConfig(prev);
    }
  });

  it("配了上游账号：首轮同时报无鉴权与用户密码两种方法（由上游挑选）", async () => {
    const up = await startFakeSocks5();
    const prev = snapshotConfig(["upstreamHost", "upstreamPort", "upstreamUsername"]);
    const { client } = makeClient();

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", up.port);
      set("upstreamUsername", UPSTREAM_USER);

      const opened = await new Socks5Connector(testContext, false).open({
        client,
        dest: DEST,
        onEvent: () => {},
      });

      OPEN_ENDS.push({ sock: opened.sock });

      expect([...up.methodReq()]).toEqual([0x05, 0x02, 0x00, 0x02]);
    } finally {
      restoreConfig(prev);
    }
  });
});

// ---------------------------------------------------------------------------
// socks4 / socks4a
// ---------------------------------------------------------------------------

/** 假 SOCKS4 上游：收到请求即回 8 字节 granted 应答 */
async function startFakeSocks4(): Promise<{ port: number; received: () => Buffer }> {
  const received: Buffer[] = [];
  const server = net.createServer((sock) => {
    let answered = false;

    sock.on("error", () => {});

    sock.on("data", (chunk: Buffer) => {
      received.push(chunk);

      if (!answered) {
        answered = true;
        sock.write(Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0]));
      }
    });
  });

  const port = await getFreePort();

  await listen(server, port);
  OPEN_ENDS.push({ server });

  return { port, received: () => Buffer.concat(received) };
}

describe("core/forward/connector/socks4 open()", () => {
  it("域名目标：SOCKS4a 哨兵 0.0.0.1 + 尾部域名 + USERID 取上游账号", async () => {
    const up = await startFakeSocks4();
    const prev = snapshotConfig(["upstreamHost", "upstreamPort", "upstreamUsername"]);
    const { client, seen } = makeClient();

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", up.port);
      set("upstreamUsername", UPSTREAM_USER);

      const opened = await new Socks4Connector(testContext, false).open({
        client,
        dest: DEST,
        onEvent: () => {},
      });

      OPEN_ENDS.push({ sock: opened.sock });

      const expected = Buffer.concat([
        Buffer.from([0x04, 0x01, DEST_PORT_HI, DEST_PORT_LO, 0x00, 0x00, 0x00, 0x01]),
        Buffer.from(UPSTREAM_USER),
        Buffer.from([0x00]),
        Buffer.from(DEST.host),
        Buffer.from([0x00]),
      ]);

      expect(up.received().equals(expected)).toBe(true);
      expect(opened.rest.length).toBe(0);
      expect(opened.refusal).toBeUndefined();
      expect(seen).toHaveLength(0);
    } finally {
      restoreConfig(prev);
    }
  });

  it("IPv4 目标：纯 4 字节地址（无哨兵、无域名尾），未配账号时 USERID 为空", async () => {
    const up = await startFakeSocks4();
    const prev = snapshotConfig(["upstreamHost", "upstreamPort", "upstreamUsername"]);
    const { client } = makeClient();

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", up.port);
      set("upstreamUsername", "");

      const opened = await new Socks4Connector(testContext, false).open({
        client,
        dest: { host: "10.1.2.3", port: 8080 },
        onEvent: () => {},
      });

      OPEN_ENDS.push({ sock: opened.sock });

      const expected = Buffer.from([0x04, 0x01, 0x1f, 0x90, 10, 1, 2, 3, 0x00]);

      expect(up.received().equals(expected)).toBe(true);
    } finally {
      restoreConfig(prev);
    }
  });
});

// ---------------------------------------------------------------------------
// 失败路径：拨号失败必须 reject（不吞），且向 client 一个字节都不写
// ---------------------------------------------------------------------------

describe("core/forward/connector 拨号失败", () => {
  it("四个连接器拨不通上游时一律 reject，且不向 client 写任何字节", async () => {
    const dead = await getFreePort();
    const prev = snapshotConfig(["upstreamHost", "upstreamPort"]);
    const { client, seen } = makeClient();

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);

      const cases: { name: string; make: () => UpstreamConnector; dest: OpenContext["dest"] }[] = [
        {
          name: "direct",
          make: () => new DirectConnector(testContext),
          dest: { host: "127.0.0.1", port: dead },
        },
        {
          name: "http-connect",
          make: () => new HttpConnectConnector(testContext, false),
          dest: DEST,
        },
        {
          name: "socks4",
          make: () => new Socks4Connector(testContext, false),
          dest: DEST,
        },
        {
          name: "socks5",
          make: () => new Socks5Connector(testContext, false),
          dest: DEST,
        },
      ];

      for (const c of cases) {
        await expect(
          c.make().open({ client, dest: c.dest, onEvent: () => {} }),
          `${c.name} 拨号失败必须 reject`,
        ).rejects.toThrow();
      }

      expect(seen).toHaveLength(0);
      // keepClientOnFailure：失败后 client 仍活着，收尾留给 channel 写自己的失败应答
      expect(client.destroyed).toBe(false);
    } finally {
      restoreConfig(prev);
    }
  });

  it("sockss* 走 TLS 承载：明文哑上游只会收到 TLS ClientHello，且沉默上游按 upstreamTimeout 兜底", async () => {
    const firstByte: number[] = [];
    const server = net.createServer((sock) => {
      sock.on("error", () => {});
      sock.on("data", (chunk: Buffer) => {
        if (firstByte.length === 0) {
          firstByte.push(chunk[0]);
        }
        // 沉默：不回任何字节，逼 upstreamTimeout 兜底
      });
    });

    const port = await getFreePort();

    await listen(server, port);

    const prev = snapshotConfig(["upstreamHost", "upstreamPort", "upstreamTimeout"]);
    const { client } = makeClient();
    const { ctx, events } = openCtx({ client, dest: DEST, logPrefix: "sockss" });

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", port);
      set("upstreamTimeout", 1200);

      await expect(new Socks5Connector(testContext, true).open(ctx)).rejects.toThrow(
        DialTimeoutError,
      );

      // TLS record 首字节固定 0x16（handshake）
      expect(firstByte).toEqual([0x16]);
      // logPrefix 必须透传到守卫事件（`[sockss] timeout ...`）
      expect(
        events.some(
          (e) => e.type === "upstream-timeout" && e.message.startsWith("[sockss] timeout"),
        ),
      ).toBe(true);
    } finally {
      restoreConfig(prev);
      await closeServer(server);
    }
  });
});
