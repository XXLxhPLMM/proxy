/**
 * `upstream/matrix-*` 十档共用的前导段：入站/上游桩、端口、模块级生命周期与两个客户端侧断言器
 *
 * @module tests/integration/upstream/matrix-fixture
 *
 * 主题级不变量（矩阵覆盖目标、六协议规格表、连接器源为什么必须现读、
 * 零外网白名单口径）见 `./AGENTS.md`。
 *
 * ⚠️ **本模块刻意不进 `tests/helpers/`**：`external-network-scan.ts` 的
 * `SCAN_DIRS` 不含 `helpers/`，而这里有 `Host: "example.com"`（`httpViaProxy`）
 * 与整段建链位。搬过去会让那部分覆盖**从零外网扫描里静默消失**，
 * 而 `unit/no-external-network.test.ts` 的两条下界断言照样绿。
 */
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { FileAccountIdentity } from "@/core/identity.js";
import { HttpProxy } from "@/core/server/http.js";
import { HttpsProxy } from "@/core/server/https.js";
import { Socks4Proxy } from "@/core/server/socks4.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import { Sockss4Proxy } from "@/core/server/sockss4.js";
import { Sockss5Proxy } from "@/core/server/sockss5.js";
import { defaults } from "@/config/index.js";
import { set, testContext } from "../../helpers/config.js";
import type { ProxyCore } from "@/core/types/proxy.js";
import { createConnectorSource } from "@/core/forward/upstream/connector/index.js";
import type { ConnectorSource } from "@/core/forward/upstream/connector/index.js";
import { getFreePort, listen } from "../../helpers/net.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../../helpers/config.js";
import { TEST_CA_PATH, TEST_TLS_CERTS, TEST_TLS_PATHS } from "../../helpers/certs.js";
import { startUpstreamStub, type UpstreamRole, type UpstreamStub } from "../../helpers/upstream-stub.js";
import { openAccessControl } from "../../helpers/access.js";
/**
 * 连接器源：**现读** `upstreamProtocol` 的那份（记忆化那份会让第一条用例把协议粘死）
 *
 * 前提与「为什么不能沿用默认实现」见 `./AGENTS.md` 的「连接器源必须现读」一节。
 *
 * ⚠️ 本应住在 `tests/helpers/proxy.ts` 紧邻 `withProxy`（所有直构 core 的汇聚点）；
 * 它就地定义而没有放进 `tests/helpers/**`（登记在 `tests/AGENTS.md`，待收口）。
 */
function liveConnectors(): ConnectorSource {
  return {
    direct: () => createConnectorSource(testContext).direct(),
    upstream: () => createConnectorSource(testContext).upstream(),
  };
}

export const CA = TEST_CA_PATH;

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
export function httpViaProxy(
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
export function tunnelViaProxy(
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
export function socksConnect(
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
export async function httpViaSocksProxy(
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
export function socksConnectOverTls(
  proxyPort: number,
  version: 4 | 5,
  host: string,
  port: number,
): Promise<{ ok: boolean; rep: number; socket: Duplex | null; raw: Buffer }> {
  return new Promise((resolve) => {
    // 自签入站证书：客户端侧固定跳过校验（矩阵不测入站证书校验，那在 `tests/integration/inbound/tls-client-auth.test.ts`）
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
export async function httpViaSockssProxy(
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

const stubs: net.Server[] = [];
const proxies: ProxyCore[] = [];
export let originPort = 0;
export let httpUpPort = 0;
export let httpsUpPort = 0;
export let socks4UpPort = 0;
export let socks5UpPort = 0;
export let sockss4UpPort = 0;
export let sockss5UpPort = 0;
export let httpInPort = 0;
export let httpsInPort = 0;
export let s4InPort = 0;
export let s5InPort = 0;
export let sockss4InPort = 0;
export let sockss5InPort = 0;

/** 本目录自起的可观测上游桩（tests/helpers/upstream-stub.ts）；afterEach 统一 close */
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

export const applyUpstream = (
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

  const identity = new FileAccountIdentity({ enabled: false });
  const httpIn = new HttpProxy({
    ctx: testContext,
    host: "127.0.0.1",
    port: httpInPort,
    identity,
    // 矩阵用例与名单无关 → 显式点名「不判名单」
    access: openAccessControl(),
    connectors: liveConnectors(),
  });
  const httpsIn = new HttpsProxy({
    ctx: testContext,
    host: "127.0.0.1",
    port: httpsInPort,
    identity,
    // 矩阵用例与名单无关 → 显式点名「不判名单」
    access: openAccessControl(),
    connectors: liveConnectors(),
    tls: TEST_TLS_PATHS,
  });
  const s4In = new Socks4Proxy({
    ctx: testContext,
    host: "127.0.0.1",
    port: s4InPort,
    identity,
    // 矩阵用例与名单无关 → 显式点名「不判名单」
    access: openAccessControl(),
    connectors: liveConnectors(),
  });
  const s5In = new Socks5Proxy({
    ctx: testContext,
    host: "127.0.0.1",
    port: s5InPort,
    identity,
    // 矩阵用例与名单无关 → 显式点名「不判名单」
    access: openAccessControl(),
    connectors: liveConnectors(),
  });
  // sockss4 / sockss5：TLS 承载的 SOCKS 入站（入站证书复用仓内测试 PKI）
  const sockss4In = new Sockss4Proxy({
    ctx: testContext,
    host: "127.0.0.1",
    port: sockss4InPort,
    identity,
    // 矩阵用例与名单无关 → 显式点名「不判名单」
    access: openAccessControl(),
    connectors: liveConnectors(),
    tls: TEST_TLS_PATHS,
  });
  const sockss5In = new Sockss5Proxy({
    ctx: testContext,
    host: "127.0.0.1",
    port: sockss5InPort,
    identity,
    // 矩阵用例与名单无关 → 显式点名「不判名单」
    access: openAccessControl(),
    connectors: liveConnectors(),
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

/**
 * 起一个可观测上游桩并登记到 openStubs（afterEach 统一 close）
 * @param role - 上游角色（https / socks4 / socks5）
 * @param secure - 承载形态（true = TLS 承载，即 https/sockss4/sockss5 三个 TLS 上游）
 * @param rejectWithPlaintext - 只配明文桩：收到任何字节回明文 HTTP 错误（制造 TLS 失配）
 */
export const stub = async (
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
export const expectUpstreamSaw = (
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
export const SIX_UPSTREAMS = [
  ["http", "https", false, "connect"],
  ["https", "https", true, "connect"],
  ["socks4", "socks4", false, "socks4-connect"],
  ["socks5", "socks5", false, "socks5-greeting"],
  ["sockss4", "socks4", true, "socks4-connect"],
  ["sockss5", "socks5", true, "socks5-greeting"],
] as const;
