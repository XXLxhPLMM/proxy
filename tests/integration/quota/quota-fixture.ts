/**
 * `metering` / `exhaustion` / `inert-and-assembly` 三档共用的装配面：自建事件总线、临时
 * `users.json` / `acl.json`、三个目标桩（HTTP 源站 / 裸 TCP 回显 / 裸 TCP 101）与四组 hook。
 *
 * @description
 * 档级不变量（计量落点的六条路径、耗尽 = 硬切、`quota-inert` 那条裁决、与 `tests/unit/` 的分工）
 * 归 `./AGENTS.md`，本模块只提供三档共用的那一套符号与 hook。
 *
 * ⚠️ **刻意住在 `tests/integration/quota/` 而不是 `tests/helpers/`**：`external-network-scan.ts`
 * 的 `SCAN_DIRS` 排除 `helpers/`，而 `walk()` 收目录下**全部** `.ts` —— 搬进 `helpers/`
 * 等于让这里这一部分覆盖从零外网扫描里**静默消失**（`no-external-network.test.ts` 的两条
 * 下界断言照样绿）。
 *
 * @module tests/integration/quota
 */
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { accountLocatorFor } from "@/config/index.js";
import { loadUserQuota, readAuthUsers } from "@/datasource/users/index.js";
import { createIdentityFromConfig } from "@/core/identity.js";
import type { CoreContext } from "@/core/context.js";
import { EventHub } from "@/core/events/index.js";
import type { EventEnvelope, EventSubscription } from "@/core/events/index.js";
import type { UsageAccount } from "@/datasource/quota/index.js";
import type { IdentityProvider } from "@/core/types/identity.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import { getFreePort, listen } from "../../helpers/net.js";
import {
  restoreConfig,
  set,
  silenceLogs,
  snapshotConfig,
  testConfig,
  testLogger,
} from "../../helpers/config.js";

/** 本档自建一条总线（往共享测试总线上挂长期订阅会跨用例累积） */
const bus = new EventHub({ onListenerError: () => undefined });
export const ctx: CoreContext = { config: testConfig, logger: testLogger, events: bus };

export const ALICE = "alice";
export const ALICE_PW = "pw1";
export const BOB = "bob";
export const BOB_PW = "pw2";
export const TARGET_IP = "127.0.0.1";

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
  // 耗尽⑤要把拨号超时压到 400ms（给「修复前那条假的上游超时」留出现窗口）
  "upstreamTimeout",
  // 账本目录**必须**逐例隔离（见 beforeEach 的注释），故进快照表随 restoreConfig 复原
  "quotaUsageDir",
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

/** Upgrade 的对端观测面：握手请求次数 + 「握手头之后」收到的载荷字节数 */
interface UpgradeTarget {
  port: number;
  /** 见到过完整 Upgrade 握手头的次数（防「请求压根没到上游」的假绿） */
  requests: () => number;
  /** Upgrade 握手头**之后**收到的字节数（= 建隧后的首批载荷，不含握手报文本身） */
  payloadBytes: () => number;
  close: () => Promise<void>;
}

