import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { get, set, defaults } from "@/config/store.js";
import { HttpProxy } from "@/core/server/http.js";
import { Auth } from "@/core/auth.js";

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function httpGetViaProxy(proxyPort: number, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: url,
        headers: { Host: "example.com", ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 上游代理（https 或 http 形态）：回显 absolute-form url，验证转发语义 */
function makeUpstream(tls: { key: Buffer; cert: Buffer } | null): https.Server | http.Server {
  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`upstream-ok:${req.url}`);
  };
  return tls ? https.createServer(tls, handler) : http.createServer(handler);
}

function listen(server: http.Server | https.Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
}

describe("integration/http-proxy upstream protocol", () => {
  let proxyPort = 0;
  let tlsUpstreamPort = 0;
  let plainUpstreamPort = 0;
  let tlsUpstream: https.Server | null = null;
  let plainUpstream: http.Server | null = null;
  let proxy: HttpProxy | null = null;
  const prev = {
    proxyMode: get("proxyMode"),
    upstreamProtocol: get("upstreamProtocol"),
    upstreamHost: get("upstreamHost"),
    upstreamPort: get("upstreamPort"),
    upstreamCa: get("upstreamCa"),
    upstreamInsecure: get("upstreamInsecure"),
    logLevel: get("logLevel"),
    logFile: get("logFile"),
  };

  beforeAll(async () => {
    proxyPort = await getFreePort();
    tlsUpstreamPort = await getFreePort();
    plainUpstreamPort = await getFreePort();
    set("logLevel", "silent");
    set("logFile", "");
    set("host", "127.0.0.1");
    set("port", proxyPort);
    set("proxyMode", "client");
    set("upstreamHost", "127.0.0.1");
    set("upstreamUsername", "");
    set("upstreamPassword", "");

    tlsUpstream = makeUpstream({
      key: fs.readFileSync("keys/server.key"),
      cert: fs.readFileSync("keys/server.crt"),
    }) as https.Server;
    await listen(tlsUpstream, tlsUpstreamPort);
    plainUpstream = makeUpstream(null) as http.Server;
    await listen(plainUpstream, plainUpstreamPort);

    proxy = new HttpProxy({ host: "127.0.0.1", port: proxyPort, auth: new Auth({ enabled: false }) });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy?.stop().catch(() => undefined);
    await new Promise<void>((resolve) => tlsUpstream?.close(() => resolve()));
    await new Promise<void>((resolve) => plainUpstream?.close(() => resolve()));
    set("proxyMode", prev.proxyMode);
    set("upstreamProtocol", prev.upstreamProtocol as typeof defaults.upstreamProtocol);
    set("upstreamHost", prev.upstreamHost);
    set("upstreamPort", prev.upstreamPort);
    set("upstreamCa", prev.upstreamCa);
    set("upstreamInsecure", prev.upstreamInsecure);
    set("logLevel", prev.logLevel);
    set("logFile", prev.logFile as typeof defaults.logFile);
  });

  it("upstream=https：TLS 建链 + CA 校验通过转发到 https 上游代理", async () => {
    set("upstreamProtocol", "https");
    set("upstreamPort", tlsUpstreamPort);
    set("upstreamCa", "keys/ca.crt");
    set("upstreamInsecure", false);
    const { status, body } = await httpGetViaProxy(proxyPort, "http://example.com/hello");
    expect(status).toBe(200);
    expect(body).toBe("upstream-ok:http://example.com/hello");
  });

  it("upstream=http：明文上游不回归", async () => {
    set("upstreamProtocol", "http");
    set("upstreamPort", plainUpstreamPort);
    const { status, body } = await httpGetViaProxy(proxyPort, "http://example.com/plain");
    expect(status).toBe(200);
    expect(body).toBe("upstream-ok:http://example.com/plain");
  });

  it("upstream=socks5：经 SOCKS 隧道转发到真实目标", async () => {
    // 最小 SOCKS5 上游桩：无鉴权握手 → CONNECT 域名 → 直连目标透传
    const socksUpstream = net.createServer((client) => {
      client.once("data", () => {
        client.write(Buffer.from([0x05, 0x00]));
        client.once("data", (req: Buffer) => {
          const len = req[4];
          const host = req.subarray(5, 5 + len).toString();
          const port = req.readUInt16BE(5 + len);
          const target = net.connect(port, host, () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            client.pipe(target);
            target.pipe(client);
          });
          target.on("error", () => client.destroy());
        });
      });
      client.on("error", () => undefined);
    });
    const socksPort = await getFreePort();
    await new Promise<void>((resolve) => socksUpstream.listen(socksPort, "127.0.0.1", () => resolve()));
    try {
      set("upstreamProtocol", "socks5");
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", socksPort);
      // 真实目标：明文上游 serve 的 example.com 映射到本机 plainUpstream
      const { status } = await httpGetViaProxy(proxyPort, `http://127.0.0.1:${plainUpstreamPort}/via-socks`);
      expect(status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => socksUpstream.close(() => resolve()));
    }
  });
});
