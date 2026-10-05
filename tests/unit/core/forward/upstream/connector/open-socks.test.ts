/**
 * `Socks5Connector.open()` 与 `Socks4Connector.open()`：**ATYP / SOCKS4a 哨兵逐字节锁死**
 *
 * @description
 * 两条决策（结论 — 否掉了什么 — 为什么）：
 *
 * **① SOCKS5 CONNECT 的 ATYP 对 IPv4 与域名一律沿用 `SOCKS5_ATYP_DOMAIN`**（刻意的简化，
 * **不许「修正」**）。被否掉的是「按 family 细分」：family 6 走 `SOCKS5_ATYP_IPV6` + 16 字节地址
 * （域名型是字符串、无 v6 语义），而 IPv4 用 domain 形态虽冗余但**两种上游实现都接受**；
 * 分族只会多一条「IPv4 走错 ATYP」的分支而无收益。SOCKS4a 无地址族字段，IPv6 亦按域名串
 * 交给上游（不加分支）。牙齿 = 三条各锁一档：`dest: { host: "10.1.2.3", port: 8080 }` 却期望
 * `[0x05, 0x01, 0x00, 0x03, 0x08, …"10.1.2.3", 0x1f, 0x90]` —— **有人「顺手修正」成 ATYP=0x01，
 * 那条立刻红。**
 *
 * **② SOCKS4a 域名走 `0.0.0.1` 哨兵 + 尾部域名；USERID 取 `upstreamUsername`，未配置即空。**
 * 被否掉的是「未配置时拒绝」——那会把「没配上游用户名」变成「所有 SOCKS4a 上游不可用」，而
 * 代理对该字段的缺席有合理默认（无 USERID）。牙齿 = 那两条逐字节比对（域名目标第 5–8 字节是
 * `0.0.0.1` 哨兵；IPv4 目标末尾那个 `0x00` 就是「USERID 未配置即空」的空串终止符）——
 * 改成「未配账号就拒绝」或「未配账号发个占位 USERID」，立刻红。
 *
 * 三档共用的收尾与「连接器绝不向 client 写字节」纪律在 `AGENTS.md`。
 */
import { describe, expect, it } from "vitest";
import net from "node:net";
import {
  Socks4Connector,
  Socks5Connector,
} from "@/core/forward/upstream/connector/index.js";
import { restoreConfig, set, snapshotConfig, testContext } from "../../../../../helpers/config.js";
import { getFreePort, listen } from "../../../../../helpers/net.js";
import { DEST, makeClient, OPEN_ENDS, UPSTREAM_USER } from "./_connector-open.js";

const DEST_PORT_HI = (DEST.port >> 8) & 0xff;
const DEST_PORT_LO = DEST.port & 0xff;

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

describe("core/forward/upstream/connector/socks5 open()", () => {
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
        logPrefix: "tunnel",
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
        logPrefix: "tunnel",
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
        logPrefix: "tunnel",
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
        logPrefix: "tunnel",
      });

      OPEN_ENDS.push({ sock: opened.sock });

      expect([...up.methodReq()]).toEqual([0x05, 0x02, 0x00, 0x02]);
    } finally {
      restoreConfig(prev);
    }
  });
});

describe("core/forward/upstream/connector/socks4 open()", () => {
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
        logPrefix: "tunnel",
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
        logPrefix: "tunnel",
      });

      OPEN_ENDS.push({ sock: opened.sock });

      const expected = Buffer.from([0x04, 0x01, 0x1f, 0x90, 10, 1, 2, 3, 0x00]);

      expect(up.received().equals(expected)).toBe(true);
    } finally {
      restoreConfig(prev);
    }
  });
});
