/**
 * 每用户访问名单（`users.json` 的 `acl`）在**四条转发路径**上的接线护栏（Phase 4b）
 *
 * @description
 * 判定层的合并语义（3×3 真值表、闭合 `reason`、热加载、零分配）在
 * `tests/unit/user-acl-merge.test.ts`；本文件只答一个问题：**身份能不能真的流到判定里**。
 *
 * 身份只有一条链：`RequestScope.user` → `ForwarderBase.preDial` → `guardPreDial` → `checkTargetHost`。
 * 因此这里必须用**真代理 + 真鉴权 + 真 users.json** 驱动（身份来自 `createAuthFromConfig`
 * 现读同一份文件），四档各一条：
 * - HTTP 普通请求 / CONNECT / Upgrade → 403 + 恰好一条 `target-denied`（`source:"user"`）
 * - SOCKS5 → 失败应答（`05 00 …`）+ 恰好一条 `target-denied`
 *
 * 三条容易悄悄坏掉的不变式，各有一条用例：
 * - **事件恰好一条**：`http.ts` 在 client 模式下会走**两次** `preDial`（① 判有效拨号地址、
 *   ③ 判传输对端），两次都判同一个 `dest`。用例「client 模式 + SOCKS5 上游」正落在这条路径上：
 *   拒绝时恰好一条事件、**上游零建链**；放行时**零条**事件、上游真建链一次。
 * - **全局优先**：全局与个人都拒时报 `source:"global"` 那一档（运维先看自己的全局配置）。
 * - **不重启即生效**：改 users.json + 越过 1s 节流后，同一条请求从 403 变 200。
 *
 * 公共事件面（`access.target-denied`）用**真 `CoreEventBridge`** 验证仍会被发布
 * （`reason` 若被改成 `"user:blacklist"` 之类，这里会是 0 条）。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readAuthUsers } from "@/config/index.js";
import { createConfigContext } from "@/config/index.js";
import { createAuthFromConfig } from "@/core/auth.js";
import { EventHub } from "@/core/events/index.js";
import type { EventEnvelope, EventName, EventSubscription } from "@/core/events/index.js";
import type { CoreContext } from "@/core/context.js";
import { HttpProxy } from "@/core/server/http.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { LoggerImpl } from "@/utils/logger/index.js";
import { CoreEventBridge } from "@/runtime/bridge.js";
import { ProxyServer } from "@/server/index.js";
import { getFreePort, listen, sleep } from "../helpers/net.js";
import { withProxy } from "../helpers/proxy.js";
import { makeCollector, rfc1929, socks5ConnectIpv4, tcConnect } from "../helpers/socks-client.js";
import { startUpstreamStub, type UpstreamStub } from "../helpers/upstream-stub.js";
import { restoreConfig, set, silenceLogs, snapshotConfig, testConfig, testConfigStore, testLogger } from "../helpers/config.js";

/** 本文件自建一条总线（往共享测试总线上挂长期订阅会跨用例累积） */
const bus = new EventHub({ onListenerError: () => undefined });
const ctx: CoreContext = { config: testConfig, logger: testLogger, events: bus };

const ALICE = "alice";
const ALICE_PW = "pw1";
const BOB = "bob";
const BOB_PW = "pw2";

/** 目标一律是回环上的桩：个人名单条目写 IP（名单按 host 字符串匹配，IP 分支走同一份规则层） */
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
  "logLevel",
  "logFile",
] as const;

/** basic 凭证头 */
function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/**
 * 采集一次原始往返（等到对端关闭；`Connection: close` 让早失败路径也即时断开）
 * @description 兜一个 5s 上限：**万一某天该拒的没拒**，隧道会一直开着，裸等 close 会把
 * 失败推给 vitest 的 15s 全局超时（诊断信息全无）。这里超时即带现有字节收尾，断言照样红得清楚。
 */
function rawRequest(port: number, raw: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(raw);
    });
    let buf = "";
    let settled = false;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(buf);
    };
    const timer = setTimeout(done, timeoutMs);
    sock.on("data", (c: Buffer) => {
      buf += c.toString("latin1");
    });
    sock.on("close", done);
    sock.on("error", done);
  });
}