/** 经代理发一次 absolute-form 请求；返回状态码与客户端实测收到的响应体字节数 */
export function proxyRequest(
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
export function tunnelPayload(
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
export function tunnelPipelinedHead(
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

/**
 * **Upgrade 首批载荷（`head`）路径**：Upgrade 请求头与载荷在**同一次写**里发出
 *
 * @description
 * 与 {@link tunnelPipelinedHead} 同一个道理，但落点不同：Node 的解析器把「请求头之后的
 * 字节」摘进 `upgrade` 事件的 `head`，它们**不再触发 socket 的 `data` 事件**，故
 * `upgrade.ts:upgradeOver` 必须经 `meter.charge("up", …)` 显式补记**并判 `allow`**
 * （那里是本通道自己的 `upstream.write(head)`，不经 `bridgeWithBuffered` 的判定）。
 *
 * 分两次写走的是 `data` 事件（被 `meterStream` 拦），覆盖不到这条路径。
 * @returns 客户端实际收到的字节数 + 连接是否被拆掉（`true` = 对端 destroy，不是本地超时）
 */
export function upgradeWithHead(
  port: number,
  targetPort: number,
  user: string,
  pass: string,
  payload: Buffer,
): Promise<{ got: number; closed: boolean }> {
  return new Promise((resolve) => {
    const sock = net.connect(port, TARGET_IP, () => {
      // 握手头 + 载荷，一次写完 → 后半段成为 `head`
      sock.write(
        [
          "GET /ws HTTP/1.1",
          `Host: ${TARGET_IP}:${targetPort}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          `Proxy-Authorization: ${basic(user, pass)}`,
          "",
          "",
        ].join("\r\n") + payload.toString("latin1"),
      );
    });
    let got = 0;
    const done = (closed: boolean): void => {
      clearTimeout(timer);
      sock.destroy();
      resolve({ got, closed });
    };
    // 兜底预算：不给「代理既不写也不断」的挂死留任何机会（挂死会被推给 vitest 的 15s 全局超时）
    const timer = setTimeout(() => done(false), 5000);
    sock.on("data", (c: Buffer) => {
      got += c.length;
    });
    // ECONNRESET 是**预期**结果（硬切就是直接 destroy 客户端那条流）
    sock.on("error", () => done(true));
    sock.on("close", () => done(true));
  });
}


let snap: Record<string, unknown>;
export let dir: string;
export let usersPath: string;
let aclPath: string;
let clock = 0;
export let origin: Origin;
export let raw: RawEcho;
export let upgradeTarget: UpgradeTarget;
let quotaEvents: EventEnvelope<"usage.quota-exceeded">[];
export let pipeEvents: PipeEvent[];
let subs: EventSubscription[] = [];
/** 注入的替身账本（每个用例一份，故 usage 互不干扰） */
export let account: UsageAccount;
let runtime: ProxyRuntime | undefined;

export function exceeded(): EventEnvelope<"usage.quota-exceeded">[] {
  return quotaEvents.filter((e) => e.name === "usage.quota-exceeded");
}

/** 显式 ctx（自建总线）+ 配置驱动的身份（身份真的来自那份 users.json） */
export function proxyOpts(): {
  ctx: CoreContext;
  identity: IdentityProvider;
  traffic: UsageAccount;
} {
  // `createIdentityFromConfig` 收整个 ctx（不是裸 accessor）：`isOwnCredential` 跑在出站
  // 剥离热路径上，构造期持有三件套比逐方法传参便宜，且账号文件的缺省观察面要用 ctx.logger
  return { ctx, identity: createIdentityFromConfig(ctx), traffic: account };
}

export function writeUsers(users: unknown): void {
  clock += 1000;
  fs.writeFileSync(usersPath, JSON.stringify(users));
  fs.utimesSync(usersPath, clock / 1000, clock / 1000);
}

/**
 * 登记一条由档自己起的 runtime，供 `afterEach` 停机。
 *
 * @description
 * `runtime` 必须**由档**赋值（`inert-and-assembly` 那两档的库路径用例直构 `createProxyRuntime`），
 * 而 ESM 的 import 绑定是只读的 —— 模块级 `export let runtime` 档里写不进去。故给它一个 setter，
 * 其余只读状态一律直接 `export let`。
 */
export function adoptRuntime(next: ProxyRuntime | undefined): void {
  runtime = next;
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

  // 裸 TCP 101 桩（Upgrade 的对端）：**逐连接**找 `CRLFCRLF`，其后的一切都算「载荷」。
  // 为什么必须逐连接切：代理把 Upgrade 握手报文与 `head` 分成两次 `write`，
  // TCP 完全可能把两次写合并成一个 chunk —— 只有「累积到 `\r\n\r\n` 之后按余量算」
  // 才不会把合并与不合并两种形态判成同一个数。
  const upSockets = new Set<net.Socket>();
  let upRequests = 0;
  let upPayload = 0;
  const HEAD_END = Buffer.from("\r\n\r\n");
  const upServer = net.createServer((s) => {
    upSockets.add(s);
    let pending = Buffer.alloc(0);
    let seenHead = false;
    s.on("error", () => {});
    s.on("close", () => upSockets.delete(s));
    s.on("data", (c: Buffer) => {
      if (seenHead) {
        upPayload += c.length;
        return;
      }
      pending = Buffer.concat([pending, c]);
      const at = pending.indexOf(HEAD_END);
      if (at < 0) {
        return;
      }
      seenHead = true;
      upRequests++;
      upPayload += pending.length - (at + HEAD_END.length);
      pending = Buffer.alloc(0);
      // 只在见到握手头时回一次 101（回多次会让对端多收字节，混淆「谁写了什么」的判读）
      s.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
    });
  });
  const upPort = await getFreePort();
  await listen(upServer, upPort);
  upgradeTarget = {
    port: upPort,
    requests: () => upRequests,
    payloadBytes: () => upPayload,
    close: () =>
      new Promise<void>((r) => {
        for (const s of upSockets) {
          s.destroy();
        }
        upServer.close(() => r());
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
    { username: ALICE, password: ALICE_PW, quota: { bytes: 0 } },
    { username: BOB, password: BOB_PW },
  ]);
  fs.writeFileSync(aclPath, JSON.stringify({}));
  set("aclFile", aclPath);
  set("authUsersFile", usersPath);
  // **账本目录逐例隔离**：用量是**持久**的，共享一个目录会让上一条用例
  // 烧掉的额度漏进下一条。实测症状：某条断言 `[quota-exceeded] … usage=5000` 变成
  // `usage=15000`（前两条用例的用量被恢复进来了），而且**时序相关**（上一条 runtime 的
  // 停机落盘有没有赶上本条 start），表现为「时红时绿」——最难查的那种污染。
  // 根因是真实的、正当的行为：账本按设计跨进程存活，测试就必须像隔离 `logFile` 那样隔离它。
  set("quotaUsageDir", path.join(dir, "usage"));
  set("authEnabled", true);
  set("authType", "basic");
  set("authLogging", false);
  set("host", TARGET_IP);
  set("port", 1);
  set("proxyMode", "server");
  readAuthUsers({ locator: accountLocatorFor(testConfig), force: true });

  // 替身账本：直接消费同一份 users.json 的 quota（与默认实现同一条读取路径）
  const { createUsageMirror } = await import("@/datasource/quota/index.js");
  account = createUsageMirror((user) => loadUserQuota(user, accountLocatorFor(testConfig)));

  quotaEvents = [];
  pipeEvents = [];
  subs = [
    bus.subscribe("usage.quota-exceeded", (e) => quotaEvents.push(e)),
    // pipe 事件面也要看得见：耗尽的**唯一**事实应当是那一条 quota-exceeded，
    // 「上游超时 / 上游错误」这类事实一旦出现就是凭空补的（护栏在耗尽⑤）
    bus.subscribe("pipe", (e) => pipeEvents.push(e.data)),
  ];
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
  await upgradeTarget.close();
});
