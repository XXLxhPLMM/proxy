/**
 * @fileoverview http 转发器「出站形态」合同护栏
 * @description
 * `http.ts` 只有一条出站路径：选连接器 → `connector.transport()` →
 * `http.request({ createConnection })`。全部风险都在「出站那几个字节长什么样」，本文件逐条锁死：
 *
 * | # | 行为 | 判据来源 |
 * |---|---|---|
 * | ① | `targetForm === "absolute"`（经 http/https 上游）：request-target **保留客户端原始形态**（absolute-form），**注入**上游凭证，**不改写**客户端的 Host | 连接器 `targetForm` / `upstreamAuthHeader()` |
 * | ② | `targetForm === "origin"`（直连）：request-target 用解析后的 `dest.path`；客户端发 absolute-form 时 Host 按 RFC 7230 §5.4 **回写**为 request-target 的权威值 | 连接器 `kind === "direct"` |
 * | ③ | 经 SOCKS 隧道：Host **无条件**回写为 `formatAuthority(dest.host, dest.port)`（IPv6 补方括号）+ 强制 `Connection: close` | 连接器 `kind !== "direct"` |
 * | ④ | 上游凭证**只**经 http/https 上游注入；SOCKS / 直连绝不带 `Proxy-Authorization` | `targetForm` + `upstreamAuthHeader()` |
 * | ⑤ | 拨号失败统一 502 且带 `upstream-error` 事件（不挂死）；`sanitizeHeaders` 的出站净化对三条支路一致生效 | 单一 catch |
 *
 * ②③ **刻意是两种判据**（直连是「absolute-form 才回写」，SOCKS 是「无条件回写」）：
 * 前者的触发条件是「客户端 Host 与 request-target 冲突」，后者的前提是「request-target
 * 已被本代理改写成 origin-form、客户端的 Host 不可信」。**本文件不把两者统一**。
 * （实测：在**可达**的请求上两种判据产出的字节逐字相同——差异只在「URL 省略缺省端口」
 * 那种 `absoluteFormAuthority` 会丢端口的形态上。故本文件锁的是**可观测效果**，
 * 「无条件」这个代码级属性由 `http.ts` 的注释负责说明，别因为「看起来等价」就顺手统一。）
 *
 * 上游凭证的注入条件**不在本文件**、而在连接器（`upstreamAuthHeader()` 对直连/SOCKS 恒返
 * `undefined`），本文件只锁可观测效果：SOCKS/直连的源站收不到 `Proxy-Authorization`。
 *
 * 观测手段：源站/上游一律用**裸 `net.Server`**（`http.Server` 会把畸形 target 也塞进
 * `req.url`，把缺陷藏住），客户端用裸 socket 手写请求行 —— 断言的是**逐字节原文**。
 */
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import tls from "node:tls";
import { FileAccountIdentity } from "@/core/identity.js";
import { HttpProxy } from "@/core/server/http.js";
import type { EventSubscription } from "@/core/events/index.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import {
  restoreConfig,
  set,
  silenceLogs,
  snapshotConfig,
  testContext,
  testEvents,
} from "../helpers/config.js";
import { TEST_CA_PATH, TEST_TLS_CERTS } from "../helpers/certs.js";
import { getFreePort } from "../helpers/net.js";
import { openAccessControl } from "../helpers/access.js";

/** 本文件涉及的配置键（逐键快照/恢复） */
const KEYS = [
  "host",
  "port",
  "proxyMode",
  "upstreamProtocol",
  "upstreamHost",
  "upstreamPort",
  "upstreamCa",
  "upstreamInsecure",
  "upstreamUsername",
  "upstreamPassword",
  "upstreamTimeout",
  "logLevel",
  "logFile",
] as const;

const UPSTREAM_USER = "up-user";
const UPSTREAM_PASS = "up-pass";
const UPSTREAM_BASIC = `Basic ${Buffer.from(`${UPSTREAM_USER}:${UPSTREAM_PASS}`).toString("base64")}`;

/** 裸 TCP 端点：记录收到的请求头原文，按需回一段固定应答 */
interface Raw {
  port: number;
  /** 收到的全部字节（逐字节断言用） */
  received: () => Buffer;
  close: () => Promise<void>;
}

const RAWS: Raw[] = [];
const PROXIES: HttpProxy[] = [];
const SUBS: EventSubscription[] = [];
const CLIENTS: net.Socket[] = [];
let SNAP: Record<string, unknown> = {};

