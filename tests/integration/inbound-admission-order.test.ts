import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Auth } from "@/core/auth.js";
import { EventHub } from "@/core/events/index.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { AppConfig } from "@/config/index.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import { getFreePort, listen, sleep } from "../helpers/net.js";
import { makeCollector, rfc1929, socks5ConnectIpv4, tcConnect } from "../helpers/socks-client.js";

/**
 * 入站准入的**关卡顺序**护栏（行为级，真代理 + 真名单 + 真鉴权）
 *
 * @description
 * 入站准入被收成两阶段之后，最容易出的错不是「少判一关」，而是**关卡的相对顺序悄悄变了**：
 * ① 名单必须在鉴权**之前**（被禁来源不该消耗鉴权资源，也不该让客户端有机会带凭证）；
 * ② 鉴权必须在目标名单**之前**（没有身份就没有「该用户的个人名单」可判）；
 * ③ 两阶段之间若发生拒绝，**对应的 `PipeEvent` 与终态必须已经发出去**
 * （否则日志面与 `request.rejected` 会凭空少一条，而请求确实被拒了）。
 *
 * SOCKS 与 HTTP 的**唯一结构差异**是「握手夹在第 ① 与第 ② 关之间」——这正是不能把它写成
 * 「一函数走完三关」的原因。本档把这个差异**钉成可观测的顺序**：
 * 客户端**还没看到握手应答字节**（`05 02` = 选定 USER_PASS）之前，代理**不许**发出 `auth.decided`。
 * 那条断言是可证伪的：把鉴权提到握手之前（或者干脆把握手从流程里拿掉），它立刻变红。
 *
 * 观测手段：一条**专属** `EventHub`，把 `pipe` / `auth.decided` / `request.rejected` /
 * `access.client-denied` / `access.target-denied` 按**发生顺序**记成一条时间线。
 */

interface Mark {
  name: string;
  detail?: unknown;
}

const runtimes: ProxyRuntime[] = [];
const origins: { server: http.Server; port: number }[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop().catch(() => undefined);
  }
  for (const origin of origins.splice(0)) {
    await new Promise<void>((r) => {
      origin.server.closeAllConnections?.();
      origin.server.close(() => r());
    });
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeAcl(acl: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-admission-acl-"));
  tempDirs.push(dir);
  const file = path.join(dir, "acl.json");
  fs.writeFileSync(file, JSON.stringify(acl));
  return file;
}

async function startOrigin(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("origin-ok");
  });
  const port = await getFreePort();
  await listen(server, port);
  const origin = { server, port };
  origins.push(origin);
  return origin;
}

/** 起一个真 runtime + 一条专属事件总线，把准入相关事实按发生顺序记成时间线 */
async function startProxy(
  config: Partial<AppConfig>,
  services?: { auth?: Auth },
): Promise<{ port: number; marks: Mark[]; events: EventHub }> {
  const port = await getFreePort();
  const events = new EventHub({ onListenerError: () => undefined });
  const marks: Mark[] = [];
  events.subscribe("pipe", (e) => {
    marks.push({ name: `pipe:${(e.data as { type: string }).type}` });
  });
  events.subscribe("auth.decided", (e) => {
    marks.push({ name: "auth.decided", detail: (e.data as { passed: boolean }).passed });
  });
  events.subscribe("access.client-denied", () => {
    marks.push({ name: "access.client-denied" });
  });
  events.subscribe("access.target-denied", () => {
    marks.push({ name: "access.target-denied" });
  });
  events.subscribe("request.rejected", (e) => {
    marks.push({
      name: "request.rejected",
      detail: `${(e.data as { stage: string }).stage}/${(e.data as { status?: number }).status ?? "-"}`,
    });
  });
  const runtime = createProxyRuntime({
    config: {
      host: "127.0.0.1",
      port,
      authEnabled: false,
      aclFile: path.join(os.tmpdir(), `proxy-admission-missing-${process.pid}-${port}.json`),
      ...config,
    },
    events,
    ...(services !== undefined ? { services } : {}),
  });
  runtimes.push(runtime);
  await runtime.start();
  return { port, marks, events };
}

