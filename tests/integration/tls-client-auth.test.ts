/**
 * 集成回归：tlsCa 配了就是真 mTLS
 * 背景：此前 tlsCa 只作为 `ca` 传给 createServer，从不置 requestCert/rejectUnauthorized，
 * 文档承诺的「校验客户端证书」实际为零（装了 CA 却从不向客户端索要证书）——本文件是该承诺的护栏。
 * 覆盖：
 * - sockss5 / https 配 CA：无客户端证书 → 握手被拒，绝不进入协议层（收不到 SOCKS 应答 / 无 HTTP 响应）
 * - sockss5 / https 配 CA：带 CA 签发的客户端证书 → 正常转发（证明不是「一律拒绝」）
 * - 未配 CA：无证书客户端照常可用（mTLS 关闭时无回归）
 * - 配了 CA 但文件读不到 → 启动 abort（fail-closed，绝不静默降级为不校验）
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { set, testConfig } from "../helpers/config.js";
import { Auth } from "@/core/auth.js";
import { HttpsProxy } from "@/core/server/https.js";
import { Sockss5Proxy } from "@/core/server/sockss5.js";
import { getFreePort } from "../helpers/net.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../helpers/config.js";
import { TEST_CA_PATH, TEST_CLIENT_CERTS, TEST_TLS_PATHS } from "../helpers/certs.js";
import { withProxy } from "../helpers/proxy.js";
import { makeCollector, socks5ConnectIpv4, tlsConnect } from "../helpers/socks-client.js";
import { LoggerImpl } from "@/utils/logger/index.js";

/** 当前测试实例显式注入 core；mTLS 拒绝必须写入这个 logger。 */
const injectedLogger = new LoggerImpl({ level: "silent" });
const warn = vi.spyOn(injectedLogger, "warn").mockImplementation(() => {});

const AUTH_OFF = new Auth({ enabled: false });

/** mTLS 服务端参数：配了 ca 即强制校验客户端证书 */
const MTLS_SERVER = {
  tls: { ...TEST_TLS_PATHS, ca: TEST_CA_PATH },
  logger: injectedLogger,
};

/** mTLS 客户端参数：带 CA 签发的客户端证书，并校验服务端证书（rejectUnauthorized 默认 true） */
const MTLS_CLIENT = {
  key: TEST_CLIENT_CERTS.key,
  cert: TEST_CLIENT_CERTS.cert,
  ca: fs.readFileSync(TEST_CA_PATH),
  servername: "localhost",
};

/** 原始 TLS 连接：不等 secureConnect（握手可能被服务端拒绝），结果交给调用方观察 */
function rawTlsConnect(port: number, opts: tls.ConnectionOptions = {}): tls.TLSSocket {
  return tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ...opts });
}

/** 等握手成功，失败即抛（用于断言带证书的客户端确实被接受） */
function tlsSecure(sock: tls.TLSSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.once("secureConnect", () => resolve());
    sock.once("error", reject);
  });
}