afterEach(async () => {
  for (const s of SUBS.splice(0)) {
    s.dispose();
  }

  for (const c of CLIENTS.splice(0)) {
    if (!c.destroyed) {
      c.destroy();
    }
  }

  while (PROXIES.length) {
    await (PROXIES.pop() as HttpProxy).stop().catch(() => undefined);
  }

  while (RAWS.length) {
    await (RAWS.pop() as Raw).close();
  }

  restoreConfig(SNAP);
});

/** 裸 TCP 桩（源站 / 明文 http 上游通用） */
async function startRaw(
  reply: string,
  onConn?: (sock: net.Socket) => void,
  host = "127.0.0.1",
): Promise<Raw> {
  const chunks: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    sock.on("data", (c: Buffer) => {
      chunks.push(c);
      // 只在收到完整请求头后应答一次
      if (Buffer.concat(chunks).includes("\r\n\r\n")) {
        sock.write(reply);
      }
    });
    onConn?.(sock);
  });
  // 直接 listen(0) 再读回实际端口：`getFreePort()`（先 listen(0) → close → 重绑）有 TOCTOU 竞态，
  // 并行跑全套时那个端口号可能已被别的监听抢走，表现为偶发 502（IPv6 用例尤其明显）。
  // 也因此不用 helpers/net 的 listen()：它恒绑 127.0.0.1，而 IPv6 用例要绑 ::1。
  await new Promise<void>((r) => server.listen(0, host, () => r()));
  const port = (server.address() as net.AddressInfo).port;

  const raw: Raw = {
    port,
    received: () => Buffer.concat(chunks),
    close: async () => {
      for (const s of sockets) {
        s.destroy();
      }
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  RAWS.push(raw);
  return raw;
}

/** 源站应答：200 + 2 字节正文 + close（裸 TCP 才能让畸形 request-target 现形） */
const ORIGIN_REPLY = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";

/**
 * 假 SOCKS5 上游：方法协商挑 0x00 → CONNECT 真隧道到目标
 *
 * @description CONNECT 的 ATYP 三种都要认（IPv4 字面量 / 域名 / **IPv6 字面量**）：
 * 本仓库的 SOCKS5 连接器对 IPv6 字面量用 ATYP=0x04 + 16 字节（域名型无 v6 语义），
 * 只按域名型解包会把 IPv6 用例的桩解错、误报成「目标拨不通」。
 */
async function startSocks5Upstream(): Promise<Raw> {
  return startRaw("", (sock) => {
    let stage: "method" | "connect" = "method";

    sock.on("data", (req: Buffer) => {
      if (stage === "method") {
        stage = "connect";
        sock.write(Buffer.from([0x05, 0x00]));
        return;
      }

      const atyp = req[3];
      let host: string;
      let portAt: number;

      if (atyp === 0x01) {
        host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
        portAt = 8;
      } else if (atyp === 0x04) {
        const parts: string[] = [];

        for (let i = 0; i < 16; i += 2) {
          parts.push(((req[4 + i] << 8) | req[5 + i]).toString(16));
        }
        host = parts.join(":");
        portAt = 20;
      } else {
        const len = req[4];
        host = req.subarray(5, 5 + len).toString();
        portAt = 5 + len;
      }

      const port = req.readUInt16BE(portAt);
      // **必须摘掉 data 监听**：建隧后 `sock.pipe(target)` 会让隧内字节再次进入本回调，
      // 留着它等于把隧内的 HTTP 请求当成第二个 CONNECT 解包 → 桩自己把 socket 拆了，
      // 代理侧表现为偶发 502「socket hang up」（`upstream-matrix` 的桩同理）
      sock.removeAllListeners("data");

      const target = net.connect(port, host, () => {
        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        sock.pipe(target);
        target.pipe(sock);
      });

      target.on("error", () => sock.destroy());
    });
  });
}

/** 起一个真 HttpProxy（server 模式，鉴权关闭；与名单无关 → 显式点名「不判名单」） */
async function startProxy(): Promise<number> {
  const port = await getFreePort();
  const proxy = new HttpProxy({
    ctx: testContext,
    host: "127.0.0.1",
    port,
    identity: new FileAccountIdentity({ enabled: false }),
    access: openAccessControl(),
  });

  await proxy.start();
  PROXIES.push(proxy);
  return port;
}

/**
 * 裸 socket 发一段原始请求，读到对端关闭或超时；返回状态行与完整原文
 *
 * @description 客户端侧一律补 `Connection: close`（除调用方已自带时）：否则代理回完响应
 * 会把客户端连接留成 keep-alive，用例只能等 `ms` 超时兜底（既慢又不确定）。
 * 这只影响**入站**连接，与本文件断言的**出站**报文头无关。
 */
function rawRequest(
  port: number,
  raw: string,
  ms = 5000,
): Promise<{ status: number; text: string }> {
  const head = raw.toLowerCase().includes("\r\nconnection:")
    ? raw
    : raw.replace("\r\n\r\n", "\r\nConnection: close\r\n\r\n");

  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(head);
    });

    CLIENTS.push(sock);

    let text = "";
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ status: Number(text.split(" ")[1]) || 0, text });
    }, ms);

    sock.on("data", (c: Buffer) => {
      text += c.toString();
    });
    sock.on("close", () => {
      clearTimeout(timer);
      resolve({ status: Number(text.split(" ")[1]) || 0, text });
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** 订阅共享测试总线上的 pipe 事实（core 直发，订阅源取注入的 ctx.events） */
function collectPipe(): PipeEvent[] {
  const events: PipeEvent[] = [];

  SUBS.push(testEvents.subscribe("pipe", (e) => events.push(e.data)));
  return events;
}

/** 请求头字典（键小写，取首个值） */
function headers(head: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const line of head.split("\r\n").slice(1)) {
    if (line === "") {
      break;
    }
    const idx = line.indexOf(":");
    out[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim();
  }

  return out;
}

/** 请求行（首行原文） */
function requestLine(head: string): string {
  return head.split("\r\n")[0] ?? "";
}

function setup(): void {
  SNAP = snapshotConfig(KEYS);
  silenceLogs();
  set("authEnabled", false);
  set("authType", "none");
  set("host", "127.0.0.1");
  // 哨兵端口：isSelfLoop 读配置里的 host/port，用 1 避免把测试内的随机端口误判成自环
  set("port", 1);
  set("upstreamUsername", "");
  set("upstreamPassword", "");
}

// ---------------------------------------------------------------------------
// ① targetForm === "absolute"：保留 absolute-form + 注入上游凭证 + 不改写 Host
// ---------------------------------------------------------------------------

describe("integration/http 转发合同 ① absolute-form（经 http/https 上游）", () => {
  it("http 上游：request-target 保留客户端 absolute-form，Host 原样不改，且注入上游凭证", async () => {
    setup();
    const upstream = await startRaw(ORIGIN_REPLY);
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", upstream.port);
    set("upstreamUsername", UPSTREAM_USER);
    set("upstreamPassword", UPSTREAM_PASS);

    const proxyPort = await startProxy();
    // 客户端 Host 故意与 request-target 的 authority 不一致：改写就会被本用例抓住
    const { status } = await rawRequest(
      proxyPort,
      "GET http://example.com/abs?x=1 HTTP/1.1\r\nHost: client-host.example\r\n\r\n",
    );

    expect(status).toBe(200);

    const head = upstream.received().toString();
    expect(requestLine(head)).toBe("GET http://example.com/abs?x=1 HTTP/1.1");

    const h = headers(head);
    // 绝不改写：对端是代理，客户端 Host 就是「客户端本来要访问谁」的凭据
    expect(h.host).toBe("client-host.example");
    expect(h["proxy-authorization"]).toBe(UPSTREAM_BASIC);
    // 出站净化：强制 close
    expect(h.connection).toBe("close");
  });

  it("https 上游：TLS 完全由连接器承担，上游在 TLS 里看到的是同一份 absolute-form 报文", async () => {
    setup();
    const chunks: Buffer[] = [];
    const sockets = new Set<net.Socket>();
    const server = tls.createServer(TEST_TLS_CERTS, (sock) => {
      sockets.add(sock as unknown as net.Socket);
      sock.on("error", () => {});
      sock.on("data", (c: Buffer) => {
        chunks.push(c);

        if (Buffer.concat(chunks).includes("\r\n\r\n")) {
          sock.write(ORIGIN_REPLY);
        }
      });
    });
    const upstreamPort = await new Promise<number>((r) => {
      server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port));
    });
    RAWS.push({
      port: upstreamPort,
      received: () => Buffer.concat(chunks),
      close: async () => {
        for (const s of sockets) {
          s.destroy();
        }
        await new Promise<void>((r) => server.close(() => r()));
      },
    });

    set("proxyMode", "client");
    set("upstreamProtocol", "https");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", upstreamPort);
    set("upstreamCa", TEST_CA_PATH);
    set("upstreamInsecure", false);

    const proxyPort = await startProxy();
    const { status } = await rawRequest(
      proxyPort,
      "GET http://example.com/tls-abs HTTP/1.1\r\nHost: client-host.example\r\n\r\n",
    );

    expect(status).toBe(200);

    const head = Buffer.concat(chunks).toString();
    expect(requestLine(head)).toBe("GET http://example.com/tls-abs HTTP/1.1");
    expect(headers(head).host).toBe("client-host.example");
  });

  it("未配上游账号即不注入 Proxy-Authorization（防 client 头透传泄漏）", async () => {
    setup();
    const upstream = await startRaw(ORIGIN_REPLY);
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", upstream.port);

    const proxyPort = await startProxy();
    await rawRequest(proxyPort, "GET http://example.com/no-auth HTTP/1.1\r\nHost: h.example\r\n\r\n");

    const head = upstream.received().toString().toLowerCase();
    expect(head).toContain("get http://example.com/no-auth http/1.1");
    expect(head).not.toContain("proxy-authorization");
  });
});

