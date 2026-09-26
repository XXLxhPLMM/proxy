/**
 * @fileoverview 集成回归：client 模式下经 SOCKS/SOCKS-over-TLS 上游转发 + 拨号超时
 * - A：socks5 上游 → 真实 http 源站（普通 GET）
 * - B：chunked 请求体经 socks5 上游到达源站且解析正常（请求体重新分帧回归）
 * - C：sockss5（SOCKS over TLS）上游承载同一握手逻辑，回归“被误当 https 上游发 HTTP 请求行”缺陷
 * - D：TLS 上游握手卡死 → 拨号超时回 504（established 提前清除超时的回归）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { set, testContext } from "../helpers/config.js";
import { HttpProxy } from "@/core/server/http.js";
import { Auth } from "@/core/auth.js";
import { TunnelForwarder } from "@/core/forward/channel/tunnel.js";
import { inertTrafficAccount as INERT_TRAFFIC } from "@/core/traffic/index.js";
import { createRequestScope } from "@/core/request-scope.js";
import { RequestTerminal } from "@/core/request-terminal.js";
import { getFreePort, listen } from "../helpers/net.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../helpers/config.js";
import { TEST_CA_PATH, TEST_TLS_CERTS } from "../helpers/certs.js";

function closeServer(server: net.Server | tls.Server | http.Server | null): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

/** 造一条请求作用域：直构 core 时没有 runtime 注入的 publisher，terminal 退化为纯 guard */
function requestScope(): ReturnType<typeof createRequestScope> {
  return createRequestScope({ ctx: testContext, terminal: new RequestTerminal() });
}

/**
 * 最小 SOCKS5 上游：greeting → 05 00；CONNECT → 解析目标后 net.connect，回 05 00 00 01…… 并桥接
 * 承载于任意 net.Socket（TLSSocket 亦为 net.Socket，sockss* 场景复用同一逻辑）
 */
function attachSocks5(sock: net.Socket): void {
  sock.on("error", () => sock.destroy());

  sock.once("data", () => {
    // 选无鉴权
    sock.write(Buffer.from([0x05, 0x00]));

    sock.once("data", (req: Buffer) => {
      const len = req[4];
      const host = req.subarray(5, 5 + len).toString();
      const port = req.readUInt16BE(5 + len);

      const target = net.connect(port, host, () => {
        // 成功应答（IPv4 形态，BND 填零）
        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        sock.pipe(target);
        target.pipe(sock);
      });

      target.on("error", () => sock.destroy());
    });
  });
}

/** 经 client 模式代理发一次请求（path 为 absolute-form，串联给上游） */
function proxyRequest(
  proxyPort: number,
  req: { method: string; url: string; body?: string[] },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: req.method,
        path: req.url,
        headers: { Host: "example.com" },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    client.on("error", reject);

    // 不设 content-length：Node 自动以 chunked 发送请求体
    for (const chunk of req.body ?? []) {
      client.write(chunk);
    }

    client.end();
  });
}

/** 源站收到的请求快照 */
interface OriginHit {
  method: string;
  url: string;
  body: string;
  transferEncoding: string | undefined;
}