describe("integration/tls-client-auth", () => {
  let originPort = 0;
  let origin: http.Server | null = null;
  let echoPort = 0;
  let echo: net.Server | null = null;
  const prev = snapshotConfig(["host", "port", "proxyMode", "logLevel", "logFile"]);

  beforeAll(async () => {
    silenceLogs();
    set("host", "127.0.0.1");
    set("proxyMode", "server");

    originPort = await getFreePort();
    origin = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`origin-ok:${req.url}`);
    });
    await new Promise<void>((r) => origin!.listen(originPort, "127.0.0.1", r));

    echoPort = await getFreePort();
    echo = net.createServer((sock) => {
      sock.on("data", (d) => sock.write(d));
      sock.on("error", () => {});
    });
    await new Promise<void>((r) => echo!.listen(echoPort, "127.0.0.1", r));
  });

  afterAll(async () => {
    if (origin) await new Promise<void>((r) => origin!.close(() => r()));
    if (echo) await new Promise<void>((r) => echo!.close(() => r()));
    restoreConfig(prev);
  });

  it("sockss5 + tlsCa：无客户端证书 → 握手被拒，不进 SOCKS 会话", async () => {
    warn.mockClear();
    await withProxy(Sockss5Proxy, { auth: AUTH_OFF, ...MTLS_SERVER }, async (port) => {
      const sock = rawTlsConnect(port);
      const acc = makeCollector(sock);
      // 立刻发 greeting：服务端若错误放行会回 05 00，进而可以建隧道
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
      const outcome = await Promise.race([
        acc.waitClose(2500).then(() => "closed" as const),
        acc.waitFor((b) => b.length > 0, 2500).then(() => "replied" as const),
      ]);
      expect(outcome).toBe("closed");
      expect(acc.bytes()).toHaveLength(0);

      // 拒绝必须留下可 grep 的事件码（握手期拒绝与 authorized 兜底两路都走该事件）
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.startsWith("[tls-client-error]"))).toBe(true);
      sock.destroy();
    });
  });

  it("sockss5 + tlsCa：带 CA 签发的客户端证书 → 正常建隧道回显", async () => {
    await withProxy(Sockss5Proxy, { auth: AUTH_OFF, ...MTLS_SERVER }, async (port) => {
      const sock = rawTlsConnect(port, MTLS_CLIENT);
      const acc = makeCollector(sock);
      try {
        await tlsSecure(sock);
        // 双向认证成立：客户端证书被服务端接受，且客户端校验了服务端证书
        expect(sock.authorized).toBe(true);

        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        await acc.waitFor((b) => b.length >= 2 && b[0] === 0x05 && b[1] === 0x00);

        sock.write(socks5ConnectIpv4("127.0.0.1", echoPort));
        await acc.waitFor((b) => b.includes(Buffer.from([0x05, 0x00, 0x00, 0x01])));

        sock.write(Buffer.from("mtls-ok"));
        const got = await acc.waitFor((b) => b.includes(Buffer.from("mtls-ok")));
        expect(got.includes(Buffer.from("mtls-ok"))).toBe(true);
      } finally {
        sock.destroy();
      }
    });
  });

  it("sockss5 未配 tlsCa：无客户端证书照常可用（默认不强制 mTLS）", async () => {
    await withProxy(Sockss5Proxy, { auth: AUTH_OFF, tls: TEST_TLS_PATHS }, async (port) => {
      const sock = await tlsConnect(port);
      const acc = makeCollector(sock);
      try {
        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        await acc.waitFor((b) => b.length >= 2 && b[0] === 0x05 && b[1] === 0x00);

        sock.write(socks5ConnectIpv4("127.0.0.1", echoPort));
        await acc.waitFor((b) => b.includes(Buffer.from([0x05, 0x00, 0x00, 0x01])));

        sock.write(Buffer.from("plain-tls"));
        const got = await acc.waitFor((b) => b.includes(Buffer.from("plain-tls")));
        expect(got.includes(Buffer.from("plain-tls"))).toBe(true);
      } finally {
        sock.destroy();
      }
    });
  });

  it("https + tlsCa：无客户端证书 → 握手被拒，拿不到任何响应", async () => {
    warn.mockClear();
    await withProxy(HttpsProxy, { auth: AUTH_OFF, ...MTLS_SERVER }, async (port) => {
      const outcome = await new Promise<string>((resolve) => {
        const req = https.request(
          {
            host: "127.0.0.1",
            port,
            method: "GET",
            path: `http://127.0.0.1:${originPort}/no-cert`,
            rejectUnauthorized: false,
          },
          () => resolve("response"),
        );
        req.on("error", () => resolve("error"));
        req.end();
      });
      expect(outcome).toBe("error");

      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.startsWith("[tls-client-error]"))).toBe(true);
    });
  });

  it("https + tlsCa：带 CA 签发的客户端证书 → 正常代理转发 200", async () => {
    await withProxy(HttpsProxy, { auth: AUTH_OFF, ...MTLS_SERVER }, async (port) => {
      const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = https.request(
          {
            host: "127.0.0.1",
            port,
            method: "GET",
            path: `http://127.0.0.1:${originPort}/mtls`,
            ...MTLS_CLIENT,
          },
          (res) => {
            let data = "";
            res.on("data", (c: Buffer) => (data += c.toString()));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(200);
      expect(body).toBe("origin-ok:/mtls");
    });
  });

  it("tlsCa 配了但文件不可读 → 启动 abort（fail-closed）", async () => {
    const port = await getFreePort();
    const proxy = new Sockss5Proxy({
      config: testConfig,
      host: "127.0.0.1",
      port,
      auth: AUTH_OFF,
      tls: { ...TEST_TLS_PATHS, ca: "keys/definitely-missing-ca.crt" },
    });

    await expect(proxy.start()).rejects.toThrow();
    expect(proxy.isRunning()).toBe(false);
    expect(proxy.state).toBe("error");
  });
});
