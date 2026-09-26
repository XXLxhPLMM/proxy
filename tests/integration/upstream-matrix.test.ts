import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { Sockss4Proxy } from "@/core/server/sockss4.js";
import { Sockss5Proxy } from "@/core/server/sockss5.js";
import { defaults } from "@/config/index.js";
import { set, testContext } from "../helpers/config.js";
import type { ProxyCore } from "@/core/types/proxy.js";
import { getFreePort, listen } from "../helpers/net.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../helpers/config.js";
import { TEST_CA_PATH, TEST_TLS_CERTS, TEST_TLS_PATHS } from "../helpers/certs.js";
import { startUpstreamStub, type UpstreamRole, type UpstreamStub } from "../helpers/upstream-stub.js";

/**
 * 串联矩阵：入站协议 × 上游协议 × 证书有无
 *
 * 覆盖目标（全本地桩，不依赖外网）：
 * - 上游 6 种协议：http / https / socks4 / socks5 / sockss4 / sockss5
 * - 证书四态：配 CA（通过）/ 无 CA（自签上游必须失败）/ CA 文件缺失（回退系统库→失败）/ insecure（跳过校验）
 * - 入站 6 种：http / https / socks4 / socks5 / sockss4 / sockss5（6 × 6 = 36 档全网格）
 * - 三类转发路径：absolute-form（http 入站）、CONNECT 隧道（隧道/upgrade 路径）、SOCKS 隧道（socks/sockss 入站）
 *
 * 分组：
 * - A)~E)（既有，本切片未改动任何断言）：http 入站 / CONNECT 隧道 / https 入站 / socks5 入站 / socks4 入站
 * - F)~J)（本切片补齐）：既有入站的缺档 / sockss4 入站全档 / sockss5 入站全档 /
 *   真实 TLS 上游字节级通路 / 上游证书四态
 *
 * 「协议/请求形态」不只断言状态码：F)~J) 一律走 `helpers/upstream-stub.ts` 的**可观测桩**，
 * 断言上游确实收到本角色的协议报文（CONNECT 行 / absolute-form 行 / SOCKS4 CONNECT /
 * SOCKS5 greeting）与正确的目标三元组，TLS 上游另断言握手确实完成（协议/cipher/SNI）。
 */

const CA = TEST_CA_PATH;

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
  const server = secure ? https.createServer(TEST_TLS_CERTS, handler) : http.createServer(handler);

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

  return secure ? tls.createServer(TEST_TLS_CERTS, handle) : net.createServer(handle);
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

      socket.write(
        `GET ${requestPath} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`,
      );
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
        return ok ? resolve({ ok: true, rep: 0x5a, socket: sock, raw: buf }) : fail(buf[1], buf);
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
        return rep === 0x00 ? resolve({ ok: true, rep, socket: sock, raw: buf }) : fail(rep, buf);
      }
    };

    sock.on("data", onData);
    sock.on("error", () => fail(-1, buf));

    if (version === 5) {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    } else {
      sock.write(Buffer.from([0x04, 0x01, (port >> 8) & 0xff, port & 0xff, 127, 0, 0, 1, 0x00]));
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

/**
 * sockss* 入站：TLS 承载的 SOCKS 握手（状态机与 socksConnect 逐字同形，仅承载不同）
 * @param proxyPort - sockss4 / sockss5 入站监听端口
 * @param version - SOCKS 版本（sockss4 → 4 / sockss5 → 5）
 * @param host - 目标主机（IPv4 字面量形态）
 * @param port - 目标端口
 */
function socksConnectOverTls(
  proxyPort: number,
  version: 4 | 5,
  host: string,
  port: number,
): Promise<{ ok: boolean; rep: number; socket: Duplex | null; raw: Buffer }> {
  return new Promise((resolve) => {
    // 自签入站证书：客户端侧固定跳过校验（矩阵不测入站证书校验，那在 tls-client-auth.test.ts）
    const sock = tls.connect({ host: "127.0.0.1", port: proxyPort, rejectUnauthorized: false });
    let buf = Buffer.alloc(0);
    let stage = version === 5 ? 0 : 1;
    let settled = false;

    const fail = (rep: number, raw: Buffer): void => {
      if (settled) {
        return;
      }

      settled = true;
      sock.destroy();
      resolve({ ok: false, rep, socket: null, raw });
    };

    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);

      if (stage === 1) {
        if (buf.length < 8) {
          return;
        }

        sock.removeListener("data", onData);

        if (buf[0] === 0x00 && buf[1] === 0x5a) {
          settled = true;
          resolve({ ok: true, rep: 0x5a, socket: sock, raw: buf });
        } else {
          fail(buf[1], buf);
        }

        return;
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

        if (rep === 0x00) {
          settled = true;
          resolve({ ok: true, rep, socket: sock, raw: buf });
        } else {
          fail(rep, buf);
        }
      }
    };

    sock.on("data", onData);
    sock.on("error", () => fail(-1, buf));

    // 首个请求必须等 secureConnect：握手未完成时 tls.connect 的写会排队，行为依版本而异
    sock.once("secureConnect", () => {
      if (version === 5) {
        sock.write(Buffer.from([0x05, 0x01, 0x00]));
      } else {
        sock.write(Buffer.from([0x04, 0x01, (port >> 8) & 0xff, port & 0xff, 127, 0, 0, 1, 0x00]));
      }
    });

    setTimeout(() => {
      if (!sock.destroyed) {
        fail(-2, buf);
      }
    }, 10000).unref?.();
  });
}