/** 经代理发一次 absolute-form GET（带 basic 凭证与 close），回 `{status}` */
function proxyGet(
  proxyPort: number,
  targetPort: number,
  user: string,
  pass: string,
  path = "/x",
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: `http://${TARGET_IP}:${targetPort}${path}`,
        headers: {
          Host: `${TARGET_IP}:${targetPort}`,
          "Proxy-Authorization": basic(user, pass),
          Connection: "close",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

/** CONNECT / Upgrade 的原始报文（Host 即客户端请求的目标） */
function connectReq(targetPort: number, user: string, pass: string): string {
  return [
    `CONNECT ${TARGET_IP}:${targetPort} HTTP/1.1`,
    `Host: ${TARGET_IP}:${targetPort}`,
    `Proxy-Authorization: ${basic(user, pass)}`,
    "",
    "",
  ].join("\r\n");
}

function upgradeReq(targetPort: number, user: string, pass: string): string {
  return [
    "GET /ws HTTP/1.1",
    `Host: ${TARGET_IP}:${targetPort}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    `Proxy-Authorization: ${basic(user, pass)}`,
    "",
    "",
  ].join("\r\n");
}

/** 等条件成立（超时抛错，不把失败推给 vitest 的全局超时） */
async function waitUntil(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 25) {
    if (cond()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`waitUntil 超时：${label}`);
}

describe("integration/user-acl-enforcement（每用户名单在四条路径上生效）", () => {
  let snap: Record<string, unknown>;
  let dir: string;
  let usersPath: string;
  let aclPath: string;
  let clock = 0;
  let origin: { port: number; hits: () => number; close: () => Promise<void> };
  let rawTarget: { port: number; bytes: () => number; close: () => Promise<void> };
  let upgradeTarget: { port: number; close: () => Promise<void> };
  let pipeEvents: PipeEvent[];
  let publicEvents: EventEnvelope<EventName>[];
  let subs: EventSubscription[] = [];
  const bridges: CoreEventBridge[] = [];
  /** 桩跨用例存活，用例内断言一律取增量 */
  let hitsBase = 0;
  let bytesBase = 0;

  /** 目标名单拒绝的 pipe 事件（core 事实本体） */
  function targetDenied(): PipeEvent[] {
    return pipeEvents.filter((e) => e.type === "target-denied");
  }

  /** 公共事件面（经真 CoreEventBridge 桥接） */
  function accessDenied(): EventEnvelope<EventName>[] {
    return publicEvents.filter((e) => e.name === "access.target-denied");
  }

  /**
   * 显式 ctx（**自建总线**）+ 配置驱动的鉴权（身份真的来自那份 users.json）
   * @description 省略 ctx 时 `withProxy` 会吃共享 `testContext`，事件就发到别人的总线上去了
   */
  function proxyOpts(): { ctx: CoreContext; auth: ReturnType<typeof createAuthFromConfig> } {
    return { ctx, auth: createAuthFromConfig(testConfig) };
  }

  /** 起一条代理，并把桥接器挂到同一条总线上（验证公共事件面真的收到了） */
  function watch(): void {
    const bridge = new CoreEventBridge({ hub: bus, protocol: "http" });
    bridge.attach(ctx);
    bridges.push(bridge);
  }

  function writeUsers(users: unknown): void {
    clock += 1000;
    fs.writeFileSync(usersPath, JSON.stringify(users));
    fs.utimesSync(usersPath, clock / 1000, clock / 1000);
  }

  /**
   * 源站命中数（**本用例内**的增量）
   * @description 桩在 `beforeAll` 建一次、跨用例存活，故裸计数会把上一条用例的命中算进来
   */
  function originHits(): number {
    return origin.hits() - hitsBase;
  }

  /** 裸 TCP 目标收到的字节数（本用例内的增量） */
  function rawBytes(): number {
    return rawTarget.bytes() - bytesBase;
  }

  /** 默认账号表：alice 禁回环、bob 圈住回环（两个方向都有对照组） */
  function defaultUsers(): unknown[] {
    return [
      { username: ALICE, password: ALICE_PW, acl: { target: { blacklist: [TARGET_IP] } } },
      { username: BOB, password: BOB_PW, acl: { target: { whitelist: [TARGET_IP] } } },
    ];
  }

  beforeAll(async () => {
    // http 源站（普通请求的真实目标）
    const hits = { n: 0 };
    const originSockets = new Set<net.Socket>();
    const originServer = http.createServer((_req, res) => {
      hits.n++;
      res.writeHead(200, { "content-type": "text/plain", "content-length": "9" });
      res.end("origin-ok");
    });
    originServer.on("connection", (s) => {
      originSockets.add(s);
      s.on("error", () => {});
      s.on("close", () => originSockets.delete(s));
    });
    const originPort = await getFreePort();
    await listen(originServer, originPort);
    origin = {
      port: originPort,
      hits: () => hits.n,
      close: () =>
        new Promise<void>((r) => {
          for (const s of originSockets) {
            s.destroy();
          }
          originServer.close(() => r());
        }),
    };

    // 裸 TCP 回显（CONNECT 隧道的对端：给 http.Server 会把隧道字节当 HTTP 解析，测到的就不是名单判定）
    const echoBytes = { n: 0 };
    const echoSockets = new Set<net.Socket>();
    const echoServer = net.createServer((s) => {
      echoSockets.add(s);
      s.on("error", () => {});
      s.on("close", () => echoSockets.delete(s));
      s.on("data", (c) => {
        echoBytes.n += c.length;
        s.write(c);
      });
    });
    const echoPort = await getFreePort();
    await listen(echoServer, echoPort);
    rawTarget = {
      port: echoPort,
      bytes: () => echoBytes.n,
      close: () =>
        new Promise<void>((r) => {
          for (const s of echoSockets) {
            s.destroy();
          }
          echoServer.close(() => r());
        }),
    };

    // 裸 TCP 101 桩（Upgrade 的对端）
    const upSockets = new Set<net.Socket>();
    const upServer = net.createServer((s) => {
      upSockets.add(s);
      s.on("error", () => {});
      s.on("close", () => upSockets.delete(s));
      s.on("data", (c) => {
        if (c.includes(Buffer.from("\r\n\r\n"))) {
          s.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
          return;
        }
        s.write(c);
      });
    });
    const upPort = await getFreePort();
    await listen(upServer, upPort);
    upgradeTarget = {
      port: upPort,
      close: () =>
        new Promise<void>((r) => {
          for (const s of upSockets) {
            s.destroy();
          }
          upServer.close(() => r());
        }),
    };
  });

  beforeEach(() => {
    snap = snapshotConfig(KEYS);
    silenceLogs();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-acl-enforce-"));
    usersPath = path.join(dir, "users.json");
    aclPath = path.join(dir, "acl.json");
    writeUsers(defaultUsers());
    // 全局名单全空：这一整份文件只验个人名单那一层
    fs.writeFileSync(aclPath, JSON.stringify({}));
    set("aclFile", aclPath);
    set("authUsersFile", usersPath);
    set("authEnabled", true);
    set("authType", "basic");
    set("authLogging", false);
    set("host", "127.0.0.1");
    // 哨兵端口：随机监听端口不会被自环守卫误判成自环
    set("port", 1);
    set("proxyMode", "server");
    // 读一次建好缓存条目（两个读取器共用 label+path）
    readAuthUsers({ config: testConfig, force: true });

    hitsBase = origin.hits();
    bytesBase = rawTarget.bytes();

    pipeEvents = [];
    publicEvents = [];
    subs = [
      bus.subscribe("pipe", (e) => {
        pipeEvents.push(e.data as PipeEvent);
      }),
    ];
    subs.push(
      bus.subscribe("access.target-denied", (e) => {
        publicEvents.push(e as EventEnvelope<EventName>);
      }),
    );
  });

  afterEach(() => {
    for (const s of subs) {
      s.dispose();
    }
    subs = [];
    for (const b of bridges.splice(0)) {
      b.subscription.dispose();
    }
    fs.rmSync(dir, { recursive: true, force: true });
    restoreConfig(snap);
  });

  afterAll(async () => {
    await origin.close();
    await rawTarget.close();
    await upgradeTarget.close();
  });

  // -------------------------------------------------------------------------
  // 护栏 6：四条路径各一条「该用户被其个人名单拒绝」
  // -------------------------------------------------------------------------

  it("HTTP 普通请求：403 + 恰好一条 target-denied(source=user) + 公共事件仍发布", async () => {
    watch();
    await withProxy(
      HttpProxy,
      proxyOpts(),
      async (port) => {
        expect(await proxyGet(port, origin.port, ALICE, ALICE_PW)).toBe(403);
      },
    );

    // 源站零字节：被拒请求根本不拨号
    expect(originHits()).toBe(0);

    const denied = targetDenied();
    expect(denied, "一次请求只发一条 target-denied").toHaveLength(1);
    expect(denied[0]).toMatchObject({
      type: "target-denied",
      host: TARGET_IP,
      reason: "blacklist",
      source: "user",
      user: ALICE,
    });

    // 公共事件面：reason 仍是闭合集合那一档（不是 "user:blacklist"——那样会是 0 条）
    const access = accessDenied();
    expect(access).toHaveLength(1);
    expect(access[0].data).toMatchObject({ host: TARGET_IP, reason: "blacklist", source: "user" });
    expect(access[0].context.user).toBe(ALICE);
  });

  it("CONNECT：403 + 恰好一条 target-denied(source=user)，目标零字节", async () => {
    watch();
    await withProxy(
      HttpProxy,
      proxyOpts(),
      async (port) => {
        const res = await rawRequest(port, connectReq(rawTarget.port, ALICE, ALICE_PW));
        expect(res.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);
      },
    );

    expect(rawBytes(), "被拒的 CONNECT 绝不建隧").toBe(0);
    const denied = targetDenied();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ source: "user", reason: "blacklist", user: ALICE });
    expect(accessDenied()).toHaveLength(1);
  });

  it("Upgrade：403 + 恰好一条 target-denied(source=user)，目标零字节", async () => {
    watch();
    await withProxy(
      HttpProxy,
      proxyOpts(),
      async (port) => {
        const res = await rawRequest(port, upgradeReq(upgradeTarget.port, ALICE, ALICE_PW));
        expect(res.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);
      },
    );

    const denied = targetDenied();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ source: "user", reason: "blacklist", user: ALICE });
    expect(accessDenied()).toHaveLength(1);
  });

  it("SOCKS5：RFC1929 鉴权后回失败应答（05 01 …）+ 恰好一条 target-denied(source=user)", async () => {
    watch();
    await withProxy(
      Socks5Proxy,
      proxyOpts(),
      async (port) => {
        const sock = await tcConnect(port);
        const c = makeCollector(sock);
        // 宣告 NOAUTH + USERPASS
        sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
        await c.waitFor((b) => b.length >= 2, 3000);
        sock.write(rfc1929(ALICE, ALICE_PW));
        await c.waitFor((b) => b.length >= 4, 3000);
        // 目标 = 回环上的 http 源站：个人名单禁的就是它
        sock.write(socks5ConnectIpv4(TARGET_IP, origin.port));
        await c.waitFor((b) => b.length >= 14, 3000);

        // 累积缓冲里依次是：greeting 方法选择（05 02）、RFC1929 应答（01 00）、CONNECT 应答（10 字节）
        const bytes = c.bytes();
        const reply = bytes.subarray(bytes.length - 10);
        // CONNECT 应答头：VER=05；REP 必须是失败档（`SOCKS5_REPLY_FAILURE` = 05 01 …，成功档是 05 00 …）
        expect(reply[0]).toBe(0x05);
        expect(reply[1]).not.toBe(0x00);
        expect(reply[1]).toBe(0x01);
        sock.destroy();
      },
    );

    expect(originHits(), "被拒的 SOCKS 会话绝不拨号").toBe(0);
    const denied = targetDenied();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ source: "user", reason: "blacklist", user: ALICE });
    expect(accessDenied()).toHaveLength(1);
  });

  it("对照组：同一个代理上 bob（个人白名单圈住该 IP）照样放行（证明拒的是「这个人」）", async () => {
    watch();
    await withProxy(
      HttpProxy,
      proxyOpts(),
      async (port) => {
        expect(await proxyGet(port, origin.port, BOB, BOB_PW)).toBe(200);
        // alice 同一条代理、同一目标：403（两条请求的差别只在身份）
        expect(await proxyGet(port, origin.port, ALICE, ALICE_PW)).toBe(403);
      },
    );

    expect(originHits()).toBe(1);
    const denied = targetDenied();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ user: ALICE, source: "user" });
  });

  // -------------------------------------------------------------------------
  // 两次 preDial：client 模式 + SOCKS5 上游（http.ts 的 peer ≠ dial 分支）
  // -------------------------------------------------------------------------

  it("client 模式 + SOCKS5 上游（两次 preDial）：拒绝时恰好一条事件且上游零建链；放行时零条事件且真建链", async () => {
    set("proxyMode", "client");
    set("upstreamProtocol", "socks5");
    set("upstreamHost", "127.0.0.1");

    // 明文承载：`upstreamProtocol: "socks5"`（不是 `sockss5`），故 secure: false
    const stub: UpstreamStub = await startUpstreamStub("socks5", { secure: false });
    set("upstreamPort", stub.port);

    try {
      watch();
      await withProxy(
        HttpProxy,
        proxyOpts(),
        async (port) => {
          // ① 第一次 preDial 就被个人名单拒 → 恰好一条事件，上游一个字节都没收到
          expect(await proxyGet(port, origin.port, ALICE, ALICE_PW, "/a")).toBe(403);
          expect(stub.connections(), "被拒请求不拨上游").toBe(0);
          expect(targetDenied()).toHaveLength(1);
          expect(targetDenied()[0]).toMatchObject({ source: "user", user: ALICE });

          // ② bob 放行：两次 preDial 都过（第二次判的是传输对端=真实目标）
          expect(await proxyGet(port, origin.port, BOB, BOB_PW, "/b")).toBe(200);
          await waitUntil(() => stub.sessions().length > 0, "上游收到 SOCKS5 会话");
          // 放行路径一条 target-denied 都不许有（两次 preDial 不得重复发事件）
          expect(targetDenied()).toHaveLength(1);
          expect(accessDenied()).toHaveLength(1);
        },
      );

      expect(originHits()).toBe(1);
    } finally {
      await stub.close();
    }
  });

  // -------------------------------------------------------------------------
  // 护栏 7：全局优先（两关都拒时报全局那一档）
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 落盘文本：`[target-denied]` 行必须看得出是哪一层拒的
  // -------------------------------------------------------------------------

  it("[target-denied] 落盘行带 source=（运维据此知道该改 acl.json 还是 users.json）", async () => {
    // 落盘 switch 装在 **ProxyServer**（进程编排层，core 零日志），故这里必须起真 server；
    // logger 必须是真 `LoggerImpl`（ProxyServer 还要用它的 notice/raw 等编排期通道），
    // 故按 `tls-client-auth.test.ts` 的做法注入 silent 实例并 spy `warn`。
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
      expect(await proxyGet(port, origin.port, ALICE, ALICE_PW)).toBe(403);
    } finally {
      // 刻意**不**在这里 mockRestore：`mockRestore` 会连带清空 `mock.calls`，
      // 而断言恰恰要读它。logger 是本用例私有的，spy 随用例一起被丢弃。
      await server.stop().catch(() => {});
    }

    const deniedLines = warn.mock.calls.filter((c) => String(c[0]).startsWith("[target-denied]"));
    expect(deniedLines).toHaveLength(1);
    // 文本契约：`[target-denied] <target> 拒绝 reason=<reason> source=<层>`
    expect(deniedLines[0][0]).toBe(
      `[target-denied] ${TARGET_IP}:${origin.port} 拒绝 reason=blacklist source=user`,
    );
    // 结构化字段同步带 source 与 user（jq 侧可查）
    const fields = deniedLines[0][deniedLines[0].length - 1] as Record<string, unknown>;
    expect(fields).toMatchObject({
      target: `${TARGET_IP}:${origin.port}`,
      host: TARGET_IP,
      reason: "blacklist",
      source: "user",
      user: ALICE,
    });
  });

  it("全局与个人名单都拒：报全局那一条（source=global）", async () => {
    // 全局也禁回环（个人名单禁的是同一个 IP，两关都拒）
    fs.writeFileSync(aclPath, JSON.stringify({ target: { blacklist: [TARGET_IP] } }));
    watch();
    await withProxy(
      HttpProxy,
      proxyOpts(),
      async (port) => {
        // 两个人都撞上全局那一关：都报 global（不是 "个人名单恰好也禁了"）
        expect(await proxyGet(port, origin.port, ALICE, ALICE_PW)).toBe(403);
        expect(await proxyGet(port, origin.port, BOB, BOB_PW)).toBe(403);
      },
    );

    const denied = targetDenied();
    expect(denied).toHaveLength(2);
    for (const e of denied) {
      expect(e).toMatchObject({ source: "global", reason: "blacklist" });
    }
    // 公共事件面同样带 global
    expect(accessDenied().map((e) => e.data)).toEqual([
      { host: TARGET_IP, target: `${TARGET_IP}:${origin.port}`, reason: "blacklist", source: "global" },
      { host: TARGET_IP, target: `${TARGET_IP}:${origin.port}`, reason: "blacklist", source: "global" },
    ]);
  });

  // -------------------------------------------------------------------------
  // 热加载：不重启即生效
  // -------------------------------------------------------------------------

  it("改 users.json 并越过 1s 节流：同一请求从 403 变 200（不重启）", async () => {
    watch();
    await withProxy(
      HttpProxy,
      proxyOpts(),
      async (port) => {
        expect(await proxyGet(port, origin.port, ALICE, ALICE_PW, "/before")).toBe(403);
        expect(originHits()).toBe(0);

        // 把 alice 的个人名单从「禁回环」改成「白名单圈住回环」
        writeUsers([
          {
            username: ALICE,
            password: ALICE_PW,
            acl: { target: { whitelist: [TARGET_IP] } },
          },
          { username: BOB, password: BOB_PW, acl: { target: { whitelist: [TARGET_IP] } } },
        ]);
        await sleep(1100);

        expect(await proxyGet(port, origin.port, ALICE, ALICE_PW, "/after")).toBe(200);
        expect(originHits()).toBe(1);
        // 整个会话只发生过那一次拒绝
        expect(targetDenied()).toHaveLength(1);
      },
    );
  });
});