describe("integration/http-proxy forward via socks", () => {
  let proxyPort = 0;
  let originPort = 0;
  let socksPort = 0;
  let socksOverTlsPort = 0;
  let proxy: HttpProxy | null = null;
  let origin: http.Server | null = null;
  let socksUpstream: net.Server | null = null;
  let socksOverTlsUpstream: tls.Server | null = null;
  const hits: OriginHit[] = [];

  const prev = snapshotConfig(["proxyMode", "upstreamProtocol", "upstreamHost", "upstreamPort", "upstreamTimeout", "upstreamUsername", "upstreamPassword", "upstreamCa", "upstreamInsecure", "logLevel", "logFile"]);

  beforeAll(async () => {
    proxyPort = await getFreePort();
    originPort = await getFreePort();
    socksPort = await getFreePort();
    socksOverTlsPort = await getFreePort();

    silenceLogs();
    set("host", "127.0.0.1");
    set("port", proxyPort);
    set("proxyMode", "client");
    set("upstreamHost", "127.0.0.1");
    set("upstreamUsername", "");
    set("upstreamPassword", "");

    // 真实 http 源站：记录方法/URL/请求体/传输编码
    origin = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body,
          transferEncoding: req.headers["transfer-encoding"] as string | undefined,
        });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`origin-ok:${req.method}:${req.url}:${body}`);
      });
    });
    await listen(origin, originPort);

    // 明文 SOCKS5 上游
    socksUpstream = net.createServer((sock) => attachSocks5(sock));
    await listen(socksUpstream, socksPort);

    // SOCKS over TLS 上游：同一握手逻辑承载于 tls.Server
    socksOverTlsUpstream = tls.createServer(TEST_TLS_CERTS, (sock) => attachSocks5(sock));
    await listen(socksOverTlsUpstream, socksOverTlsPort);

    proxy = new HttpProxy({
      ctx: testContext,
      host: "127.0.0.1",
      port: proxyPort,
      auth: new Auth({ enabled: false }),
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy?.stop().catch(() => undefined);
    await closeServer(origin);
    await closeServer(socksUpstream);
    await closeServer(socksOverTlsUpstream);

    restoreConfig(prev);
  });

  it("A: socks5 上游 → 真实源站 200 与 body", async () => {
    set("upstreamProtocol", "socks5");
    set("upstreamPort", socksPort);

    const { status, body } = await proxyRequest(proxyPort, {
      method: "GET",
      url: `http://127.0.0.1:${originPort}/a?x=1`,
    });

    expect(status).toBe(200);
    expect(body).toBe("origin-ok:GET:/a?x=1:");
    expect(hits.at(-1)?.url).toBe("/a?x=1");
  });

  it("B: chunked 请求体经 socks5 上游完整到达源站且解析正常", async () => {
    set("upstreamProtocol", "socks5");
    set("upstreamPort", socksPort);

    const parts = ["hello-", "chunked-", "body"];
    const { status, body } = await proxyRequest(proxyPort, {
      method: "POST",
      url: `http://127.0.0.1:${originPort}/chunked`,
      body: parts,
    });

    expect(status).toBe(200);
    expect(body).toBe(`origin-ok:POST:/chunked:${parts.join("")}`);

    const hit = hits.at(-1);
    expect(hit?.url).toBe("/chunked");
    // 源站解析出的请求体完整且仍为合法 chunked（代理侧已正确重新分帧）
    expect(hit?.body).toBe(parts.join(""));
    expect(hit?.transferEncoding).toBe("chunked");
  });

  it("C: sockss5（SOCKS over TLS）上游承载同一握手并转发成功", async () => {
    set("upstreamProtocol", "sockss5");
    set("upstreamPort", socksOverTlsPort);
    set("upstreamCa", TEST_CA_PATH);
    set("upstreamInsecure", false);

    const { status, body } = await proxyRequest(proxyPort, {
      method: "GET",
      url: `http://127.0.0.1:${originPort}/via-sockss5`,
    });

    expect(status).toBe(200);
    expect(body).toBe("origin-ok:GET:/via-sockss5:");
  });

  it("D: TLS 上游握手卡死时拨号超时回 504（不再无限挂起）", async () => {
    const silentPort = await getFreePort();
    const frontPort = await getFreePort();

    // 只 accept、不说话的上游：TLS 握手永不完成
    const silentConns: net.Socket[] = [];
    const silent = net.createServer((s) => {
      s.on("error", () => {});
      silentConns.push(s);
    });
    await listen(silent, silentPort);

    set("proxyMode", "client");
    set("upstreamProtocol", "https");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", silentPort);
    set("upstreamTimeout", 500);

    // 本地“接入”服务器：每条连接交给**复用**的真实 TunnelForwarder 实例（模拟 CONNECT 委派）
    const tunnelFwd = new TunnelForwarder(testContext, INERT_TRAFFIC());
    const frontConns: net.Socket[] = [];
    const front = net.createServer((clientSock) => {
      clientSock.on("error", () => {});
      frontConns.push(clientSock);
      const fakeReq = {
        url: "example.com:80",
        headers: {},
        method: "CONNECT",
      } as unknown as http.IncomingMessage;
      tunnelFwd.handleConnect(fakeReq, clientSock, Buffer.alloc(0), requestScope());
    });
    await listen(front, frontPort);

    try {
      const firstLine = await new Promise<string>((resolve, reject) => {
        const c = net.connect(frontPort, "127.0.0.1");
        let buf = "";
        const timer = setTimeout(() => {
          c.destroy();
          reject(new Error("2s 内未回写 504（疑似拨号超时被提前清除/永不 settle）"));
        }, 2000);

        c.on("data", (d) => {
          buf += d.toString();
          if (buf.includes("\r\n")) {
            clearTimeout(timer);
            c.destroy();
            resolve(buf.split("\r\n")[0] ?? "");
          }
        });
        c.on("close", () => {
          clearTimeout(timer);
          reject(new Error(`连接提前关闭，未见完整 504 响应：${JSON.stringify(buf)}`));
        });
        c.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });

      expect(firstLine).toContain("504");
    } finally {
      // net.Server 无 closeAllConnections：显式销毁残留 socket，避免 close() 等半开连接不回调
      for (const s of frontConns) s.destroy();
      for (const s of silentConns) s.destroy();
      await closeServer(front);
      await closeServer(silent);
    }
  });
});