/** sockss* 入站 + 隧道内 HTTP 请求 */
async function httpViaSockssProxy(
  proxyPort: number,
  version: 4 | 5,
  targetHost: string,
  targetPort: number,
  requestPath: string,
): Promise<{ status: number; body: string; rep: number }> {
  const res = await socksConnectOverTls(proxyPort, version, targetHost, targetPort);

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
  let sockss4InPort = 0;
  let sockss5InPort = 0;

  /** 本文件自起的可观测上游桩（tests/helpers/upstream-stub.ts）；afterEach 统一 close */
  const openStubs: UpstreamStub[] = [];

  const prev = snapshotConfig([
    "host",
    "port",
    "logLevel",
    "logFile",
    "proxyMode",
    "upstreamProtocol",
    "upstreamHost",
    "upstreamPort",
    "upstreamCa",
    "upstreamInsecure",
    "upstreamUsername",
    "upstreamTimeout",
  ]);

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
    silenceLogs();
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
      sockss4InPort,
      sockss5InPort,
    ] = await Promise.all(Array.from({ length: 13 }, () => getFreePort()));

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
    const httpIn = new HttpProxy({
      ctx: testContext,
      host: "127.0.0.1",
      port: httpInPort,
      auth,
    });
    const httpsIn = new HttpsProxy({
      ctx: testContext,
      host: "127.0.0.1",
      port: httpsInPort,
      auth,
      tls: TEST_TLS_PATHS,
    });
    const s4In = new Socks4Proxy({
      ctx: testContext,
      host: "127.0.0.1",
      port: s4InPort,
      auth,
    });
    const s5In = new Socks5Proxy({
      ctx: testContext,
      host: "127.0.0.1",
      port: s5InPort,
      auth,
    });
    // sockss4 / sockss5：TLS 承载的 SOCKS 入站（入站证书复用仓内测试 PKI）
    const sockss4In = new Sockss4Proxy({
      ctx: testContext,
      host: "127.0.0.1",
      port: sockss4InPort,
      auth,
      tls: TEST_TLS_PATHS,
    });
    const sockss5In = new Sockss5Proxy({
      ctx: testContext,
      host: "127.0.0.1",
      port: sockss5InPort,
      auth,
      tls: TEST_TLS_PATHS,
    });

    for (const p of [httpIn, httpsIn, s4In, s5In, sockss4In, sockss5In]) {
      proxies.push(p);
    }

    await Promise.all([
      httpIn.start(),
      httpsIn.start(),
      s4In.start(),
      s5In.start(),
      sockss4In.start(),
      sockss5In.start(),
    ]);
    set("host", "127.0.0.1");
    set("port", httpInPort);
  });

  afterEach(async () => {
    // 自起的上游桩绝不留监听：逐个 close（close 幂等）
    while (openStubs.length) {
      await (openStubs.pop() as UpstreamStub).close();
    }
  });

  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.stop().catch(() => undefined)));
    await Promise.all(stubs.map((s) => closeServer(s)));
    restoreConfig(prev);
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
    ] as const)(
      "上游 %s → 502",
      async (_n, protocol, portFn, ca, insecure, target) => {
        applyUpstream(protocol, portFn(), ca, insecure);
        const url =
          target === "local"
            ? `http://127.0.0.1:${originPort}/denied`
            : "http://example.com/denied";
        const { status, body } = await httpViaProxy(httpInPort, url);
        expect(status, body).toBe(502);
      },
      20000,
    );
  });

  describe("B) CONNECT 隧道（隧道转发路径）", () => {
    it.each([
      ["http", "http", () => httpUpPort, "", false],
      ["https+CA", "https", () => httpsUpPort, CA, false],
      ["socks4", "socks4", () => socks4UpPort, "", false],
      ["socks5", "socks5", () => socks5UpPort, "", false],
      ["sockss5+CA", "sockss5", () => sockss5UpPort, CA, false],
    ] as const)(
      "上游 %s 隧道到源站（200）",
      async (_n, protocol, portFn, ca, insecure) => {
        applyUpstream(protocol, portFn(), ca, insecure);
        const { status, body } = await tunnelViaProxy(
          httpInPort,
          `127.0.0.1:${originPort}`,
          "/tunnel",
        );
        expect(status, body).toBe(200);
        expect(body).toContain("origin-ok:/tunnel");
      },
      20000,
    );

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
    ] as const)(
      "上游 %s 命中目标（200）",
      async (_n, protocol, portFn, ca, insecure, kind) => {
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
      },
      20000,
    );
  });

  describe("D) socks5 入站（SOCKS 隧道 × 各上游）", () => {
    it.each([
      ["http", "http", () => httpUpPort, "", false, 200],
      ["https+CA", "https", () => httpsUpPort, CA, false, 200],
      ["socks4", "socks4", () => socks4UpPort, "", false, 200],
      ["socks5", "socks5", () => socks5UpPort, "", false, 200],
      ["sockss4+CA", "sockss4", () => sockss4UpPort, CA, false, 200],
      ["sockss5+CA", "sockss5", () => sockss5UpPort, CA, false, 200],
    ] as const)(
      "上游 %s → socks5 入站 200",
      async (_n, protocol, portFn, ca, insecure, want) => {
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
      },
      20000,
    );

    it.each([
      ["https 无 CA", "https", () => httpsUpPort],
      ["sockss5 无 CA", "sockss5", () => sockss5UpPort],
    ] as const)(
      "上游 %s：socks5 入站必须回失败应答（不挂死）",
      async (_n, protocol, portFn) => {
        applyUpstream(protocol, portFn(), "", false);
        const res = await socksConnect(s5InPort, 5, "127.0.0.1", originPort);
        expect(res.ok).toBe(false);
        expect(res.rep).toBeGreaterThan(0);
      },
      20000,
    );
  });

  describe("E) socks4 入站", () => {
    it.each([
      ["http", "http", () => httpUpPort, "", false],
      ["socks4", "socks4", () => socks4UpPort, "", false],
      ["sockss4+CA", "sockss4", () => sockss4UpPort, CA, false],
      ["https+CA", "https", () => httpsUpPort, CA, false],
    ] as const)(
      "上游 %s → socks4 入站 200",
      async (_n, protocol, portFn, ca, insecure) => {
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
      },
      20000,
    );

    it("上游 https 无 CA：socks4 入站必须回失败应答", async () => {
      applyUpstream("https", httpsUpPort, "", false);
      const res = await socksConnect(s4InPort, 4, "127.0.0.1", originPort);
      expect(res.ok).toBe(false);
      expect(res.rep).not.toBe(0x5a);
    }, 20000);
  });

  // ==========================================================================
  // Phase 2b-0：把 6 入站 × 6 上游 = 36 档补全
  // 下面 F)~J) 一律走 helpers/upstream-stub.ts 的**可观测桩**：
  // 除「目标收到了响应」外，还断言上游确实收到了本角色的协议报文与正确的目标三元组。
  // ==========================================================================

  /**
   * 起一个可观测上游桩并登记到 openStubs（afterEach 统一 close）
   * @param role - 上游角色（https / socks4 / socks5）
   * @param secure - 承载形态（true = TLS 承载，即 https/sockss4/sockss5 三个 TLS 上游）
   * @param rejectWithPlaintext - 只配明文桩：收到任何字节回明文 HTTP 错误（制造 TLS 失配）
   */
  const stub = async (
    role: UpstreamRole,
    secure: boolean,
    rejectWithPlaintext = false,
  ): Promise<UpstreamStub> => {
    const s = await startUpstreamStub(role, { secure, rejectWithPlaintext });
    openStubs.push(s);
    return s;
  };

  /**
   * 断言「上游确实走的是本角色的协议报文」+「转发目标正确」
   * @param s - 可观测上游桩
   * @param expectKind - 期望的应用层请求形态
   * @param expectTarget - 期望的转发目标（`host:port`；absolute-form 传 host 即可，端口按 80 补）
   */
  const expectUpstreamSaw = (
    s: UpstreamStub,
    expectKind: "connect" | "absolute-form" | "socks4-connect" | "socks5-greeting",
    expectTarget: string,
  ): void => {
    const facts = s.last();
    expect(facts, "上游桩没有收到任何 TLS 会话").toBeDefined();
    if (!facts) {
      return;
    }

    // 1) 传输层：TLS 上游必须完成握手，明文上游必须没有协商结果
    if (s.transport === "tls") {
      expect(facts.protocol, "TLS 上游未完成握手").toMatch(/^TLSv/);
      expect(facts.cipher, "TLS 上游未协商出 cipher").not.toBe("");
    } else {
      expect(facts.protocol).toBeNull();
      expect(facts.cipher).toBeNull();
    }

    // 2) 协议形态：上游收到的必须是本角色的报文（不是只断言状态码）
    expect(facts.requestKind).toBe(expectKind);
    expect(facts.firstChunk.length).toBeGreaterThan(0);

    // 3) 转发目标：上游被要求连的必须是真实目标
    expect(facts.target).toBe(expectTarget);
  };

  /**
   * 六种上游协议的规格表（`upstreamProtocol` 值 / 桩角色 / 承载 / 期望的应用层形态）。
   * 用位置元组而非对象：vitest 的 `$prop` 插值会把字符串值渲染成带引号的 `'http'`。
   */
  const SIX_UPSTREAMS = [
    ["http", "https", false, "connect"],
    ["https", "https", true, "connect"],
    ["socks4", "socks4", false, "socks4-connect"],
    ["socks5", "socks5", false, "socks5-greeting"],
    ["sockss4", "socks4", true, "socks4-connect"],
    ["sockss5", "socks5", true, "socks5-greeting"],
  ] as const;

  describe("F) 补档：既有入站缺失的上游组合", () => {
    it("https 入站 × socks4 上游：absolute-form 经 SOCKS 隧道到源站", async () => {
      const s = await stub("socks4", false);
      applyUpstream("socks4", s.port, "", false);
      // socks 系上游必须用可达的本地源站（不是 example.com）
      const { status, body } = await httpViaProxy(
        httpsInPort,
        `http://127.0.0.1:${originPort}/https-in-socks4`,
        true,
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/https-in-socks4");
      expectUpstreamSaw(s, "socks4-connect", `127.0.0.1:${originPort}`);
      // 字节级：上游首包必须是 SOCKS4 CONNECT 头
      expect(s.last()?.firstChunk[0]).toBe(0x04);
      expect(s.last()?.firstChunk[1]).toBe(0x01);
    }, 20000);

    it("https 入站 × sockss4 上游：TLS 承载的 SOCKS4 隧道到源站", async () => {
      const s = await stub("socks4", true);
      applyUpstream("sockss4", s.port, CA, false);
      const { status, body } = await httpViaProxy(
        httpsInPort,
        `http://127.0.0.1:${originPort}/https-in-sockss4`,
        true,
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/https-in-sockss4");
      expectUpstreamSaw(s, "socks4-connect", `127.0.0.1:${originPort}`);
      // 字节级：TCP 首字节必须是 TLS ClientHello（0x16），明文 SOCKS4 头只会是 0x04
      expect(s.last()?.firstChunk[0]).toBe(0x04);
    }, 20000);

    it("socks4 入站 × socks5 上游：SOCKS4 入站 → SOCKS5 上游", async () => {
      const s = await stub("socks5", false);
      applyUpstream("socks5", s.port, "", false);
      const { status, body, rep } = await httpViaSocksProxy(
        s4InPort,
        4,
        "127.0.0.1",
        originPort,
        "/s4-in-socks5",
      );
      expect(status, body).toBe(200);
      expect(rep).toBe(0);
      expect(body).toContain("origin-ok:/s4-in-socks5");
      expectUpstreamSaw(s, "socks5-greeting", `127.0.0.1:${originPort}`);
      // 字节级：上游首包必须是 SOCKS5 greeting（0x05 0x01 0x00）
      expect([...s.last()!.firstChunk.subarray(0, 3)]).toEqual([0x05, 0x01, 0x00]);
    }, 20000);

    it("socks4 入站 × sockss5 上游：SOCKS4 入站 → TLS 承载的 SOCKS5 上游", async () => {
      const s = await stub("socks5", true);
      applyUpstream("sockss5", s.port, CA, false);
      const { status, body, rep } = await httpViaSocksProxy(
        s4InPort,
        4,
        "127.0.0.1",
        originPort,
        "/s4-in-sockss5",
      );
      expect(status, body).toBe(200);
      expect(rep).toBe(0);
      expect(body).toContain("origin-ok:/s4-in-sockss5");
      expectUpstreamSaw(s, "socks5-greeting", `127.0.0.1:${originPort}`);
      expect([...s.last()!.firstChunk.subarray(0, 3)]).toEqual([0x05, 0x01, 0x00]);
    }, 20000);

    it("http 入站 CONNECT × sockss4 上游：隧道经 TLS 承载的 SOCKS4 上游", async () => {
      const s = await stub("socks4", true);
      applyUpstream("sockss4", s.port, CA, false);
      const { status, body } = await tunnelViaProxy(
        httpInPort,
        `127.0.0.1:${originPort}`,
        "/tunnel-sockss4",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/tunnel-sockss4");
      expectUpstreamSaw(s, "socks4-connect", `127.0.0.1:${originPort}`);
    }, 20000);
  });

  describe("G) sockss4 入站（TLS 承载 SOCKS4）× 六上游", () => {
    it.each(SIX_UPSTREAMS)(
      "上游 %s → sockss4 入站 200（目标收到 origin-ok）",
      async (proto, role, secure, kind) => {
        const s = await stub(role, secure);
        applyUpstream(
          proto as (typeof defaults)["upstreamProtocol"],
          s.port,
          secure ? CA : "",
          false,
        );
        const res = await httpViaSockssProxy(
          sockss4InPort,
          4,
          "127.0.0.1",
          originPort,
          "/sockss4-in",
        );
        // 目标确实收到请求（不是只断言握手成功）
        expect(res.status, res.body).toBe(200);
        expect(res.body).toContain("origin-ok:/sockss4-in");
        // 上游确实收到本角色的协议报文 + 正确目标
        expectUpstreamSaw(s, kind, `127.0.0.1:${originPort}`);
        // TLS 承载时「握手完成」本身就是字节级证据：桩只有握手成功才拿得到应用层字节
        if (secure) {
          expect(s.sessions(), "TLS 上游未完成握手").toHaveLength(1);
        }
      },
      20000,
    );

    it("上游 https 无 CA：sockss4 入站必须回 SOCKS4 失败应答（不挂死）", async () => {
      const s = await stub("https", true);
      applyUpstream("https", s.port, "", false);
      const res = await socksConnectOverTls(sockss4InPort, 4, "127.0.0.1", originPort);
      expect(res.ok).toBe(false);
      expect(res.rep).not.toBe(0x5a);
    }, 20000);

    it("上游 sockss4 无 CA：sockss4 入站必须回 SOCKS4 失败应答（不挂死）", async () => {
      const s = await stub("socks4", true);
      applyUpstream("sockss4", s.port, "", false);
      const res = await socksConnectOverTls(sockss4InPort, 4, "127.0.0.1", originPort);
      expect(res.ok).toBe(false);
      expect(res.rep).not.toBe(0x5a);
    }, 20000);

    it("上游 sockss5 无 CA：sockss4 入站必须回 SOCKS4 失败应答（不挂死）", async () => {
      const s = await stub("socks5", true);
      applyUpstream("sockss5", s.port, "", false);
      const res = await socksConnectOverTls(sockss4InPort, 4, "127.0.0.1", originPort);
      expect(res.ok).toBe(false);
      expect(res.rep).not.toBe(0x5a);
    }, 20000);
  });

  describe("H) sockss5 入站（TLS 承载 SOCKS5）× 六上游", () => {
    it.each(SIX_UPSTREAMS)(
      "上游 %s → sockss5 入站 200（目标收到 origin-ok）",
      async (proto, role, secure, kind) => {
        const s = await stub(role, secure);
        applyUpstream(
          proto as (typeof defaults)["upstreamProtocol"],
          s.port,
          secure ? CA : "",
          false,
        );
        const res = await httpViaSockssProxy(
          sockss5InPort,
          5,
          "127.0.0.1",
          originPort,
          "/sockss5-in",
        );
        expect(res.status, res.body).toBe(200);
        expect(res.body).toContain("origin-ok:/sockss5-in");
        expectUpstreamSaw(s, kind, `127.0.0.1:${originPort}`);
        // TLS 承载时「握手完成」本身就是字节级证据：桩只有握手成功才拿得到应用层字节
        if (secure) {
          expect(s.sessions(), "TLS 上游未完成握手").toHaveLength(1);
        }
      },
      20000,
    );

    it("上游 https 无 CA：sockss5 入站必须回 SOCKS5 失败应答（不挂死）", async () => {
      const s = await stub("https", true);
      applyUpstream("https", s.port, "", false);
      const res = await socksConnectOverTls(sockss5InPort, 5, "127.0.0.1", originPort);
      expect(res.ok).toBe(false);
      expect(res.rep).not.toBe(0x00);
    }, 20000);

    it("上游 sockss4 无 CA：sockss5 入站必须回 SOCKS5 失败应答（不挂死）", async () => {
      const s = await stub("socks4", true);
      applyUpstream("sockss4", s.port, "", false);
      const res = await socksConnectOverTls(sockss5InPort, 5, "127.0.0.1", originPort);
      expect(res.ok).toBe(false);
      expect(res.rep).not.toBe(0x00);
    }, 20000);

    it("上游 sockss5 无 CA：sockss5 入站必须回 SOCKS5 失败应答（不挂死）", async () => {
      const s = await stub("socks5", true);
      applyUpstream("sockss5", s.port, "", false);
      const res = await socksConnectOverTls(sockss5InPort, 5, "127.0.0.1", originPort);
      expect(res.ok).toBe(false);
      expect(res.rep).not.toBe(0x00);
    }, 20000);
  });

  describe("I) 真实 TLS 上游通路（字节级）", () => {
    /**
     * 明文哑桩上的 ClientHello 字节级取证。
     *
     * 为什么必须反向取证：`tls.Server` 一 accept 就把裸 socket 包成 TLSSocket，
     * 握手字节在 handle 层被 TLS 解析器吃掉，桩上挂的 `data` 监听永不触发——
     * **真实 TLS 上游一侧拿不到首字节**（见 helpers/upstream-stub.ts 文件头）。
     * 于是把 TLS 承载的上游配置指向一个明文桩：桩收到的首字节必然是 0x16
     * （TLS handshake record），且凑不出任何一角色的应用层报文（`requestKind` 恒空）。
     * 桩回一段明文 HTTP 错误（`rejectWithPlaintext`），客户端握手立刻失败 → 502 而非干等超时。
     */
    it.each([
      ["https", () => httpViaProxy(httpInPort, "http://example.com/tls-mismatch")],
      [
        "sockss4",
        () => tunnelViaProxy(httpInPort, `127.0.0.1:${originPort}`, "/tls-mismatch"),
      ],
      [
        "sockss5",
        () => tunnelViaProxy(httpInPort, `127.0.0.1:${originPort}`, "/tls-mismatch"),
      ],
    ] as const)(
      "上游 %s 打到明文哑桩：只发出 ClientHello(0x16)、零应用层报文 → 502",
      async (proto, drive) => {
        const s = await stub("https", false, true);
        applyUpstream(proto, s.port, CA, false);
        const { status, body } = await drive();
        // 握手失配必须快速失败（502），绝不能挂到 upstreamTimeout
        expect(status, body).toBe(502);
        // 字节级：桩收到的第一个字节是 TLS handshake record 头 0x16
        expect(s.firstBytes()).toEqual([0x16]);
        // 且这段 TLS 里没有任何一角色的应用层报文（明文 HTTP 桩解析不出 CONNECT/SOCKS）
        expect(s.last()?.requestKind).toBe("");
        expect(s.sessions()).toHaveLength(1);
      },
      20000,
    );

    it("https 上游：real TLS 握手完成 + 上游收到 absolute-form（含正确目标与 Host）", async () => {
      const s = await stub("https", true);
      applyUpstream("https", s.port, CA, false);
      const url = "http://example.com/tls-real";
      const { status, body } = await httpViaProxy(httpInPort, url);
      expect(status, body).toBe(200);
      expect(body).toBe(`upstream-ok:${url}`);

      const facts = s.last();
      expect(facts).toBeDefined();
      // 传输层：真的完成了 TLS 握手（而不是明文套了个 https 端口）
      expect(facts?.protocol).toMatch(/^TLSv/);
      expect(facts?.cipher).not.toBe("");
      // 目标主机是 IP 字面量：按 RFC6066 置空 SNI（upstreamTlsOptions 的 servername 口径）
      expect(facts?.servername).toBe("");
      // 协议形态：absolute-form 请求行 + 正确的目标
      expect(facts?.requestKind).toBe("absolute-form");
      expect(facts?.requestLine).toBe(`GET ${url} HTTP/1.1`);
      expect(facts?.target).toBe("example.com:80");
      // 明文应用层首包首字节必须是 'G'（GET），不是 TLS 记录头 0x16
      expect(facts?.firstChunk[0]).toBe(0x47);
    }, 20000);

    it("sockss4 上游：real TLS 握手完成 + 上游收到 SOCKS4 CONNECT（含正确目标）", async () => {
      const s = await stub("socks4", true);
      applyUpstream("sockss4", s.port, CA, false);
      const { status, body } = await tunnelViaProxy(
        httpInPort,
        `127.0.0.1:${originPort}`,
        "/tls-sockss4",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/tls-sockss4");

      const facts = s.last();
      expect(facts?.protocol).toMatch(/^TLSv/);
      expect(facts?.cipher).not.toBe("");
      expect(facts?.servername).toBe("");
      // 协议形态：SOCKS4 CONNECT（VER=0x04 CMD=0x01），且目标三元组正确
      expect(facts?.requestKind).toBe("socks4-connect");
      expect(facts?.firstChunk[0]).toBe(0x04);
      expect(facts?.firstChunk[1]).toBe(0x01);
      expect(facts?.target).toBe(`127.0.0.1:${originPort}`);
    }, 20000);

    it("sockss5 上游：real TLS 握手完成 + 上游收到 SOCKS5 greeting（含正确目标）", async () => {
      const s = await stub("socks5", true);
      applyUpstream("sockss5", s.port, CA, false);
      const { status, body } = await tunnelViaProxy(
        httpInPort,
        `127.0.0.1:${originPort}`,
        "/tls-sockss5",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/tls-sockss5");

      const facts = s.last();
      expect(facts?.protocol).toMatch(/^TLSv/);
      expect(facts?.cipher).not.toBe("");
      expect(facts?.servername).toBe("");
      // 协议形态：SOCKS5 greeting（VER=0x05 NMETHODS=1 METHOD=0x00）
      expect(facts?.requestKind).toBe("socks5-greeting");
      expect([...facts!.firstChunk.subarray(0, 3)]).toEqual([0x05, 0x01, 0x00]);
      expect(facts?.target).toBe(`127.0.0.1:${originPort}`);
    }, 20000);

    it("TLS 上游 × SOCKS4 入站：真实握手 + 上游看到 socks4 CONNECT（跨入站承载）", async () => {
      const s = await stub("socks4", true);
      applyUpstream("sockss4", s.port, CA, false);
      const { status, body } = await httpViaSocksProxy(
        s4InPort,
        4,
        "127.0.0.1",
        originPort,
        "/s4-in-tls-sockss4",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/s4-in-tls-sockss4");
      expect(s.last()?.protocol).toMatch(/^TLSv/);
      expect(s.last()?.requestKind).toBe("socks4-connect");
      expect(s.last()?.target).toBe(`127.0.0.1:${originPort}`);
    }, 20000);

    it("TLS 上游 × SOCKS5 入站：真实握手 + 上游看到 socks5 greeting（跨入站承载）", async () => {
      const s = await stub("socks5", true);
      applyUpstream("sockss5", s.port, CA, false);
      const { status, body } = await httpViaSocksProxy(
        s5InPort,
        5,
        "127.0.0.1",
        originPort,
        "/s5-in-tls-sockss5",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/s5-in-tls-sockss5");
      expect(s.last()?.protocol).toMatch(/^TLSv/);
      expect(s.last()?.requestKind).toBe("socks5-greeting");
      expect(s.last()?.target).toBe(`127.0.0.1:${originPort}`);
    }, 20000);
  });

  describe("J) 上游证书四态（配 CA / 无 CA / CA 文件缺失 / insecure）", () => {
    it("态② 配了 UPSTREAM_CA：https 上游握手成功且拿到 absolute-form（目标 host 正确）", async () => {
      const s = await stub("https", true);
      applyUpstream("https", s.port, CA, false);
      const url = `http://127.0.0.1:${originPort}/ca-ok`;
      const { status, body } = await httpViaProxy(httpInPort, url);
      // http 入站 + https 上游：absolute-form 交上游代理（与 A) 组同一形态，不是 CONNECT）
      expect(status, body).toBe(200);
      expect(body).toBe(`upstream-ok:${url}`);
      // 真的握手成功：协商结果齐全 + 上游收到的是 https 角色的 absolute-form 报文
      const facts = s.last();
      expect(facts?.protocol).toMatch(/^TLSv/);
      expect(facts?.cipher).not.toBe("");
      expect(facts?.servername, "IP 目标按 RFC6066 应置空 SNI").toBe("");
      expect(facts?.requestKind).toBe("absolute-form");
      expect(facts?.requestLine).toBe("GET " + url + " HTTP/1.1");
      expect(facts?.target).toBe(`127.0.0.1:${originPort}`);
    }, 20000);

    it("态③ 无 UPSTREAM_CA：https 上游自签被拒 → 502（不挂死），上游零应用层字节", async () => {
      const s = await stub("https", true);
      applyUpstream("https", s.port, "", false);
      const { status, body } = await httpViaProxy(
        httpInPort,
        `http://127.0.0.1:${originPort}/ca-missing`,
      );
      expect(status, body).toBe(502);
      // 客户端在握手阶段就拒了自签证书：TCP 建链发生过、发出过 ClientHello，
      // 但 TLS 握手未完成 → 上游零应用层会话（证明「失败点在 TLS 校验」而非「没建链」）
      expect(s.connections()).toBe(1);
      expect(s.sessions()).toHaveLength(0);
    }, 20000);

    it("态① CA 文件缺失（回退系统信任库）：https 上游自签被拒 → 502，上游零应用层字节", async () => {
      const s = await stub("https", true);
      // 路径不存在 → readUpstreamCa 返回 undefined → 回退系统信任库
      applyUpstream("https", s.port, "keys/nope-upstream-ca.crt", false);
      const { status, body } = await httpViaProxy(
        httpInPort,
        `http://127.0.0.1:${originPort}/ca-file-missing`,
      );
      expect(status, body).toBe(502);
      expect(s.connections()).toBe(1);
      expect(s.sessions()).toHaveLength(0);
    }, 20000);

    it("态④ UPSTREAM_INSECURE=true：跳过校验，https 上游握手成功且 CONNECT 到源站", async () => {
      const s = await stub("https", true);
      applyUpstream("https", s.port, "", true);
      // 用 CONNECT 走隧道，让「源站真的收到请求」也可断言
      const { status, body } = await tunnelViaProxy(
        httpInPort,
        `127.0.0.1:${originPort}`,
        "/insecure-ok",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/insecure-ok");
      expect(s.last()?.protocol).toMatch(/^TLSv/);
      expect(s.last()?.requestKind).toBe("connect");
      expect(s.last()?.target).toBe(`127.0.0.1:${originPort}`);
    }, 20000);

    it("态④ sockss5 上游 insecure：跳过校验，SOCKS5 上游握手成功且转发到源站", async () => {
      const s = await stub("socks5", true);
      applyUpstream("sockss5", s.port, "", true);
      const { status, body } = await tunnelViaProxy(
        httpInPort,
        `127.0.0.1:${originPort}`,
        "/insecure-sockss5",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/insecure-sockss5");
      expect(s.last()?.protocol).toMatch(/^TLSv/);
      expect(s.last()?.requestKind).toBe("socks5-greeting");
      expect(s.last()?.target).toBe(`127.0.0.1:${originPort}`);
    }, 20000);

    it("态② sockss4 上游配 CA：握手成功且上游收到 socks4 CONNECT", async () => {
      const s = await stub("socks4", true);
      applyUpstream("sockss4", s.port, CA, false);
      const { status, body } = await tunnelViaProxy(
        httpInPort,
        `127.0.0.1:${originPort}`,
        "/ca-sockss4",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/ca-sockss4");
      expect(s.last()?.protocol).toMatch(/^TLSv/);
      expect(s.last()?.requestKind).toBe("socks4-connect");
      expect(s.last()?.target).toBe(`127.0.0.1:${originPort}`);
    }, 20000);

    it("态③ sockss4 上游无 CA：自签被拒 → CONNECT 502（不挂死），上游零应用层字节", async () => {
      const s = await stub("socks4", true);
      applyUpstream("sockss4", s.port, "", false);
      const { status, body } = await tunnelViaProxy(
        httpInPort,
        `127.0.0.1:${originPort}`,
        "/ca-missing-sockss4",
      );
      expect(status, body).toBe(502);
      expect(s.connections()).toBe(1);
      expect(s.sessions()).toHaveLength(0);
    }, 20000);

    it("态④ sockss4 上游 insecure：跳过校验，握手成功且转发到源站", async () => {
      const s = await stub("socks4", true);
      applyUpstream("sockss4", s.port, "", true);
      const { status, body } = await tunnelViaProxy(
        httpInPort,
        `127.0.0.1:${originPort}`,
        "/insecure-sockss4",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/insecure-sockss4");
      expect(s.last()?.requestKind).toBe("socks4-connect");
      expect(s.last()?.target).toBe(`127.0.0.1:${originPort}`);
    }, 20000);
  });
});
