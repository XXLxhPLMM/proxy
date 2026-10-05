/**
 * `DirectConnector.open()` 与 `HttpConnectConnector.open()`：**出站握手字节逐条锁死**
 *
 * @description
 * 上游握手的报文形态是**跨实现兼容**的契约（本仓连的是别人的 HTTP 代理），所以本档全部断言都落在
 * **字节面**：假上游只做「按报文应答」，连接器发出去的每一段都被逐字节比对。三档共用的收尾与
 * 「连接器绝不许向 client 写字节」纪律在 `AGENTS.md`；SOCKS 侧那两条决策在 `./open-socks.test.ts`，
 * 失败路径与 TLS 承载在 `./open-dial-failure.test.ts`。
 */
import { describe, expect, it } from "vitest";
import net from "node:net";
import { once } from "node:events";
import {
  DirectConnector,
  HttpConnectConnector,
} from "@/core/forward/upstream/connector/index.js";
import { restoreConfig, set, snapshotConfig, testContext } from "../../../../../helpers/config.js";
import { getFreePort, listen } from "../../../../../helpers/net.js";
import { DEST, makeClient, OPEN_ENDS, UPSTREAM_USER } from "./_connector-open.js";

/** 上游密码与 Base64 头值：CONNECT 报文注入那一档锁的是线上字节，故就地算（不引生产常量） */
const UPSTREAM_PASS = "up-pass";
const UPSTREAM_BASIC = `Basic ${Buffer.from(`${UPSTREAM_USER}:${UPSTREAM_PASS}`).toString("base64")}`;

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

describe("core/forward/upstream/connector/direct open()", () => {
  it("直连真实目标：源站收到完整 HTTP 请求并回得出响应，rest 恒空且无 refusal", async () => {
    const { port, received } = await startFakeOrigin();
    const { client, seen } = makeClient();

    const opened = await new DirectConnector(testContext).open({
      client,
      dest: { host: "127.0.0.1", port },
      onEvent: () => {},
      logPrefix: "tunnel",
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

describe("core/forward/upstream/connector/http-connect open()", () => {
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
        logPrefix: "tunnel",
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
        logPrefix: "tunnel",
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
        logPrefix: "tunnel",
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