// ---------------------------------------------------------------------------
// ② targetForm === "origin"（直连）：origin-form path + absolute-form 才回写 Host
// ---------------------------------------------------------------------------

describe("integration/http 转发合同 ② origin-form（直连源站）", () => {
  it("客户端发 absolute-form：request-target 归一为 origin-form，Host 按 §5.4 回写为权威值", async () => {
    setup();
    const origin = await startRaw(ORIGIN_REPLY);
    set("proxyMode", "server");

    const proxyPort = await startProxy();
    const { status } = await rawRequest(
      proxyPort,
      `GET http://127.0.0.1:${origin.port}/abs-direct HTTP/1.1\r\nHost: bogus-host.example\r\n\r\n`,
    );

    expect(status).toBe(200);

    const head = origin.received().toString();
    // origin-form（不是 `GET http://…`）
    expect(requestLine(head)).toBe("GET /abs-direct HTTP/1.1");
    // §5.4：absolute-form 的权威值来自 request-target，客户端那个 bogus Host 被覆盖
    expect(headers(head).host).toBe(`127.0.0.1:${origin.port}`);
  });

  it("客户端发 origin-form：request-target 与 Host 都原样透传（不回写）", async () => {
    setup();
    const origin = await startRaw(ORIGIN_REPLY);
    set("proxyMode", "server");

    const proxyPort = await startProxy();
    const { status } = await rawRequest(
      proxyPort,
      `GET /plain-direct HTTP/1.1\r\nHost: 127.0.0.1:${origin.port}\r\n\r\n`,
    );

    expect(status).toBe(200);

    const head = origin.received().toString();
    expect(requestLine(head)).toBe("GET /plain-direct HTTP/1.1");
    expect(headers(head).host).toBe(`127.0.0.1:${origin.port}`);
  });
});

