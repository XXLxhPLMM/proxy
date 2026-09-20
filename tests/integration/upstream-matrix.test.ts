import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { Auth } from "@/core/auth.js";
import { HttpProxy } from "@/core/server/http.js";
import { HttpsProxy } from "@/core/server/https.js";
import { Socks4Proxy } from "@/core/server/socks4.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import { get, set, defaults } from "@/config/store.js";
import type { ProxyCore } from "@/core/types/proxy.js";

/**
 * 串联矩阵：入站协议 × 上游协议 × 证书有无
 *
 * 覆盖目标（全本地桩，不依赖外网）：
 * - 上游 6 种协议：http / https / socks4 / socks5 / sockss4 / sockss5
 * - 证书四态：配 CA（通过）/ 无 CA（自签上游必须失败）/ CA 文件缺失（回退系统库→失败）/ insecure（跳过校验）
 * - 入站 4 种：http / https / socks4 / socks5（sockss 入站不在矩阵内）
 * - 三类转发路径：absolute-form（http 入站）、CONNECT 隧道（隧道/upgrade 路径）、SOCKS 隧道（socks 入站）
 */

const KEY = () => fs.readFileSync("keys/server.key");
const CRT = () => fs.readFileSync("keys/server.crt");
const CA = "keys/ca.crt";

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve) => {
    (server as http.Server).listen(port, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: net.Server | null): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      return resolve();
    }

    (server as http.Server).closeAllConnections?.();
    server.close(() => resolve());
    setTimeout(() => resolve(), 500).unref?.();
  });
}

/** 目标源站：回显 origin-ok:<path> */
function makeOrigin(): http.Server {
  return http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`origin-ok:${req.url}`);
  });
}

/**
 * HTTP(S) 上游代理桩：常规请求回 upstream-ok:<absolute-form>，CONNECT 则真隧道到目标
 * 两种形态共用，用来验证 client 串联保留 absolute-form 与 CONNECT 转发的行为
 */
function makeHttpUpstreamStub(secure: boolean): net.Server {
  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`upstream-ok:${req.url}`);
  };
  const server = secure
    ? https.createServer({ key: KEY(), cert: CRT() }, handler)
    : http.createServer(handler);

  server.on("connect", (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    const [host, portStr] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(portStr), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      if (head.length) {
        upstream.write(head);
      }

      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });

  return server;
}

/**
 * SOCKS 上游代理桩（v4 / v5 × 明文 / TLS）：无鉴权握手 → CONNECT → 真隧道到目标
 * 目标为 IP 形态（测试目标是 127.0.0.1），v4 走原生 IP 分支
 */
