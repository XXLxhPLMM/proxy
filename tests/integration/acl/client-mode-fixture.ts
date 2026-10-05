/**
 * 两档 client 模式共用的装配面：配置快照、临时 `acl.json`、上游桩、client / server 两种起法。
 *
 * @description
 * 档级不变量（判定对象永远是客户端请求的目标、上游不受名单约束、`ProxyOptions.access`
 * 必填而直构 core 必须显式注入）归 `./AGENTS.md`，本模块只提供两档共用的那一套符号与 hook。
 *
 * ⚠️ **刻意住在 `tests/integration/acl/` 而不是 `tests/helpers/`**：`external-network-scan.ts`
 * 的 `SCAN_DIRS` 排除 `helpers/`，而 `walk()` 收目录下**全部** `.ts` —— 搬进 `helpers/`
 * 等于让这里这一部分覆盖从零外网扫描里**静默消失**（`no-external-network.test.ts` 的两条
 * 下界断言照样绿）。
 *
 * @module tests/integration/acl
 */
import { afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readAcl } from "@/datasource/acl/index.js";
import { aclLocatorFor } from "@/config/index.js";
import type { ConfigKey } from "@/config/index.js";
import { HttpProxy } from "@/core/server/http.js";
import { createFileAccessControl } from "@/core/access-control.js";
import { getFreePort, listen } from "../../helpers/net.js";
import { withProxy } from "../../helpers/proxy.js";
import {
  restoreConfig,
  set,
  silenceLogs,
  snapshotConfig,
  testConfig,
  testContext,
} from "../../helpers/config.js";

const KEYS: readonly ConfigKey[] = [
  "aclFile",
  "proxyMode",
  "upstreamProtocol",
  "upstreamHost",
  "upstreamPort",
  "authEnabled",
  "authType",
  "logLevel",
  "logFile",
];

let snap: Record<string, unknown>;
let dir = "";
let aclPath = "";
let upstream: http.Server;
let upstreamPort: number;

/** 外层 upstream 桩的三个观测面：命中数 / Upgrade 握手 Host / CONNECT request-target */
export let upstreamHits = 0;
export let upgradeHosts: string[] = [];
/** 上游桩收到的 CONNECT request-target（判「CONNECT 通道有没有真去拨上游」） */
export let upstreamConnects: string[] = [];

/** 文件驱动的访问控制（直构 core 时必须显式注入的理由见 `./AGENTS.md`） */
const fileAccess = createFileAccessControl(testContext.config);

/** 采集一次原始往返（给整段原始报文，Upgrade 与普通请求共用；不加任何额外头） */
export function rawRequest(port: number, raw: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(raw);
    });
    let buf = "";
    sock.on("data", (c: Buffer) => {
      buf += c.toString();
    });
    sock.on("close", () => resolve(buf));
    sock.on("error", () => {
      // close 仍会触发，结果按已收到的字节判定
    });
  });
}

/** 标准 Upgrade 握手报文（Host 即「客户端请求的目标」） */
export function upgradeReq(host: string): string {
  return [
    "GET /ws HTTP/1.1",
    `Host: ${host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
}

/** 写 acl.json 并强制重读（跳过 1s 节流，等价于节流窗口已过） */
export function writeAcl(acl: unknown): void {
  fs.writeFileSync(aclPath, JSON.stringify(acl));
  readAcl({ locator: aclLocatorFor(testConfig), force: true });
}

/** client 模式起前置代理：拨号目标是上游桩，名单判定的应是客户端请求的目标 */
export async function withClientProxy(
  fn: (port: number, proxy: HttpProxy) => Promise<void>,
): Promise<void> {
  set("proxyMode", "client");
  set("upstreamProtocol", "http");
  set("upstreamHost", "127.0.0.1");
  set("upstreamPort", upstreamPort);
  await withProxy(HttpProxy, { access: fileAccess }, fn);
}

/**
 * server 模式起前置代理（上游桩照常配置）：验证 upstream 组被短路——
 * 若组被误查，请求会被错误地串联到上游桩（应答体变成 upstream-ok:），断言即可抓住
 */
export async function withServerProxy(
  fn: (port: number, proxy: HttpProxy) => Promise<void>,
): Promise<void> {
  set("proxyMode", "server");
  set("upstreamProtocol", "http");
  set("upstreamHost", "127.0.0.1");
  set("upstreamPort", upstreamPort);
  await withProxy(HttpProxy, { access: fileAccess }, fn);
}

beforeEach(async () => {
  snap = snapshotConfig(KEYS);
  silenceLogs();
  set("authEnabled", false);
  set("authType", "none");

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-client-acl-"));
  aclPath = path.join(dir, "acl.json");
  set("aclFile", aclPath);

  upstreamHits = 0;
  upgradeHosts = [];
  upstreamConnects = [];
  upstream = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    upstreamHits++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`upstream-ok:${req.url}`);
  });
  // CONNECT 通道：只记 request-target —— 拨了上游桩就是「误用 connectorFor」的硬证据
  upstream.on("connect", (req: http.IncomingMessage, socket: net.Socket) => {
    upstreamConnects.push(req.url ?? "");
    socket.destroy();
  });
  // Upgrade 通道：只记录握手 Host —— 它必须是「被访问的站点」，而不是上游地址
  upstream.on("upgrade", (req: http.IncomingMessage, socket: net.Socket) => {
    upgradeHosts.push(req.headers.host ?? "");
    socket.destroy();
  });
  upstreamPort = await getFreePort();
  await listen(upstream, upstreamPort);
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    upstream.closeAllConnections?.();
    upstream.close(() => resolve());
  });
  fs.rmSync(dir, { recursive: true, force: true });
  restoreConfig(snap);
});