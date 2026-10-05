/**
 * 两档 `user-*` 共用的装配面：自建事件总线、临时 `users.json` / `acl.json`、四个目标桩与四组 hook。
 *
 * @description
 * 档级不变量（身份链只有一条、事件恰好一条、全局优先、不重启即生效、与 `tests/unit/` 那一层的分工）
 * 归 `./AGENTS.md`，本模块只提供两档共用的那一套符号与 hook。
 *
 * ⚠️ **刻意住在 `tests/integration/acl/` 而不是 `tests/helpers/`**：`external-network-scan.ts`
 * 的 `SCAN_DIRS` 排除 `helpers/`，而 `walk()` 收目录下**全部** `.ts` —— 搬进 `helpers/`
 * 等于让这里这一部分覆盖从零外网扫描里**静默消失**（`no-external-network.test.ts` 的两条
 * 下界断言照样绿）。
 *
 * @module tests/integration/acl
 */
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { accountLocatorFor } from "@/config/index.js";
import { readAuthUsers } from "@/datasource/users/index.js";
import { createIdentityFromConfig } from "@/core/identity.js";
import { createFileAccessControl } from "@/core/access-control.js";
import { EventHub } from "@/core/events/index.js";
import type { EventEnvelope, EventName, EventSubscription } from "@/core/events/index.js";
import type { CoreContext } from "@/core/context.js";
import type { IdentityProvider } from "@/core/types/identity.js";
import type { AccessControl, PipeEvent } from "@/core/types/proxy.js";
import { CoreEventBridge } from "@/runtime/bridge.js";
import { getFreePort, listen, sleep } from "../../helpers/net.js";
import {
  restoreConfig,
  set,
  silenceLogs,
  snapshotConfig,
  testConfig,
  testLogger,
} from "../../helpers/config.js";

/** 本文件自建一条总线（往共享测试总线上挂长期订阅会跨用例累积） */
const bus = new EventHub({ onListenerError: () => undefined });
const ctx: CoreContext = { config: testConfig, logger: testLogger, events: bus };

export const ALICE = "alice";
export const ALICE_PW = "pw1";
export const BOB = "bob";
export const BOB_PW = "pw2";

/** 目标一律是回环上的桩：个人名单条目写 IP（名单按 host 字符串匹配，IP 分支走同一份规则层） */
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
  "logLevel",
  "logFile",
] as const;

/** 本档的临时目录与两份名单文件：`beforeEach` 建、`afterEach` 删 */
export let dir = "";
export let usersPath = "";
export let aclPath = "";

let snap: Record<string, unknown>;
let clock = 0;
let pipeEvents: PipeEvent[] = [];
let publicEvents: EventEnvelope<EventName>[] = [];
let subs: EventSubscription[] = [];
const bridges: CoreEventBridge[] = [];

export let origin: { port: number; hits: () => number; close: () => Promise<void> };
export let rawTarget: { port: number; bytes: () => number; close: () => Promise<void> };
export let upgradeTarget: { port: number; close: () => Promise<void> };

/** 桩跨用例存活，用例内断言一律取增量 */
let hitsBase = 0;
let bytesBase = 0;

/** basic 凭证头 */
function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/**
 * 采集一次原始往返（等到对端关闭；`Connection: close` 让早失败路径也即时断开）
 * @description 兜一个 5s 上限：**万一某天该拒的没拒**，隧道会一直开着，裸等 close 会把
 * 失败推给 vitest 的 15s 全局超时（诊断信息全无）。这里超时即带现有字节收尾，断言照样红得清楚。
 */
export function rawRequest(port: number, raw: string, timeoutMs = 5000): Promise<string> {
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
export function proxyGet(
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
export function connectReq(targetPort: number, user: string, pass: string): string {
  return [
    `CONNECT ${TARGET_IP}:${targetPort} HTTP/1.1`,
    `Host: ${TARGET_IP}:${targetPort}`,
    `Proxy-Authorization: ${basic(user, pass)}`,
    "",
    "",
  ].join("\r\n");
}

export function upgradeReq(targetPort: number, user: string, pass: string): string {
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
export async function waitUntil(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 25) {
    if (cond()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`waitUntil 超时：${label}`);
}

/** 目标名单拒绝的 pipe 事件（core 事实本体） */
export function targetDenied(): PipeEvent[] {
  return pipeEvents.filter((e) => e.type === "target-denied");
}

/** 公共事件面（经真 CoreEventBridge 桥接） */
export function accessDenied(): EventEnvelope<EventName>[] {
  return publicEvents.filter((e) => e.name === "access.target-denied");
}

/**
 * 显式 ctx（**自建总线**）+ 配置驱动的身份（身份真的来自那份 users.json）
 * @description 省略 ctx 时 `withProxy` 会吃共享 `testContext`，事件就发到别人的总线上去了
 */
export function proxyOpts(): {
  ctx: CoreContext;
  identity: IdentityProvider;
  access: AccessControl;
} {
  // 收整个 ctx 而非裸 accessor：`isOwnCredential` 在出站剥离热路径上逐请求调用，
  // 构造期持有三件套是端口的既定形状（账号文件的缺省观察面要用 ctx.logger）
  //
  // `access` 必须显式注入真名单判定：`ProxyOptions.access` 必填、core 侧零缺省解析
  // （文件驱动实现只在唯一组装根 `createProxyRuntime` 解析）。
  // 漏掉它 = 本目录要验的「每用户名单在四条路径上生效」整条消失（全部 200）。
  return { ctx, identity: createIdentityFromConfig(ctx), access: createFileAccessControl(ctx.config) };
}

/** 起一条代理，并把桥接器挂到同一条总线上（验证公共事件面真的收到了） */
export function watch(): void {
  const bridge = new CoreEventBridge({ hub: bus, protocol: "http" });
  bridge.attach(ctx);
  bridges.push(bridge);
}

export function writeUsers(users: unknown): void {
  clock += 1000;
  fs.writeFileSync(usersPath, JSON.stringify(users));
  fs.utimesSync(usersPath, clock / 1000, clock / 1000);
}

/**
 * 源站命中数（**本用例内**的增量）
 * @description 桩在 `beforeAll` 建一次、跨用例存活，故裸计数会把上一条用例的命中算进来
 */
export function originHits(): number {
  return origin.hits() - hitsBase;
}

/** 裸 TCP 目标收到的字节数（本用例内的增量） */
export function rawBytes(): number {
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
  readAuthUsers({ locator: accountLocatorFor(testConfig), force: true });

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