function makeSocksUpstreamStub(version: 4 | 5, secure: boolean): net.Server {
  const handle = (client: Duplex): void => {
    client.on("error", () => undefined);

    if (version === 4) {
      let buf = Buffer.alloc(0);

      const pump = (): void => {
        // [0x04,0x01,port(2),ip(4),USERID\0]
        if (buf.length < 9) {
          return;
        }

        const port = buf.readUInt16BE(2);
        const host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
        const rest = buf.subarray(8);
        const zero = rest.indexOf(0);

        if (zero === -1) {
          return;
        }

        client.removeAllListeners("data");
        const target = net.connect(port, host, () => {
          client.write(Buffer.from([0x00, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
          const leftover = rest.subarray(zero + 1);

          if (leftover.length) {
            target.write(leftover);
          }

          client.pipe(target);
          target.pipe(client);
        });
        target.on("error", () => client.destroy());
      };

      client.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        pump();
      });
      return;
    }

    let stage = 0;
    let buf = Buffer.alloc(0);

    const pump = (): void => {
      // 问候包 [VER, NMETHODS, ...METHODS]：必须按 NMETHODS 整体消费，
      // 少消费一个字节会把后续 CONNECT 请求的字段整体错位（ATYP 读到残留的 0x00）
      if (stage === 0 && buf.length >= 2) {
        const need = 2 + buf[1];
        if (buf.length < need) {
          return;
        }

        buf = buf.subarray(need);
        client.write(Buffer.from([0x05, 0x00]));
        stage = 1;
      }

      if (stage === 1 && buf.length >= 5) {
        const atyp = buf[3];
        const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : buf[4];
        const need = atyp === 3 ? 5 + addrLen : 4 + addrLen;
        // 目标端口 2 字节：ATYP=1/4 时紧跟地址；ATYP=3 时地址从 buf[5] 起
        if (buf.length < need + 2) {
          return;
        }

        const port = buf.readUInt16BE(need);
        const host =
          atyp === 1
            ? `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
            : buf.subarray(5, 5 + addrLen).toString();
        const leftover = buf.subarray(need + 2);

        stage = 2;
        client.removeAllListeners("data");
        const target = net.connect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));

          if (leftover.length) {
            target.write(leftover);
          }

          client.pipe(target);
          target.pipe(client);
        });
        target.on("error", () => client.destroy());
      }
    };

    client.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      pump();
    });
  };

  return secure ? tls.createServer({ key: KEY(), cert: CRT() }, handle) : net.createServer(handle);
}

/** 读满一个 HTTP 响应（读到 Connection: close 结束） */
function readUntilClose(sock: Duplex, ms = 8000): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), ms);
    sock.on("data", (c: Buffer) => (data += c.toString()));
    sock.on("close", () => {
      clearTimeout(timer);
      resolve(data);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/** http/https 入站：absolute-form GET */
function httpViaProxy(
  proxyPort: number,
  url: string,
  tlsProxy = false,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const mod = tlsProxy ? https : http;
    const req = mod.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: url,
        headers: { Host: "example.com", Connection: "close" },
        timeout: 8000,
        ...(tlsProxy ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", (e: Error) => resolve({ status: 0, body: `ERR:${e.message}` }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "ERR:timeout" });
    });
    req.end();
  });
}

/** http/https 入站：CONNECT 隧道内发一个 origin-form 请求 */
function tunnelViaProxy(
  proxyPort: number,
  authority: string,
  requestPath: string,
  tlsProxy = false,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const mod = tlsProxy ? https : http;
    const req = mod.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: authority,
      headers: { Host: authority },
      timeout: 8000,
      ...(tlsProxy ? { rejectUnauthorized: false } : {}),
    });
    req.on("connect", (res, socket: Duplex) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return resolve({ status: res.statusCode ?? 0, body: "CONNECT 非 200" });
      }

      socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
      void readUntilClose(socket).then((body) => resolve({ status: 200, body }));
    });
    req.on("error", (e: Error) => resolve({ status: 0, body: `ERR:${e.message}` }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "ERR:timeout" });
    });
    req.end();
  });
}

/** socks 入站：裸握手 → 回 { ok, rep, socket } */
function socksConnect(
  proxyPort: number,
  version: 4 | 5,
  host: string,
  port: number,
): Promise<{ ok: boolean; rep: number; socket: Duplex | null; raw: Buffer }> {
  return new Promise((resolve) => {
    const sock = net.connect(proxyPort, "127.0.0.1");
    let buf = Buffer.alloc(0);
    let stage = version === 5 ? 0 : 1;

    const fail = (rep: number, raw: Buffer): void => {
      sock.destroy();
      resolve({ ok: false, rep, socket: null, raw });
    };

    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);

      if (stage === 1) {
        if (buf.length < 8) {
          return;
        }

        const ok = buf[0] === 0x00 && buf[1] === 0x5a;
        sock.removeListener("data", onData);
        return ok
          ? resolve({ ok: true, rep: 0x5a, socket: sock, raw: buf })
          : fail(buf[1], buf);
      }

      if (stage === 0) {
        if (buf.length < 2) {
          return;
        }

        buf = buf.subarray(2);
        const ip = host.split(".").map(Number);
        const isIp = ip.length === 4 && ip.every((n) => Number.isInteger(n));

        sock.write(
          isIp
            ? Buffer.from([0x05, 0x01, 0x00, 0x01, ...ip, (port >> 8) & 0xff, port & 0xff])
            : Buffer.concat([
                Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
                Buffer.from(host),
                Buffer.from([(port >> 8) & 0xff, port & 0xff]),
              ]),
        );
        stage = 2;
        return;
      }

      if (stage === 2) {
        if (buf.length < 4) {
          return;
        }

        const rep = buf[1];
        const atyp = buf[3];
        const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : buf[4];
        const need = (atyp === 3 ? 5 + addrLen : 4 + addrLen) + 2;

        if (buf.length < need) {
          return;
        }

        sock.removeListener("data", onData);
        return rep === 0x00
          ? resolve({ ok: true, rep, socket: sock, raw: buf })
          : fail(rep, buf);
      }
    };

    sock.on("data", onData);
    sock.on("error", () => fail(-1, buf));

    if (version === 5) {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    } else {
      sock.write(
        Buffer.from([0x04, 0x01, (port >> 8) & 0xff, port & 0xff, 127, 0, 0, 1, 0x00]),
      );
    }

    setTimeout(() => {
      if (!sock.destroyed) {
        fail(-2, buf);
      }
    }, 10000).unref?.();
  });
}

/** socks 入站 + 隧道内 HTTP 请求 */
async function httpViaSocksProxy(
  proxyPort: number,
  version: 4 | 5,
  targetHost: string,
  targetPort: number,
  requestPath: string,
): Promise<{ status: number; body: string; rep: number }> {
  const res = await socksConnect(proxyPort, version, targetHost, targetPort);

  if (!res.ok || !res.socket) {
    return { status: 0, body: "", rep: res.rep };
  }

  res.socket.write(
    `GET ${requestPath} HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`,
  );
  const body = await readUntilClose(res.socket);
  return { status: 200, body, rep: 0 };
}

describe("integration/upstream matrix（入站 × 上游 × 证书）", () => {
  const stubs: net.Server[] = [];
  const proxies: ProxyCore[] = [];
  let originPort = 0;
  let httpUpPort = 0;
  let httpsUpPort = 0;
  let socks4UpPort = 0;
  let socks5UpPort = 0;
  let sockss4UpPort = 0;
  let sockss5UpPort = 0;
  let httpInPort = 0;
  let httpsInPort = 0;
  let s4InPort = 0;
  let s5InPort = 0;

  const prev = {
    host: get("host"),
    port: get("port"),
    logLevel: get("logLevel"),
    logFile: get("logFile"),
    proxyMode: get("proxyMode"),
    upstreamProtocol: get("upstreamProtocol"),
    upstreamHost: get("upstreamHost"),
    upstreamPort: get("upstreamPort"),
    upstreamCa: get("upstreamCa"),
    upstreamInsecure: get("upstreamInsecure"),
    upstreamUsername: get("upstreamUsername"),
    upstreamTimeout: get("upstreamTimeout"),
  };

  const applyUpstream = (
    protocol: (typeof defaults)["upstreamProtocol"],
    port: number,
    ca = "",
    insecure = false,
  ): void => {
    set("proxyMode", "client");
    set("upstreamProtocol", protocol);
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", port);
    set("upstreamCa", ca);
    set("upstreamInsecure", insecure);
  };

  beforeAll(async () => {
    set("logLevel", "silent");
    set("logFile", "");
    set("upstreamTimeout", 6000);
    set("upstreamUsername", "");

    [
      originPort,
      httpUpPort,
      httpsUpPort,
      socks4UpPort,
      socks5UpPort,
      sockss4UpPort,
      sockss5UpPort,
      httpInPort,
      httpsInPort,
      s4InPort,
      s5InPort,
    ] = await Promise.all(Array.from({ length: 11 }, () => getFreePort()));

    const origin = makeOrigin();
    const httpUp = makeHttpUpstreamStub(false);
    const httpsUp = makeHttpUpstreamStub(true);
    const socks4Up = makeSocksUpstreamStub(4, false);
    const socks5Up = makeSocksUpstreamStub(5, false);
    const sockss4Up = makeSocksUpstreamStub(4, true);
    const sockss5Up = makeSocksUpstreamStub(5, true);

    for (const s of [origin, httpUp, httpsUp, socks4Up, socks5Up, sockss4Up, sockss5Up]) {
      stubs.push(s);
    }

    await Promise.all([
      listen(origin, originPort),
      listen(httpUp, httpUpPort),
      listen(httpsUp, httpsUpPort),
      listen(socks4Up, socks4UpPort),
      listen(socks5Up, socks5UpPort),
      listen(sockss4Up, sockss4UpPort),
      listen(sockss5Up, sockss5UpPort),
    ]);

    const auth = new Auth({ enabled: false });
    const httpIn = new HttpProxy({ host: "127.0.0.1", port: httpInPort, auth });
    const httpsIn = new HttpsProxy({
      host: "127.0.0.1",
      port: httpsInPort,
      auth,
      tls: { key: "keys/server.key", cert: "keys/server.crt" },
    });
    const s4In = new Socks4Proxy({ host: "127.0.0.1", port: s4InPort, auth });
    const s5In = new Socks5Proxy({ host: "127.0.0.1", port: s5InPort, auth });

    for (const p of [httpIn, httpsIn, s4In, s5In]) {
      proxies.push(p);
    }

    await Promise.all([httpIn.start(), httpsIn.start(), s4In.start(), s5In.start()]);
    set("host", "127.0.0.1");
    set("port", httpInPort);
  });

  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.stop().catch(() => undefined)));
    await Promise.all(stubs.map((s) => closeServer(s)));
    set("host", prev.host);
    set("port", prev.port);
    set("logLevel", prev.logLevel);
    set("logFile", prev.logFile as typeof defaults.logFile);
    set("proxyMode", prev.proxyMode);
    set("upstreamProtocol", prev.upstreamProtocol as typeof defaults.upstreamProtocol);
    set("upstreamHost", prev.upstreamHost);
    set("upstreamPort", prev.upstreamPort);
    set("upstreamCa", prev.upstreamCa);
    set("upstreamInsecure", prev.upstreamInsecure);
    set("upstreamUsername", prev.upstreamUsername);
    set("upstreamTimeout", prev.upstreamTimeout);
  });

  describe("A) http 入站（absolute-form 串联）", () => {
    it.each([
      ["http", "http", () => httpUpPort, "", false, "upstream"],
      ["https+CA", "https", () => httpsUpPort, CA, false, "upstream"],
      ["https+insecure", "https", () => httpsUpPort, "", true, "upstream"],
      ["socks4", "socks4", () => socks4UpPort, "", false, "origin"],
      ["socks5", "socks5", () => socks5UpPort, "", false, "origin"],
      ["sockss4+CA", "sockss4", () => sockss4UpPort, CA, false, "origin"],
      ["sockss5+CA", "sockss5", () => sockss5UpPort, CA, false, "origin"],
    ] as const)(
      "上游 %s 命中目标（200）",
      async (_name, protocol, portFn, ca, insecure, expectKind) => {
        applyUpstream(protocol, portFn(), ca, insecure);
        // http/https 上游按 absolute-form 交给上游代理；socks 上游直达真实目标，须用可达的本地源站
        const local = expectKind === "origin";
        const url = local ? `http://127.0.0.1:${originPort}/chain` : "http://example.com/chain";
        const { status, body } = await httpViaProxy(httpInPort, url);
        expect(status, body).toBe(200);

        if (local) {
          expect(body).toContain("origin-ok:/chain");
        } else {
          // client 串联必须保留 absolute-form 交给上游代理
          expect(body).toBe(`upstream-ok:${url}`);
        }
      },
      20000,
    );

    it.each([
      ["https 无 CA（自签上游必须拒绝）", "https", () => httpsUpPort, "", false, "example.com"],
      [
        "https CA 文件缺失（回退系统库 → 自签被拒）",
        "https",
        () => httpsUpPort,
        "keys/nope.crt",
        false,
        "example.com",
      ],
      ["sockss5 无 CA（自签上游必须拒绝）", "sockss5", () => sockss5UpPort, "", false, "local"],
    ] as const)("上游 %s → 502", async (_n, protocol, portFn, ca, insecure, target) => {
      applyUpstream(protocol, portFn(), ca, insecure);
      const url =
        target === "local" ? `http://127.0.0.1:${originPort}/denied` : "http://example.com/denied";
      const { status, body } = await httpViaProxy(httpInPort, url);
      expect(status, body).toBe(502);
    }, 20000);
  });

  describe("B) CONNECT 隧道（隧道转发路径）", () => {
    it.each([
      ["http", "http", () => httpUpPort, "", false],
      ["https+CA", "https", () => httpsUpPort, CA, false],
      ["socks4", "socks4", () => socks4UpPort, "", false],
      ["socks5", "socks5", () => socks5UpPort, "", false],
      ["sockss5+CA", "sockss5", () => sockss5UpPort, CA, false],
    ] as const)("上游 %s 隧道到源站（200）", async (_n, protocol, portFn, ca, insecure) => {
      applyUpstream(protocol, portFn(), ca, insecure);
      const { status, body } = await tunnelViaProxy(
        httpInPort,
        `127.0.0.1:${originPort}`,
        "/tunnel",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/tunnel");
    }, 20000);

    it("上游 https 无 CA：CONNECT 必须失败（502 而非挂死）", async () => {
      applyUpstream("https", httpsUpPort, "", false);
      const { status, body } = await tunnelViaProxy(
        httpInPort,
        `127.0.0.1:${originPort}`,
        "/tunnel",
      );
      expect(status, body).toBe(502);
    }, 20000);

    it("上游 sockss5 无 CA：CONNECT 必须回 502（守卫不得连带销毁客户端）", async () => {
      applyUpstream("sockss5", sockss5UpPort, "", false);
      const { status, body } = await tunnelViaProxy(
        httpInPort,
        `127.0.0.1:${originPort}`,
        "/tunnel",
      );
      expect(status, body).toBe(502);
    }, 20000);
  });

  describe("C) https 入站（TLS 下游 × 各上游）", () => {
    it.each([
      ["https+CA", "https", () => httpsUpPort, CA, false, "upstream"],
      ["socks5", "socks5", () => socks5UpPort, "", false, "origin"],
      ["sockss5+CA", "sockss5", () => sockss5UpPort, CA, false, "origin"],
      ["http", "http", () => httpUpPort, "", false, "upstream"],
    ] as const)("上游 %s 命中目标（200）", async (_n, protocol, portFn, ca, insecure, kind) => {
      applyUpstream(protocol, portFn(), ca, insecure);
      const local = kind === "origin";
      const url = local ? `http://127.0.0.1:${originPort}/tls-in` : "http://example.com/tls-in";
      const { status, body } = await httpViaProxy(httpsInPort, url, true);
      expect(status, body).toBe(200);

      if (local) {
        expect(body).toContain("origin-ok:/tls-in");
      } else {
        expect(body).toBe(`upstream-ok:${url}`);
      }
    }, 20000);
  });

  describe("D) socks5 入站（SOCKS 隧道 × 各上游）", () => {
    it.each([
      ["http", "http", () => httpUpPort, "", false, 200],
      ["https+CA", "https", () => httpsUpPort, CA, false, 200],
      ["socks4", "socks4", () => socks4UpPort, "", false, 200],
      ["socks5", "socks5", () => socks5UpPort, "", false, 200],
      ["sockss4+CA", "sockss4", () => sockss4UpPort, CA, false, 200],
      ["sockss5+CA", "sockss5", () => sockss5UpPort, CA, false, 200],
    ] as const)("上游 %s → socks5 入站 200", async (_n, protocol, portFn, ca, insecure, want) => {
      applyUpstream(protocol, portFn(), ca, insecure);
      const { status, body } = await httpViaSocksProxy(
        s5InPort,
        5,
        "127.0.0.1",
        originPort,
        "/s5-in",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/s5-in");
      expect(want).toBe(200);
    }, 20000);

    it.each([
      ["https 无 CA", "https", () => httpsUpPort],
      ["sockss5 无 CA", "sockss5", () => sockss5UpPort],
    ] as const)("上游 %s：socks5 入站必须回失败应答（不挂死）", async (_n, protocol, portFn) => {
      applyUpstream(protocol, portFn(), "", false);
      const res = await socksConnect(s5InPort, 5, "127.0.0.1", originPort);
      expect(res.ok).toBe(false);
      expect(res.rep).toBeGreaterThan(0);
    }, 20000);
  });

  describe("E) socks4 入站", () => {
    it.each([
      ["http", "http", () => httpUpPort, "", false],
      ["socks4", "socks4", () => socks4UpPort, "", false],
      ["sockss4+CA", "sockss4", () => sockss4UpPort, CA, false],
      ["https+CA", "https", () => httpsUpPort, CA, false],
    ] as const)("上游 %s → socks4 入站 200", async (_n, protocol, portFn, ca, insecure) => {
      applyUpstream(protocol, portFn(), ca, insecure);
      const { status, body } = await httpViaSocksProxy(
        s4InPort,
        4,
        "127.0.0.1",
        originPort,
        "/s4-in",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/s4-in");
    }, 20000);

    it("上游 https 无 CA：socks4 入站必须回失败应答", async () => {
      applyUpstream("https", httpsUpPort, "", false);
      const res = await socksConnect(s4InPort, 4, "127.0.0.1", originPort);
      expect(res.ok).toBe(false);
      expect(res.rep).not.toBe(0x5a);
    }, 20000);
  });
});
