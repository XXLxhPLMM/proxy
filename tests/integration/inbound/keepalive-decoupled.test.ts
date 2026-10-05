/**
 * 入站 keep-alive 与上游生命周期**解耦**的回归护栏（http 请求路径），外加反向护栏：
 * 隧道路径的联动必须原样保留。
 *
 * @module tests/integration/inbound/keepalive-decoupled
 *
 * 锁三件事（① 请求路径解耦 / ② 不留监听器泄漏 / ③ 拨号失败语义一点没丢）外加那条反向护栏。
 * 本档锁住的两条决策、观测口径与相关路径见 `./AGENTS.md`「入站 keep-alive 与上游生命周期解耦」
 * 一节；准入的关卡顺序与两条准入结构的决策（**`admission-order-*` 那两档共用**）也在那份里。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import type { ConfigKey } from "@/config/index.js";
import { HttpProxy } from "@/core/server/http.js";
import type { EventSubscription } from "@/core/events/index.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { restoreConfig, set, silenceLogs, snapshotConfig, testEvents } from "../../helpers/config.js";
import { getFreePort, listen, sleep } from "../../helpers/net.js";
import { withProxy } from "../../helpers/proxy.js";
import { makeCollector, tcConnect } from "../../helpers/socks-client.js";

const KEYS: readonly ConfigKey[] = [
  "aclFile",
  "authEnabled",
  "authType",
  "host",
  "port",
  "proxyMode",
  "upstreamProtocol",
  "upstreamHost",
  "upstreamPort",
  "logLevel",
  "logFile",
];

/** 观察用子类：把 protected 的 `server` 暴露成只读钩子（纯观测，不改行为） */
class ProbeProxy extends HttpProxy {
  get probe(): http.Server | null {
    return this.server;
  }
}

/**
 * 源站桩：回**完整**响应后**主动销毁自己的 socket**
 * @description 刻意**不发** `Connection: close`——那种形态下代理把 `Connection: close`
 * 透传给客户端、客户端换新连接是**正确的 HTTP 语义**，测不出守卫联动。这里的形态才是
 * 真缺陷的触发条件：响应里说的是 keep-alive，源站却把连接关了，代理不该替源站把
 * **入站**连接一起收掉。
 */
interface ClosingOrigin {
  port: number;
  conns: () => number;
  close: () => Promise<void>;
}

async function startClosingOrigin(): Promise<ClosingOrigin> {
  let conns = 0;
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    const sock = req.socket;
    res.setHeader("content-length", "9");
    res.setHeader("connection", "keep-alive");
    res.end("origin-ok", () => sock.destroy());
  });
  server.on("connection", (s: net.Socket) => {
    conns++;
    sockets.add(s);
    s.on("error", () => {});
    s.on("close", () => sockets.delete(s));
  });
  const port = await getFreePort();
  await listen(server, port);
  return {
    port,
    conns: () => conns,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) {
          s.destroy();
        }
        server.close(() => r());
      }),
  };
}

/** 一次 keep-alive 请求的结果（socket 身份是「同一条连接」的直接证据） */
interface OneShot {
  status: number;
  body: string;
  reused: boolean;
  socket: net.Socket;
}