const timeline = (marks: Mark[]): string[] => marks.map((m) => m.name);
const authDecided = (marks: Mark[]): Mark[] => marks.filter((m) => m.name === "auth.decided");

/** 明文 HTTP 请求（absolute-form），可选带 Basic 凭证 */
function httpViaProxy(
  port: number,
  targetPort: number,
  credentials?: { user: string; pass: string },
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${targetPort}` };
    if (credentials) {
      headers["Proxy-Authorization"] =
        `Basic ${Buffer.from(`${credentials.user}:${credentials.pass}`).toString("base64")}`;
    }
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: `http://127.0.0.1:${targetPort}/ok`, headers },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const ACCOUNT = { username: "alice", password: "secret" };
const CREDS = { user: ACCOUNT.username, pass: ACCOUNT.password };

/**
 * 真 `Auth`（basic），**必须开 `enableLogging`**：审计事件是经 `AuthContext.onAuthEvent`
 * 上抛、再由 `BaseProxy.authorize` 转成公共 `auth.decided` 的——关掉它就等于把
 * 「鉴权发生过」这条事实从事件面上抹掉，本档要观察的正是那条事实。
 */
function basicAuth(): Auth {
  return new Auth({
    enabled: true,
    type: "basic",
    accounts: [ACCOUNT],
    enableLogging: true,
  });
}

describe("HTTP 入站准入：三关顺序与事件逐条锁死", () => {
  it("① 名单拒（**开着鉴权**）→ 恰好一条 ip-denied + 一个 access/403 终态，**零条鉴权事件**", async () => {
    const origin = await startOrigin();
    // ⚠️ 必须 `authEnabled: true` + 注入真 `Auth`：关鉴权时 `Auth` 直接放行且**不发审计事件**，
    // 那样的时间线里根本没有 `auth.decided` 这条可观测的「鉴权发生过」的痕迹——
    // 于是「把名单判定挪到鉴权之后」这种顺序反转在测试里**完全看不出来**（已实测：会假绿）。
    // 开着鉴权、并**带上正确凭证**（最强的形态：连可用凭证都不许被消耗）才测得出顺序。
    const { port, marks } = await startProxy(
      { authEnabled: true, aclFile: writeAcl({ clientIp: { blacklist: ["127.0.0.1"] } }) },
      { auth: basicAuth() },
    );

    const res = await httpViaProxy(port, origin.port, CREDS);
    await sleep(40);

    expect(res.status).toBe(403);
    expect(timeline(marks)).toEqual(["pipe:ip-denied", "access.client-denied", "request.rejected"]);
    expect(marks.at(-1)?.detail).toBe("access/403");
    expect(authDecided(marks), "被禁来源不得进入鉴权（连正确凭证都不许被消费）").toEqual([]);
  });

  it("② 鉴权拒 → 零条 ip-denied、恰好一条 auth.decided(false) + 一个 auth/407 终态", async () => {
    const origin = await startOrigin();
    const { port, marks } = await startProxy({ authEnabled: true }, { auth: basicAuth() });

    const res = await httpViaProxy(port, origin.port, { user: "alice", pass: "wrong" });
    await sleep(40);

    expect(res.status).toBe(407);
    expect(timeline(marks)).toEqual(["auth.decided", "request.rejected"]);
    expect(authDecided(marks).map((m) => m.detail)).toEqual([false]);
    expect(marks.at(-1)?.detail).toBe("auth/407");
  });

  it("③ 目标名单拒 → 鉴权在**前**、target-denied 在后（先有身份才判得了个人名单）", async () => {
    const origin = await startOrigin();
    const { port, marks } = await startProxy(
      { authEnabled: true, aclFile: writeAcl({ target: { blacklist: ["127.0.0.1"] } }) },
      { auth: basicAuth() },
    );

    const res = await httpViaProxy(port, origin.port, CREDS);
    await sleep(40);

    expect(res.status).toBe(403);
    expect(timeline(marks)).toEqual([
      "auth.decided",
      "pipe:target-denied",
      "access.target-denied",
      "request.rejected",
    ]);
    expect(authDecided(marks).map((m) => m.detail)).toEqual([true]);
    expect(marks.at(-1)?.detail).toBe("access/403");
  });

  it("鉴权拒时目标名单**根本没被问**（顺序反了的直接后果）", async () => {
    const origin = await startOrigin();
    const { port, marks } = await startProxy(
      { authEnabled: true, aclFile: writeAcl({ target: { blacklist: ["127.0.0.1"] } }) },
      { auth: basicAuth() },
    );

    const res = await httpViaProxy(port, origin.port, { user: "alice", pass: "wrong" });
    await sleep(40);

    expect(res.status).toBe(407);
    expect(timeline(marks)).toEqual(["auth.decided", "request.rejected"]);
    expect(timeline(marks), "鉴权没过就不许出现任何 target-denied").not.toContain("pipe:target-denied");
  });

  it("三关全过：鉴权 → 目标放行 → 转发（终态是 completed 而非 rejected）", async () => {
    const origin = await startOrigin();
    const { port, marks, events } = await startProxy(
      { authEnabled: true, aclFile: writeAcl({ clientIp: { whitelist: ["127.0.0.1"] } }) },
      { auth: basicAuth() },
    );
    const terminals: string[] = [];
    events.subscribe("request.completed", () => terminals.push("completed"));

    const res = await httpViaProxy(port, origin.port, CREDS);
    await sleep(40);

    expect(res.status).toBe(200);
    expect(timeline(marks)).toEqual(["auth.decided"]);
    expect(terminals).toEqual(["completed"]);
  });
});

/** SOCKS5：只发 greeting，等代理选定鉴权方法（`05 02` = 选 USER_PASS） */
async function socks5Greeting(port: number): Promise<{ socket: net.Socket; collector: ReturnType<typeof makeCollector> }> {
  const socket = await tcConnect(port);
  const collector = makeCollector(socket);
  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  await collector.waitFor((b) => b.length >= 2);
  return { socket, collector };
}

describe("SOCKS5 入站准入：握手夹在第 ① 与第 ② 关之间（与 HTTP 的唯一结构差异）", () => {
  it("① 名单拒（**开着鉴权**）→ 握手之前就断流：零字节应答 + access 终态，零条鉴权事件", async () => {
    const origin = await startOrigin();
    // 同 HTTP 侧那条：必须开着鉴权，否则 `Auth` 静默放行、`auth.decided` 根本不出现，
    // 「把名单判定挪到鉴权之后」就测不出来（实测假绿）
    const { port, marks } = await startProxy(
      {
        proxyProtocol: "socks5",
        authEnabled: true,
        aclFile: writeAcl({ clientIp: { blacklist: ["127.0.0.1"] } }),
      },
      { auth: basicAuth() },
    );

    const socket = await tcConnect(port);
    const collector = makeCollector(socket);
    // 客户端照常发 greeting：代理**不应**回任何字节（握手尚未开始就已被拒）
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    const got = await collector.waitClose(1500).catch(() => collector.bytes());
    await sleep(40);
    socket.destroy();

    expect(got.length, "被禁来源不得收到任何握手应答字节").toBe(0);
    expect(timeline(marks)).toEqual(["pipe:ip-denied", "access.client-denied", "request.rejected"]);
    expect(marks.at(-1)?.detail).toBe("access/-");
    expect(authDecided(marks), "握手都没开始，不得进入鉴权").toEqual([]);
    expect(origin.port).toBeGreaterThan(0);
  });

  it("握手应答字节先于鉴权出现（客户端看到 `05 02` 时 `auth.decided` 仍是 0 条）", async () => {
    const { port, marks } = await startProxy({ proxyProtocol: "socks5", authEnabled: true }, { auth: basicAuth() });

    const socket = await tcConnect(port);
    const collector = makeCollector(socket);
    let authMarksWhenSelectArrived: Mark[] = [];
    socket.on("data", () => {
      if (collector.bytes().length >= 2 && authMarksWhenSelectArrived.length === 0 && authDecided(marks).length > 0) {
        authMarksWhenSelectArrived = authDecided(marks);
      }
    });
    socket.write(Buffer.from([0x05, 0x01, 0x02]));
    const select = await collector.waitFor((b) => b.length >= 2);

    // 这一刻就是「握手已推进、鉴权尚未开始」的可观测窗口
    expect([...select.subarray(0, 2)]).toEqual([0x05, 0x02]);
    expect(authDecided(marks), "鉴权必须等握手把凭证载体准备好之后才发生").toEqual([]);
    expect(authMarksWhenSelectArrived).toEqual([]);

    socket.destroy();
  });

  it("② 鉴权拒（RFC1929 错密码）→ 零条 ip-denied、一条 auth.decided(false) + auth 终态", async () => {
    const origin = await startOrigin();
    const { port, marks } = await startProxy({ proxyProtocol: "socks5", authEnabled: true }, { auth: basicAuth() });

    const { socket, collector } = await socks5Greeting(port);
    socket.write(rfc1929(ACCOUNT.username, "wrong"));
    await collector.waitFor((b) => b.length >= 4);
    await sleep(40);
    const bytes = collector.bytes();
    socket.destroy();

    // 代理回 SOCKS 鉴权失败应答（`01 01`），不回 HTTP 407 报文
    expect([...bytes.subarray(2, 4)]).toEqual([0x01, 0x01]);
    expect(timeline(marks)).toEqual(["auth.decided", "request.rejected"]);
    expect(authDecided(marks).map((m) => m.detail)).toEqual([false]);
    expect(marks.at(-1)?.detail).toBe("auth/-");
    expect(origin.port).toBeGreaterThan(0);
  });

  it("③ 目标名单拒 → 鉴权在前、target-denied 在后，CONNECT 应答仍是 SOCKS 二进制（`05 01`）", async () => {
    const origin = await startOrigin();
    const { port, marks } = await startProxy(
      {
        proxyProtocol: "socks5",
        authEnabled: true,
        aclFile: writeAcl({ target: { blacklist: ["127.0.0.1"] } }),
      },
      { auth: basicAuth() },
    );

    const socket = await tcConnect(port);
    const collector = makeCollector(socket);
    socket.write(Buffer.from([0x05, 0x01, 0x02]));
    await collector.waitFor((b) => b.length >= 2);
    socket.write(rfc1929(ACCOUNT.username, ACCOUNT.password));
    await collector.waitFor((b) => b.length >= 4);
    socket.write(socks5ConnectIpv4("127.0.0.1", origin.port));
    await collector.waitFor((b) => b.length >= 10);
    await sleep(40);
    socket.destroy();

    expect(timeline(marks)).toEqual([
      "auth.decided",
      // `pipe:socks` 是会话处理器解析完 CONNECT 包发的那条内部事实（只在 SOCKS 侧有）；
      // 它排在 `target-denied` **之前** = 目标名单仍是在解析出目标之后才判的
      "pipe:socks",
      "pipe:target-denied",
      "access.target-denied",
      "request.rejected",
    ]);
    expect(authDecided(marks).map((m) => m.detail)).toEqual([true]);
    const connectReply = collector.bytes().subarray(4, 10);
    expect(connectReply[0], "SOCKS 应答首字节恒为 0x05（回 HTTP 报文会污染协议）").toBe(0x05);
    expect(connectReply[1], "REP 必须是失败（0x01），不是 0x00").toBe(0x01);
  });

  it("鉴权拒时目标名单根本没被问（SOCKS 侧同样如此）", async () => {
    const origin = await startOrigin();
    const { port, marks } = await startProxy(
      {
        proxyProtocol: "socks5",
        authEnabled: true,
        aclFile: writeAcl({ target: { blacklist: ["127.0.0.1"] } }),
      },
      { auth: basicAuth() },
    );

    const socket = await tcConnect(port);
    const collector = makeCollector(socket);
    socket.write(Buffer.from([0x05, 0x01, 0x02]));
    await collector.waitFor((b) => b.length >= 2);
    socket.write(rfc1929(ACCOUNT.username, "wrong"));
    await sleep(60);
    socket.destroy();

    expect(timeline(marks)).toEqual(["auth.decided", "request.rejected"]);
    expect(timeline(marks)).not.toContain("pipe:target-denied");
    expect(origin.port).toBeGreaterThan(0);
  });
});
