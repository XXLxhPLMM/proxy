/**
 * 每用户流量配额的**接线护栏**（Phase 5a：计量落点 + 耗尽判定 + 事件 + 身份隔离 + 热加载）
 *
 * @description
 * 数据层在 `tests/unit/user-quota.test.ts`，判定层在 `tests/unit/traffic-account.test.ts`；
 * 本文件只答一个���题：**计量真的落在「建链后流动的真实字节」上吗，耗尽真的硬切了吗**。
 *
 * 全部用**真代理 + 真源站 + 已知字节量**驱动，不用 mock：
 * - 计量准确性：CONNECT 隧道路径与 HTTP 普通转发路径**各一条**，断言 `usage` 的实测值
 * - 建链协议字节未计入：CONNECT 往返、SOCKS5 握手往返都不得出现在 `usage` 里
 * - 耗尽三条：HTTP 未发头回 507、HTTP 已发头 destroy、隧道/SOCKS destroy，各断言**恰好一次**
 * - 事件：`traffic.quota-exceeded` 恰好一条、`user`/`dir`/`scope`/`EventContext.user` 正确；未耗尽零发布
 * - 无鉴权：不计量、`usage` 恒零、启动一条 warn
 * - 身份不串号：两个用户在同一代理上各耗各的
 * - 热加载：改配额越过 1s 节流后对新请求生效，**已用量保留不清零**
 * - 装配：注入的 `TrafficAccount` 原样生效；默认实现只在 `createProxyRuntime` 解析
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createConfigContext, readAuthUsers } from "@/config/index.js";
import { createAuthFromConfig } from "@/core/auth.js";
import type { CoreContext } from "@/core/context.js";
import { EventHub } from "@/core/events/index.js";
import type { EventEnvelope, EventSubscription } from "@/core/events/index.js";
import { HttpProxy } from "@/core/server/http.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import type { TrafficAccount } from "@/core/traffic/index.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { RuntimeWarning } from "@/runtime/index.js";
import { ProxyServer } from "@/server/index.js";
import { LoggerImpl } from "@/utils/logger/index.js";
import { getFreePort, listen, sleep } from "../helpers/net.js";
import { withProxy } from "../helpers/proxy.js";
import { makeCollector, rfc1929, socks5ConnectIpv4, tcConnect } from "../helpers/socks-client.js";
import {
  restoreConfig,
  set,
  silenceLogs,
  snapshotConfig,
  testConfig,
  testConfigStore,
  testLogger,
} from "../helpers/config.js";

/** 本文件自建一条总线（往共享测试总线上挂长期订阅会跨用例累积） */
const bus = new EventHub({ onListenerError: () => undefined });
const ctx: CoreContext = { config: testConfig, logger: testLogger, events: bus };

const ALICE = "alice";
const ALICE_PW = "pw1";
const BOB = "bob";
const BOB_PW = "pw2";
const TARGET_IP = "127.0.0.1";

const KEYS = [
  "host",
  "port",
  "proxyMode",
  "upstreamProtocol",
  "upstreamHost",
  "upstreamPort",
  "upstreamTimeout",
  "authEnabled",
  "authType",
  "authLogging",
  "authUsersFile",
  "aclFile",
  // Phase 5b-2：账本目录**必须**逐例隔离（见 beforeEach 的注释），故进快照表随 restoreConfig 复原
  "quotaLedgerDir",
  "logLevel",
  "logFile",
] as const;

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

interface Origin {
  port: number;
  /** 已服务的 POST 请求体字节数（按路径前缀分桶） */
  bodyIn: (tag: string) => number;
  /** 已服务的响应体字节数 */
  bodyOut: (tag: string) => number;
  close: () => Promise<void>;
}

interface RawEcho {
  port: number;
  close: () => Promise<void>;
}