// ---------------------------------------------------------------------------
// ③ 经 SOCKS 隧道：Host 无条件回写 + Connection: close
// ---------------------------------------------------------------------------

describe("integration/http 转发合同 ③ SOCKS 隧道", () => {
  it("客户端发的 bogus Host 被无条件回写为真实目标 authority，并强制 Connection: close", async () => {
    setup();
    const origin = await startRaw(ORIGIN_REPLY);
    const socks = await startSocks5Upstream();
    set("proxyMode", "client");
    set("upstreamProtocol", "socks5");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", socks.port);
    set("upstreamUsername", UPSTREAM_USER);
    set("upstreamPassword", UPSTREAM_PASS);

    const proxyPort = await startProxy();
    const { status } = await rawRequest(
      proxyPort,
      `GET http://127.0.0.1:${origin.port}/via-socks HTTP/1.1\r\nHost: bogus-host.example\r\n\r\n`,
    );

    expect(status).toBe(200);

    const head = origin.received().toString();
    expect(requestLine(head)).toBe("GET /via-socks HTTP/1.1");

    const h = headers(head);
    // 无条件回写（与 ② 的「absolute-form 才回写」刻意不同）
    expect(h.host).toBe(`127.0.0.1:${origin.port}`);
    expect(h.connection).toBe("close");
    // ④ SOCKS 绝不带上游凭证（哪怕配了账号）——凭证在 SOCKS 握手里
    expect(h["proxy-authorization"]).toBeUndefined();
  });

  it("IPv6 目标：Host 回写补回方括号（`[::1]:port`，不是畸形的 `::1:port`）", async () => {
    setup();
    const origin = await startRaw(ORIGIN_REPLY, undefined, "::1");
    const socks = await startSocks5Upstream();
    set("proxyMode", "client");
    set("upstreamProtocol", "socks5");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", socks.port);

    const proxyPort = await startProxy();
    const { status } = await rawRequest(
      proxyPort,
      `GET http://[::1]:${origin.port}/v6 HTTP/1.1\r\nHost: bogus.example\r\n\r\n`,
    );

    expect(status).toBe(200);

    const h = headers(origin.received().toString());
    expect(h.host).toBe(`[::1]:${origin.port}`);
  });
});