/** 在给定 agent 上发一次请求并读完响应（socket 交还 agent 供下一轮复用） */
function request(
  proxyPort: number,
  path: string,
  agent: http.Agent,
): Promise<OneShot> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, method: "GET", path, agent },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            reused: Boolean((req as unknown as { reusedSocket?: boolean }).reusedSocket),
            socket: req.socket as net.Socket,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("integration/http-inbound-keepalive-decoupled", () => {
  let snap: Record<string, unknown>;
  let origin: ClosingOrigin;
  const subs: EventSubscription[] = [];

  beforeEach(async () => {
    snap = snapshotConfig(KEYS);
    silenceLogs();
    set("authEnabled", false);
    set("authType", "none");
    set("proxyMode", "server");
    set("host", "127.0.0.1");
    // 哨兵端口：避免 isSelfLoop 把测试内的随机临时端口误判为自环
    set("port", 1);
    origin = await startClosingOrigin();
  });

  afterEach(async () => {
    for (const s of subs.splice(0)) {
      s.dispose();
    }
    await origin.close();
    restoreConfig(snap);
  });

  it("① 源站每次响应后关连接：客户端 keep-alive 仍在同一条入站连接上连发 2 个请求", async () => {
    await withProxy(ProbeProxy, {}, async (port, proxy) => {
      const inbound: net.Socket[] = [];
      proxy.probe?.on("connection", (s) => inbound.push(s));

      // maxSockets: 1 —— 客户端只肯复用，不会「开新连接」绕过问题
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
      try {
        const first = await request(port, `http://127.0.0.1:${origin.port}/a`, agent);
        // 让源站的 socket.destroy() 与代理侧的联动有机会发生
        await sleep(120);
        const second = await request(port, `http://127.0.0.1:${origin.port}/b`, agent);
        await sleep(120);

        expect([first.status, second.status]).toEqual([200, 200]);
        expect([first.body, second.body]).toEqual(["origin-ok", "origin-ok"]);
        // 核心断言：第 2 个请求复用第 1 个请求那条**入站**连接
        expect(first.reused).toBe(false);
        expect(second.reused).toBe(true);
        expect(second.socket).toBe(first.socket);
        // 代理入站侧只应看到 1 条 TCP 连接（源站侧倒是每请求一条，那是另一回事）
        expect(inbound).toHaveLength(1);
        // 源站确实每次都关了连接：否则本用例根本没走到缺陷面
        expect(origin.conns()).toBe(2);
      } finally {
        agent.destroy();
      }
    });
  }, 20000);

  it("② 15 个请求跑在同一条入站连接上：守卫不在长连接上按请求累积监听器", async () => {
    const warnings: string[] = [];
    const onWarning = (w: Error): void => {
      warnings.push(w.message);
    };
    process.on("warning", onWarning);

    try {
      await withProxy(ProbeProxy, {}, async (port, proxy) => {
        const inbound: net.Socket[] = [];
        // 基线：Node 的 http.Server 自己在这条 socket 上就挂了若干 close/error 监听，
        // 守卫的那一对是在此之上**叠加**的。故断言一律相对基线（否则测的是 Node 的实现细节）。
        let baseClose = 0;
        let baseError = 0;
        proxy.probe?.on("connection", (s) => {
          if (inbound.length === 0) {
            baseClose = s.listenerCount("close");
            baseError = s.listenerCount("error");
          }
          inbound.push(s);
        });

        const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
        try {
          let peakClose = 0;
          let peakError = 0;
          for (let i = 0; i < 15; i++) {
            // eslint-disable-next-line no-await-in-loop
            const r = await request(port, `http://127.0.0.1:${origin.port}/n${i}`, agent);
            expect(r.status).toBe(200);
            const s = inbound[0];
            if (s) {
              peakClose = Math.max(peakClose, s.listenerCount("close"));
              peakError = Math.max(peakError, s.listenerCount("error"));
            }
          }
          await sleep(200);

          expect(inbound).toHaveLength(1);
          // 上游一死即摘除 → 全部请求跑完后守卫的那一对**全部退回基线**
          expect(inbound[0].listenerCount("close")).toBe(baseClose);
          expect(inbound[0].listenerCount("error")).toBe(baseError);
          // 峰值上界 = 基线 + 1：客户端严格串行，最多同时存在「上一个请求的（尚未收到
          // 上游 close）」与「当前请求的」两对。泄漏形态下这里会随请求数线性增长（15）。
          expect(peakClose).toBeLessThanOrEqual(baseClose + 1);
          expect(peakError).toBeLessThanOrEqual(baseError + 1);
        } finally {
          agent.destroy();
        }
      });
    } finally {
      process.off("warning", onWarning);
    }

    // 上面的断言已是主证据；再补一条「Node 自己没报监听器泄漏」的行为侧兜底
    expect(warnings.filter((m) => m.includes("MaxListeners"))).toEqual([]);
  }, 30000);

  it("③ 上游拨不通：仍回 502 且发 upstream-error（解耦没有吞事件、也没有动客户端）", async () => {
    const dead = await getFreePort();
    const events: PipeEvent[] = [];
    subs.push(testEvents.subscribe("pipe", (e) => events.push(e.data)));

    await withProxy(ProbeProxy, {}, async (port) => {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const r = await request(port, `http://127.0.0.1:${dead}/gone`, agent);
        expect(r.status).toBe(502);
      } finally {
        agent.destroy();
      }
    });

    expect(
      events.some(
        (e) =>
          e.type === "upstream-error" &&
          String((e as { message?: string }).message).includes(`[http] upstream error 127.0.0.1:${dead}`),
      ),
      `实得事件：${JSON.stringify(events.map((e) => [e.type, (e as { message?: string }).message ?? ""]))}`,
    ).toBe(true);
  }, 20000);
});

/**
 * 反向护栏：隧道路径的**存活联动必须原样保留**
 * @description 请求路径解耦**不许**蔓延到 CONNECT：隧道里客户端 socket 与管道是同一资源的
 * 两端（`bridge()` 双向 pipe），目标一关客户端那一端就得跟着断，否则就是挂死。
 * 精确的机制锁在 `unit/guard-client-lifetime.test.ts`（`linked` 是缺省形态）；
 * 这里锁的是**端到端不挂死**这个行为后果。
 */
describe("integration/tunnel 生命周期联动未被解耦波及", () => {
  let snap: Record<string, unknown>;

  beforeEach(() => {
    snap = snapshotConfig(KEYS);
    silenceLogs();
    set("authEnabled", false);
    set("authType", "none");
    set("proxyMode", "server");
    set("host", "127.0.0.1");
    set("port", 1);
  });

  afterEach(() => {
    restoreConfig(snap);
  });

  it("CONNECT 隧道：目标回声后关连接，客户端那一端必须被拆掉（不挂死）", async () => {
    // 隧道目标必须是裸 net.Server（直连 CONNECT 不发任何 CONNECT 报文，
    // 给 http.Server 会把隧道字节当 HTTP 请求解析）
    const sockets = new Set<net.Socket>();
    const target = net.createServer((sock) => {
      sockets.add(sock);
      sock.on("error", () => {});
      sock.on("close", () => sockets.delete(sock));
      sock.once("data", (c: Buffer) => {
        sock.write(c);
        sock.destroy();
      });
    });
    const targetPort = await getFreePort();
    await listen(target, targetPort);

    try {
      await withProxy(ProbeProxy, {}, async (port) => {
        const sock = await tcConnect(port);
        const collector = makeCollector(sock);
        sock.write(
          `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`,
        );
        await collector.waitFor((b) => b.includes(Buffer.from("200 Connection Established")), 3000);
        expect(collector.bytes().includes(Buffer.from("200 Connection Established"))).toBe(true);

        sock.write("ping");
        // 回声先到（证明隧道确实是通的），随后目标关连接
        await collector.waitFor((b) => b.includes(Buffer.from("ping")), 3000);
        // 目标一关，客户端这一端必须在预算内跟着断——不许挂死
        await collector.waitClose(2000);
        expect(sock.destroyed).toBe(true);
      });
    } finally {
      for (const s of sockets) {
        s.destroy();
      }
      await new Promise<void>((r) => target.close(() => r()));
    }
  }, 20000);
});