/** 经代理发一次 absolute-form 请求；返回状态码与客户端实测收到的响应体字节数 */
function proxyRequest(
  proxyPort: number,
  targetPort: number,
  user: string,
  pass: string,
  opts: { method?: string; path?: string; body?: Buffer } = {},
): Promise<{ status: number; got: number; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: TARGET_IP,
        port: proxyPort,
        method: opts.method ?? "GET",
        path: `http://${TARGET_IP}:${targetPort}${opts.path ?? "/x"}`,
        headers: {
          Host: `${TARGET_IP}:${targetPort}`,
          "Proxy-Authorization": basic(user, pass),
          Connection: "close",
          ...(opts.body === undefined ? {} : { "content-length": String(opts.body.length) }),
        },
      },
      (res) => {
        let got = 0;
        res.on("data", (c: Buffer) => {
          got += c.length;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, got, aborted: false }));
        // 响应头已发出后被硬切：客户端看到的是「中途断流」，不是 end
        res.on("aborted", () => resolve({ status: res.statusCode ?? 0, got, aborted: true }));
        res.on("error", (e: Error) => {
          if ((e as NodeJS.ErrnoException).code === "ECONNRESET") {
            resolve({ status: res.statusCode ?? 0, got, aborted: true });
            return;
          }
          reject(e);
        });
      },
    );
    req.on("error", (e: Error) => {
      if ((e as NodeJS.ErrnoException).code === "ECONNRESET") {
        resolve({ status: 0, got: 0, aborted: true });
        return;
      }
      reject(e);
    });
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
    if (opts.body !== undefined) {
      req.end(opts.body);
      return;
    }
    req.end();
  });
}

function connectReq(targetPort: number, user: string, pass: string, head?: string): string {
  return [
    `CONNECT ${TARGET_IP}:${targetPort} HTTP/1.1`,
    `Host: ${TARGET_IP}:${targetPort}`,
    `Proxy-Authorization: ${basic(user, pass)}`,
    "",
    head ?? "",
  ].join("\r\n");
}

/** 经 CONNECT 隧道传 `n` 字节载荷并等回声；返回隧道实际传输的两个方向字节数 */
function tunnelPayload(
  port: number,
  targetPort: number,
  user: string,
  pass: string,
  payload: Buffer,
): Promise<{ sent: number; echoed: number; established: boolean }> {
  return new Promise((resolve) => {
    const sock = net.connect(port, TARGET_IP, () => {
      sock.write(connectReq(targetPort, user, pass));
    });
    let buf = Buffer.alloc(0);
    let established = false;
    let echoed = 0;
    let sent = 0;
    const done = (): void => {
      clearTimeout(timer);
      sock.destroy();
      resolve({ sent, echoed, established });
    };
    const timer = setTimeout(done, 5000);
    sock.on("data", (c: Buffer) => {
      let chunk = c;
      if (!established) {
        buf = Buffer.concat([buf, c]);
        const at = buf.indexOf("\r\n\r\n");
        if (at < 0) {
          return;
        }
        established = buf.subarray(0, at).toString("latin1").startsWith("HTTP/1.1 200");
        // `200 Connection Established` 是协议字节，**不是**隧道载荷：把它从计数里剔掉，
        // 否则客户端实测的「回声字节」会比实际载荷多出应答头的长度。
        chunk = buf.subarray(at + 4);
        if (!established) {
          done();
          return;
        }
        // 200 已确认：把载荷**连在同一次写里**发出去（模拟客户端首包 head）
        sent = payload.length;
        sock.write(payload);
      }
      echoed += chunk.length;
      if (echoed >= payload.length) {
        done();
      }
    });
    sock.on("error", done);
    sock.on("close", () => done());
  });
}

/**
 * **首包（`head`）路径**：CONNECT 请求头与载荷在**同一次写**里发出
 * @description
 * 这是 Node 的 HTTP 解析器把「请求头之后的字节」交给我们的那条路：那些字节**不会**再触发
 * socket 的 `data` 事件（解析器已经把它们摘走了），故必须由 `bridgeWithBuffered` 经
 * `meter.charge("up", ...)` 显式补记。分两次写（等 200 再发载荷）走的是**另一条**路
 * （普通 `data` 事件），覆盖不到这里。
 */
function tunnelPipelinedHead(
  port: number,
  targetPort: number,
  user: string,
  pass: string,
  payload: Buffer,
): Promise<{ echoed: number; established: boolean }> {
  return new Promise((resolve) => {
    const sock = net.connect(port, TARGET_IP, () => {
      // CONNECT 请求头 + 载荷，一次写完 → 后半段成为 `head`
      sock.write(connectReq(targetPort, user, pass, payload.toString("latin1")));
    });
    let buf = Buffer.alloc(0);
    let established = false;
    let echoed = 0;
    const done = (): void => {
      clearTimeout(timer);
      sock.destroy();
      resolve({ echoed, established });
    };
    const timer = setTimeout(done, 5000);
    sock.on("data", (c: Buffer) => {
      let chunk = c;
      if (!established) {
        buf = Buffer.concat([buf, c]);
        const at = buf.indexOf("\r\n\r\n");
        if (at < 0) {
          return;
        }
        established = buf.subarray(0, at).toString("latin1").startsWith("HTTP/1.1 200");
        chunk = buf.subarray(at + 4);
        if (!established) {
          done();
          return;
        }
      }
      echoed += chunk.length;
      if (echoed >= payload.length) {
        done();
      }
    });
    sock.on("error", done);
    sock.on("close", () => done());
  });
}