// ---------------------------------------------------------------------------
// ④ 凭证矩阵：只经 http/https 上游注入
// ---------------------------------------------------------------------------

describe("integration/http 转发合同 ④ 上游凭证只经 http/https 上游注入", () => {
  it("矩阵：配了上游账号时，http 上游带凭证、SOCKS 与直连都不带", async () => {
    setup();
    const origin = await startRaw(ORIGIN_REPLY);
    const httpUp = await startRaw(ORIGIN_REPLY);
    const socks = await startSocks5Upstream();
    set("upstreamUsername", UPSTREAM_USER);
    set("upstreamPassword", UPSTREAM_PASS);

    // (a) http 上游 → 上游收到凭证
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", httpUp.port);
    let proxyPort = await startProxy();
    await rawRequest(proxyPort, "GET http://example.com/a HTTP/1.1\r\nHost: h.example\r\n\r\n");
    expect(headers(httpUp.received().toString())["proxy-authorization"]).toBe(UPSTREAM_BASIC);

    // (b) socks5 上游 → 源站收不到凭证
    while (PROXIES.length) {
      await (PROXIES.pop() as HttpProxy).stop().catch(() => undefined);
    }
    set("upstreamProtocol", "socks5");
    set("upstreamPort", socks.port);
    proxyPort = await startProxy();
    await rawRequest(
      proxyPort,
      `GET http://127.0.0.1:${origin.port}/b HTTP/1.1\r\nHost: h.example\r\n\r\n`,
    );
    expect(headers(origin.received().toString())["proxy-authorization"]).toBeUndefined();

    // (c) 直连（server 模式）→ 源站收不到凭证
    while (PROXIES.length) {
      await (PROXIES.pop() as HttpProxy).stop().catch(() => undefined);
    }
    set("proxyMode", "server");
    proxyPort = await startProxy();
    await rawRequest(
      proxyPort,
      `GET http://127.0.0.1:${origin.port}/c HTTP/1.1\r\nHost: h.example\r\n\r\n`,
    );
    expect(headers(origin.received().toString())["proxy-authorization"]).toBeUndefined();
  }, 20000);
});

// ---------------------------------------------------------------------------
// ⑤ 失败分流：拨号失败统一 502 + upstream-error，不挂死
// ---------------------------------------------------------------------------

describe("integration/http 转发合同 ⑤ 上游失败分流", () => {
  it("上游拨不通：回 502 且发 upstream-error 事件（三条支路同一收尾）", async () => {
    setup();
    const dead = await getFreePort();
    const events = collectPipe();
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", dead);

    const proxyPort = await startProxy();
    const { status, text } = await rawRequest(
      proxyPort,
      "GET http://example.com/dead HTTP/1.1\r\nHost: h.example\r\n\r\n",
    );

    expect(status).toBe(502);
    expect(text).toContain("Bad Gateway");
    expect(
      events.some(
        (e) => e.type === "upstream-error" && String((e as { message?: string }).message).includes(`[http] upstream error 127.0.0.1:${dead}`),
      ),
      `实得事件：${JSON.stringify(events.map((e) => [e.type, (e as { message?: string }).message ?? ""]))}`,
    ).toBe(true);
  });
});