describe("integration/traffic-quota（每用户流量配额：计量 + 耗尽）", () => {
  let snap: Record<string, unknown>;
  let dir: string;
  let usersPath: string;
  let aclPath: string;
  let clock = 0;
  let origin: Origin;
  let raw: RawEcho;
  let quotaEvents: EventEnvelope<"traffic.quota-exceeded">[];
  let subs: EventSubscription[] = [];
  /** 注入的替身账本（每个用例一份，故 usage 互不干扰） */
  let account: TrafficAccount;
  let runtime: ReturnType<typeof createProxyRuntime> | undefined;

  function exceeded(): EventEnvelope<"traffic.quota-exceeded">[] {
    return quotaEvents.filter((e) => e.name === "traffic.quota-exceeded");
  }

  /** 显式 ctx（自建总线）+ 配置驱动的鉴权（身份真的来自那份 users.json） */
  function proxyOpts(): {
    ctx: CoreContext;
    auth: ReturnType<typeof createAuthFromConfig>;
    traffic: TrafficAccount;
  } {
    return { ctx, auth: createAuthFromConfig(testConfig), traffic: account };
  }

  function writeUsers(users: unknown): void {
    clock += 1000;
    fs.writeFileSync(usersPath, JSON.stringify(users));
    fs.utimesSync(usersPath, clock / 1000, clock / 1000);
  }

  beforeAll(async () => {
    // 真源站：POST 请求体逐块收；GET 回一个已知长度的响应体
    const ins = new Map<string, number>();
    const outs = new Map<string, number>();
    const sockets = new Set<net.Socket>();
    const bump = (m: Map<string, number>, tag: string, n: number): void => {
      m.set(tag, (m.get(tag) ?? 0) + n);
    };
    const server = http.createServer((req, res) => {
      const tag = (req.url ?? "/").replace(/[^\w]/g, "") || "x";
      if (req.method === "POST") {
        req.on("data", (c: Buffer) => bump(ins, tag, c.length));
        req.on("end", () => {
          const body = Buffer.alloc(64, 0x5a); // "Z"
          bump(outs, tag, body.length);
          res.writeHead(200, { "content-length": String(body.length) });
          res.end(body);
        });
        return;
      }
      const size = Number(new URL(`http://x${req.url ?? "/x"}`).searchParams.get("n") ?? "0");
      const body = Buffer.alloc(size, 0x5a);
      bump(outs, tag, body.length);
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("error", () => {});
      s.on("close", () => sockets.delete(s));
    });
    const originPort = await getFreePort();
    await listen(server, originPort);
    origin = {
      port: originPort,
      bodyIn: (tag) => ins.get(tag) ?? 0,
      bodyOut: (tag) => outs.get(tag) ?? 0,
      close: () =>
        new Promise<void>((r) => {
          for (const s of sockets) {
            s.destroy();
          }
          server.close(() => r());
        }),
    };

    // 裸 TCP 回显（CONNECT 隧道的对端：给 http.Server 会把隧道字节当 HTTP 解析）
    const echoSockets = new Set<net.Socket>();
    const echo = net.createServer((s) => {
      echoSockets.add(s);
      s.on("error", () => {});
      s.on("close", () => echoSockets.delete(s));
      s.on("data", (c) => s.write(c));
    });
    const rawPort = await getFreePort();
    await listen(echo, rawPort);
    raw = {
      port: rawPort,
      close: () =>
        new Promise<void>((r) => {
          for (const s of echoSockets) {
            s.destroy();
          }
          echo.close(() => r());
        }),
    };
  });

  beforeEach(async () => {
    snap = snapshotConfig(KEYS);
    silenceLogs();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "traffic-quota-"));
    usersPath = path.join(dir, "users.json");
    aclPath = path.join(dir, "acl.json");
    writeUsers([
      { username: ALICE, password: ALICE_PW, quota: { bytesUp: 0, bytesDown: 0, bytesTotal: 0 } },
      { username: BOB, password: BOB_PW },
    ]);
    fs.writeFileSync(aclPath, JSON.stringify({}));
    set("aclFile", aclPath);
    set("authUsersFile", usersPath);
    // **账本目录逐例隔离**（Phase 5b-2）：用量现在是**持久**的，共享一个目录会让上一条用例
    // 烧掉的额度漏进下一条。实测症状：某条断言 `[quota-exceeded] … usage=5000` 变成
    // `usage=15000`（前两条用例的用量被恢复进来了），而且**时序相关**（上一条 runtime 的
    // 停机落盘有没有赶上本条 start），表现为「时红时绿」——最难查的那种污染。
    // 根因是真实的、正当的行为：账本按设计跨进程存活，测试就必须像隔离 `logFile` 那样隔离它。
    set("quotaLedgerDir", path.join(dir, "quota"));
    set("authEnabled", true);
    set("authType", "basic");
    set("authLogging", false);
    set("host", TARGET_IP);
    set("port", 1);
    set("proxyMode", "server");
    readAuthUsers({ config: testConfig, force: true });

    // 替身账本：直接消费同一份 users.json 的 quota（与默认实现同一条读取路径）
    const { createMemoryTrafficAccount } = await import("@/core/traffic/index.js");
    const { loadUserQuota } = await import("@/config/index.js");
    account = createMemoryTrafficAccount((user) => loadUserQuota(user, testConfig));

    quotaEvents = [];
    subs = [bus.subscribe("traffic.quota-exceeded", (e) => quotaEvents.push(e))];
  });

  afterEach(async () => {
    for (const s of subs) {
      s.dispose();
    }
    subs = [];
    if (runtime) {
      await runtime.stop().catch(() => {});
      runtime = undefined;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    restoreConfig(snap);
  });

  afterAll(async () => {
    await origin.close();
    await raw.close();
  });

  // =========================================================================
  // 护栏 3：计量落点正确性（真字节，不用 mock）
  // =========================================================================

  it("隧道路径（CONNECT）：usage 的 up/down 与真实传输字节逐字节相等，且不含建链协议字节", async () => {
    const payload = Buffer.alloc(4096, 0x41); // "A"
    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      const r = await tunnelPayload(port, raw.port, ALICE, ALICE_PW, payload);
      expect(r.established, "CONNECT 必须先回 200").toBe(true);
      expect(r.sent).toBe(4096);
      expect(r.echoed).toBe(4096);
    });

    // 精确：裸 socket 路径上客户端首包与响应余量都经过 socket，两个方向都逐字节精确
    expect(account.usage(ALICE)).toEqual({ up: 4096, down: 4096 });
    // 建链协议字节**不**计入：CONNECT 请求行+请求头+`200 Connection Established`
    // 一共约 130 字节，若被误计 usage 会明显大于 4096
    expect(account.usage(ALICE).up).toBeLessThan(4096 + 1024);
    expect(exceeded(), "未耗尽时零发布").toHaveLength(0);
  });

  it("建隧后的首批载荷（`head`：客户端 CONNECT 头之后的首包）也计入 —— 经 meter.charge 补记", async () => {
    // 这条覆盖的是**另一条**落点：CONNECT 请求头与载荷同一次写出去时，载荷被 Node 的解析器
    // 摘进 `head`，**不再触发 socket 的 data 事件**，故只能由 `bridgeWithBuffered` 显式补记。
    // 少了这一步 `usage.up` 会是 0（已用变异测试验证：临时去掉 head 补记 → 本条立刻变红）。
    const payload = Buffer.alloc(3000, 0x4a); // "J"
    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      const r = await tunnelPipelinedHead(port, raw.port, ALICE, ALICE_PW, payload);
      expect(r.established, "CONNECT 必须先回 200").toBe(true);
      expect(r.echoed, "回声应逐字节回来").toBe(3000);
    });
    expect(account.usage(ALICE)).toEqual({ up: 3000, down: 3000 });
    expect(exceeded()).toHaveLength(0);
  });

  it("SOCKS5 路径：握手往返（greeting/认证/CONNECT 应答）不计入，只有载荷计入", async () => {
    const payload = Buffer.alloc(2048, 0x42);
    await withProxy(Socks5Proxy, proxyOpts(), async (port) => {
      const sock = await tcConnect(port);
      const c = makeCollector(sock);
      sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      await c.waitFor((b) => b.length >= 2, 3000);
      sock.write(rfc1929(ALICE, ALICE_PW));
      await c.waitFor((b) => b.length >= 4, 3000);
      sock.write(socks5ConnectIpv4(TARGET_IP, raw.port));
      await c.waitFor((b) => b.length >= 14, 3000);
      // 握手协议字节（≥14）先落地，随后才是载荷
      sock.write(payload);
      await c.waitFor((b) => b.length >= 14 + payload.length, 5000);
      sock.destroy();
    });

    expect(account.usage(ALICE)).toEqual({ up: 2048, down: 2048 });
    expect(exceeded()).toHaveLength(0);
  });

  it("HTTP 普通转发：usage 精确等于请求体/响应体字节数（HTTP 头两侧都不计入，已量化说明）", async () => {
    const body = Buffer.alloc(1500, 0x43);
    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      const r = await proxyRequest(port, origin.port, ALICE, ALICE_PW, {
        method: "POST",
        path: "/updown",
        body,
      });
      expect(r.status).toBe(200);
      expect(r.got).toBe(64);
    });

    // **不对称（诚实记录，不假装两侧对称）**：
    // `up` 少算请求行+请求头（本次约 120B），`down` 少算状态行+响应头（本次约 100B）。
    // Node 的 IncomingMessage 流只覆盖消息体，两个方向的 HTTP 头都是 Node 直接写进 socket 的。
    // 故这里断言的是**消息体字节数逐字节相等**，头的差额在 `core/traffic/meter.ts` 里量化。
    expect(account.usage(ALICE)).toEqual({ up: 1500, down: 64 });
    // 源站侧实测也一致（证明代理没有凭空多算/少算载荷）
    expect(origin.bodyIn("updown")).toBe(1500);
    expect(origin.bodyOut("updown")).toBe(64);
    expect(exceeded()).toHaveLength(0);
  });

  it("HTTP 普通转发：零体请求不产生任何计量（GET 只有响应体计入 down）", async () => {
    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      expect((await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/n0?n=0" })).status).toBe(
        200,
      );
    });
    expect(account.usage(ALICE)).toEqual({ up: 0, down: 0 });

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      expect((await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/n1?n=777" })).got).toBe(
        777,
      );
    });
    expect(account.usage(ALICE)).toEqual({ up: 0, down: 777 });
  });

  // =========================================================================
  // 护栏 4：耗尽行为三条，各断言恰好一次
  // =========================================================================

  it("耗尽①HTTP 转发 · 响应头未发出 → 回 507 Insufficient Storage（不是 403）+ 恰好一条事件", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytesUp: 100 } }]);
    readAuthUsers({ config: testConfig, force: true });
    const body = Buffer.alloc(5000, 0x44);

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      const r = await proxyRequest(port, origin.port, ALICE, ALICE_PW, {
        method: "POST",
        path: "/exhaust",
        body,
      });
      // 配额耗尽不是权限问题：403 会诱导客户端换凭证/换身份重试，而重试对「用完了」毫无意义
      expect(r.status).toBe(507);
      expect(r.status).not.toBe(403);
    });

    const events = exceeded();
    expect(events, "一次请求只发一条").toHaveLength(1);
    expect(events[0].data).toEqual({
      user: ALICE,
      dir: "up",
      scope: "up",
      usage: 5000,
      limit: 100,
    });
    expect(events[0].context.user).toBe(ALICE);
    expect(events[0].context.requestId).toBeTruthy();
  });

  it("耗尽②HTTP 转发 · 响应头已发出 → destroy()（客户端看到中途断流）+ 恰好一条事件", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytesDown: 100 } }]);
    readAuthUsers({ config: testConfig, force: true });

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      // 源站会发 200 + content-length: 20000；配额 100B → 第一个响应体 chunk 就撞顶，
      // 此时 `res.writeHead` 早已执行 → 只能 destroy（往已开始的流里追加 507 正文即协议污染）。
      //
      // **状态行是否真的到达客户端不作断言**：Node 的 `res.destroy()` 直接销毁 socket，
      // 尚在 socket 写缓冲里的应答头会一起丢掉，于是客户端可能看到 200、也可能只看到
      // ECONNRESET —— 取决于那一轮是否已经 flush。**两条都是「硬切」的正确表现**，
      // 客户端不能依赖状态行。可断言的硬事实只有一条：**响应体被截断，绝不是一个完整的
      // 200 + 20000B 响应**（那才是「配额没生效」）。
      const r = await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/big?n=20000" });
      expect(r.aborted, "响应体中途被硬切").toBe(true);
      expect(r.got, "拿到的字节远小于 content-length").toBeLessThan(20000);
      expect(r.got === 20000 && r.status === 200, "绝不能是一个完整的 200 响应").toBe(false);
    });

    const events = exceeded();
    expect(events, "一次请求只发一条").toHaveLength(1);
    expect(events[0].data).toEqual({
      user: ALICE,
      dir: "down",
      scope: "down",
      usage: 20000,
      limit: 100,
    });
  });

  it("耗尽③CONNECT 隧道 → 直接 destroy（应答早已发出，改不了）+ 恰好一条事件", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytesDown: 100 } }]);
    readAuthUsers({ config: testConfig, force: true });

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      const payload = Buffer.alloc(8000, 0x45);
      const r = await tunnelPayload(port, raw.port, ALICE, ALICE_PW, payload);
      // 200 已发出（CONNECT 语义要求先回 200），随后传输被硬切：回声远小于请求量
      expect(r.established).toBe(true);
      expect(r.echoed).toBeLessThan(payload.length);
    });

    const events = exceeded();
    expect(events, "一次隧道只发一条").toHaveLength(1);
    expect(events[0].data).toMatchObject({ user: ALICE, dir: "down", scope: "down", limit: 100 });
    expect(events[0].context.user).toBe(ALICE);
  });

  it("耗尽④SOCKS5 隧道 → 同样硬切 + 恰好一条事件", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytesTotal: 100 } }]);
    readAuthUsers({ config: testConfig, force: true });

    await withProxy(Socks5Proxy, proxyOpts(), async (port) => {
      const sock = await tcConnect(port);
      const c = makeCollector(sock);
      sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      await c.waitFor((b) => b.length >= 2, 3000);
      sock.write(rfc1929(ALICE, ALICE_PW));
      await c.waitFor((b) => b.length >= 4, 3000);
      sock.write(socks5ConnectIpv4(TARGET_IP, raw.port));
      await c.waitFor((b) => b.length >= 14, 3000);
      // 成功应答已发（10 字节），随后传输撞顶 → 连接被 destroy，客户端再也收不到回声
      sock.write(Buffer.alloc(5000, 0x46));
      const got = await c.waitFor((b) => b.length >= 6000, 1200).catch(() => -1);
      expect(got, "SOCKS5 应答之后被硬切，收不到回声").toBe(-1);
      sock.destroy();
    });

    const events = exceeded();
    expect(events, "一次会话只发一条").toHaveLength(1);
    expect(events[0].data).toMatchObject({ user: ALICE, scope: "total", limit: 100 });
  });

  it("总用量上限：三个上限各自触发时 scope 归因正确（total 排最后）", async () => {
    writeUsers([
      { username: ALICE, password: ALICE_PW, quota: { bytesUp: 10, bytesDown: 10, bytesTotal: 50 } },
    ]);
    readAuthUsers({ config: testConfig, force: true });

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      await proxyRequest(port, origin.port, ALICE, ALICE_PW, {
        method: "POST",
        path: "/both",
        body: Buffer.alloc(40, 0x47),
      });
    });
    // up=40 > bytesUp=10 先被突破 → 归因 up（顺序即归因）
    expect(exceeded()[0].data).toMatchObject({ scope: "up", limit: 10, usage: 40 });
  });

  it("未耗尽时零发布（连续多次正常传输，一条事件都不许有）", async () => {
    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      for (let i = 0; i < 5; i++) {
        expect(
          (await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: `/ok${i}?n=100` })).status,
        ).toBe(200);
      }
    });
    expect(exceeded()).toHaveLength(0);
    expect(account.usage(ALICE).down).toBe(500);
  });

  // =========================================================================
  // 护栏 6：无鉴权 → 不计量 + usage 恒零 + 启动一条 warn
  // =========================================================================

  it("无鉴权：整体不计量（连 consume 都不会被调一次）、usage 恒零、零事件，且启动时有一条 quota-inert warn", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytesTotal: 10 } }]);
    readAuthUsers({ config: testConfig, force: true });
    set("authEnabled", false);

    // ① 传输不计量：用「记_calls 的替身账本」把「不计量」钉成可观测事实 ——
    //    只断言 usage 恒零是不够的（不调 consume 与调了但查不到配额，两者都让 usage 保持零）。
    const touched: string[] = [];
    const spy: TrafficAccount = {
      consume: (user, dir, bytes) => {
        touched.push(`${user}:${dir}:${bytes}`);
        return account.consume(user, dir, bytes);
      },
      usage: (user) => account.usage(user),
    };

    // 即使配额小到 10 字节、传输远超它，也一路放行
    await withProxy(
      HttpProxy,
      { ctx, auth: createAuthFromConfig(testConfig), traffic: spy },
      async (port) => {
        const r = await proxyRequest(port, origin.port, "", "", { path: "/noauth?n=5000" });
        expect(r.status).toBe(200);
        expect(r.got).toBe(5000);
      },
    );
    expect(touched, "无身份 → 计量层一次都不许被调用").toEqual([]);
    expect(account.usage(ALICE)).toEqual({ up: 0, down: 0 });
    expect(exceeded()).toHaveLength(0);

    // 隧道侧同样零计量
    touched.length = 0;
    await withProxy(
      Socks5Proxy,
      { ctx, auth: createAuthFromConfig(testConfig), traffic: spy },
      async (port) => {
        const sock = await tcConnect(port);
        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        await new Promise((r) => setTimeout(r, 200));
        sock.write(socks5ConnectIpv4(TARGET_IP, raw.port));
        await new Promise((r) => setTimeout(r, 300));
        sock.write(Buffer.alloc(3000, 0x4b));
        await new Promise((r) => setTimeout(r, 300));
        sock.destroy();
      },
    );
    expect(touched, "SOCKS 侧同样零计量").toEqual([]);

    // ② 启动 warn：库路径经 onWarning 旁路
    const warnings: RuntimeWarning[] = [];
    const lib = createProxyRuntime({
      config: { host: TARGET_IP, port: 1, authEnabled: false, authUsersFile: usersPath },
      logger: testLogger,
      onWarning: (w) => warnings.push(w),
    });
    runtime = lib;
    await lib.start();
    expect(warnings.filter((w) => w.code === "quota-inert")).toHaveLength(1);
  });

  it("无鉴权但没配配额：不报 quota-inert（关鉴权本身是常态，没配配额时告警就是噪音）", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW }]);
    readAuthUsers({ config: testConfig, force: true });
    set("authEnabled", false);

    const warnings: RuntimeWarning[] = [];
    const lib = createProxyRuntime({
      config: { host: TARGET_IP, port: 1, authEnabled: false, authUsersFile: usersPath },
      logger: testLogger,
      onWarning: (w) => warnings.push(w),
    });
    runtime = lib;
    await lib.start();
    expect(warnings.filter((w) => w.code === "quota-inert")).toHaveLength(0);
  });

  it("CLI 路径：quota-inert 落成一条 [quota-inert] warn 行（运维真的看得见）", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytesTotal: 10 } }]);
    readAuthUsers({ config: testConfig, force: true });
    set("authEnabled", false);

    const logger = new LoggerImpl({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const port = await getFreePort();
    set("port", port);
    const server = new ProxyServer({
      context: createConfigContext({ store: testConfigStore, configDir: dir }),
      logger,
      noColor: true,
      isWorker: true,
    });
    await server.start();
    try {
      const lines = warn.mock.calls.filter((c) => String(c[0]).startsWith("[quota-inert]"));
      expect(lines, "无鉴权 + 配了配额 → 启动必须告警").toHaveLength(1);
      expect(lines[0][0]).toContain("AUTH_ENABLED=false");
      expect(lines[0][0]).toContain("quota 整体不生效");
    } finally {
      await server.stop().catch(() => {});
    }
  });

  it("[quota-exceeded] 落盘 warn 行带 user/usage/limit/方向/上限种类（运维据此判断该扩容还是加单向上限）", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytesTotal: 100 } }]);
    readAuthUsers({ config: testConfig, force: true });

    const logger = new LoggerImpl({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const port = await getFreePort();
    set("port", port);
    const server = new ProxyServer({
      context: createConfigContext({ store: testConfigStore, configDir: dir }),
      logger,
      noColor: true,
      isWorker: true,
    });
    await server.start();
    try {
      await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/log?n=5000" });
    } finally {
      await server.stop().catch(() => {});
    }
    const lines = warn.mock.calls.filter((c) => String(c[0]).startsWith("[quota-exceeded]"));
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toBe(
      `[quota-exceeded] ${ALICE} 配额耗尽 dir=down scope=total usage=5000 limit=100`,
    );
    expect(lines[0][lines[0].length - 1]).toMatchObject({
      user: ALICE,
      dir: "down",
      scope: "total",
      usage: 5000,
      limit: 100,
    });
  });

  // =========================================================================
  // 护栏 7：身份不串号
  // =========================================================================

  it("两个用户在同一代理上各耗各的配额，互不影响（锁「user 不得取错」）", async () => {
    writeUsers([
      { username: ALICE, password: ALICE_PW, quota: { bytesDown: 100 } },
      { username: BOB, password: BOB_PW, quota: { bytesDown: 100_000 } },
    ]);
    readAuthUsers({ config: testConfig, force: true });

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      // alice 先撞顶
      const a = await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/a?n=5000" });
      expect(a.aborted).toBe(true);
      // bob 同一条代理、同一目标、同样大的流量：一路放行
      const b = await proxyRequest(port, origin.port, BOB, BOB_PW, { path: "/b?n=5000" });
      expect(b.status).toBe(200);
      expect(b.got).toBe(5000);
      expect(b.aborted).toBe(false);
    });

    expect(account.usage(ALICE)).toEqual({ up: 0, down: 5000 });
    expect(account.usage(BOB)).toEqual({ up: 0, down: 5000 });
    // 事件也只归 alice 一条
    const events = exceeded();
    expect(events).toHaveLength(1);
    const only = events[0]!;
    expect(only.data.user).toBe(ALICE);
    expect(only.context.user).toBe(ALICE);
  });

  // =========================================================================
  // 护栏 8：热加载
  // =========================================================================

  it("热加载：改 users.json 的配额越过 1s 节流后对新请求生效，且**已用量保留不清零**", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytesDown: 100_000 } }]);
    readAuthUsers({ config: testConfig, force: true });

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      expect((await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/h1?n=1000" })).status).toBe(200);
      expect(account.usage(ALICE).down).toBe(1000);

      // 收紧到 1500（高于已用 1000）→ 下一个 1000 字节的请求就该撞顶
      writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytesDown: 1500 } }]);
      await sleep(1100);

      const r = await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/h2?n=1000" });
      expect(r.aborted, "新配额对后续请求生效").toBe(true);
    });

    const events = exceeded();
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ scope: "down", limit: 1500, usage: 2000 });
    // **已用量保留不清零**（裁决）：清零等于给「重载 users.json」发了一条刷配额的路——
    // 攻击者只要反复触发热加载就能把任意大的配额一次次重置。清零的唯一正当场景是
    // 「配额窗口过期」，那是 5b 落盘时间窗要解决的问题。
    expect(account.usage(ALICE).down).toBe(2000);
  });

  // =========================================================================
  // 护栏 9：装配
  // =========================================================================

  it("注入的 TrafficAccount 原样生效（不传时用内存实现，core 侧零缺省解析）", async () => {
    // 替身账本已经在每个用例里被注入了 —— 上面所有用例的 usage 断言本身就是证据。
    // 这里再钉一条「注入的那个实例就是 core 用的那个」：伪造一个只认 alice 的替身，
    // 若 core 偷偷自己造了一份实现，bob 就会被当成不限流。
    const seen: string[] = [];
    const spy = {
      consume: (user: string, dir: "up" | "down", bytes: number) => {
        seen.push(`${user}:${dir}:${bytes}`);
        return account.consume(user, dir, bytes);
      },
      usage: (user: string) => account.usage(user),
    };
    await withProxy(
      HttpProxy,
      { ctx, auth: createAuthFromConfig(testConfig), traffic: spy },
      async (port) => {
        expect((await proxyRequest(port, origin.port, BOB, BOB_PW, { path: "/spy?n=64" })).status).toBe(
          200,
        );
      },
    );
    expect(seen.length, "core 确实调的是注入的那个实例").toBeGreaterThan(0);
    expect(seen.every((s) => s.startsWith(`${BOB}:`)), "user 不得取错").toBe(true);
  });

  it("默认解析只发生在唯一组装点：createProxyRuntime 装内存账本并落到 core，ProxyOptions.traffic 同一个实例", async () => {
    const lib = createProxyRuntime({
      config: {
        host: TARGET_IP,
        port: 1,
        authEnabled: true,
        authType: "basic",
        authUsersFile: usersPath,
      },
      logger: testLogger,
    });
    runtime = lib;
    await lib.start();
    // services 面上是内存实现（读 users.json 的 quota）
    expect(lib.services.traffic).toBe(lib.options.traffic);
    // 显式注入替身时也原样透传
    const fake: TrafficAccount = { consume: () => ({ allow: true }), usage: () => ({ up: 0, down: 0 }) };
    const lib2 = createProxyRuntime({
      config: { host: TARGET_IP, port: 1, authUsersFile: usersPath },
      services: { traffic: fake },
      logger: testLogger,
    });
    runtime = lib2;
    expect(lib2.services.traffic).toBe(fake);
    expect(lib2.options.traffic).toBe(fake);
  });

  it("直构 core 不注入 traffic → 归一成显式禁用档（不计量、不判定），不崩也不放行一切事件", async () => {
    // 与 `auth ?? new Auth({enabled:false})` 同构的既有先例：显式禁用档让「忘注入」不会变成怪问题
    await withProxy(
      HttpProxy,
      { ctx, auth: createAuthFromConfig(testConfig) },
      async (port) => {
        writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytesDown: 1 } }]);
        const r = await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/raw?n=3000" });
        expect(r.status, "禁用档下配额完全不生效").toBe(200);
        expect(r.got).toBe(3000);
      },
    );
    expect(exceeded()).toHaveLength(0);
  });
});
