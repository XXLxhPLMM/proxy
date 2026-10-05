/**
 * `bindProxyEventLogs` 两档共用的装配面：临时目录、账号表 / 名单文件、真 logger、原始往返采集。
 *
 * @description
 * 主题级不变量与三条装配裁决归 `./AGENTS.md`，本模块只提供两档都要的那一套符号与 hook。
 *
 * ⚠️ **刻意住在 `tests/integration/logging/` 而不是 `tests/helpers/`**：`external-network-scan.ts`
 * 的 `SCAN_DIRS = ["unit","integration","library"]` 排除 `helpers/`，而 `walk()` 收目录下**全部**
 * `.ts` —— 搬进去等于让下面这个 `net.connect(port, TARGET_IP)` 建链位从零外网扫描里
 * **静默消失**，而 `no-external-network.test.ts` 的两条下界断言照样绿。
 *
 * @module tests/integration/logging
 */
import { afterEach, beforeEach, expect } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ConfigStore, configAccessorFromStore } from "@/config/index.js";
import { createLogger } from "@/utils/logger/index.js";
import { getFreePort, listen } from "../../helpers/net.js";

export const ALICE_PW = "pw1";
export const TARGET_IP = "127.0.0.1";

/** 一条 JSONL 记录（去掉 `ts` 之后逐字段比较用）。 */
export type Record_ = Record<string, unknown>;

/** `PipeEvent` 判别联合的 14 个变体（与 `unit/pipe-event.test.ts` 的编译期契约同一份清单）。 */
export const PIPE_VARIANTS: readonly string[] = [
  "target-unresolved",
  "loop-detected",
  "route",
  "upstream-refused",
  "upstream-error",
  "upstream-timeout",
  "ip-denied",
  "target-denied",
  "socks",
  "bad-request",
  "dial",
  "established",
  "client-error",
  "debug",
];

/** 本例的临时根 / 落盘基址 / 代理端口 / 源站端口 —— 由下面那两个 hook 每例重建。 */
export let dir: string;
export let logDir: string;
export let port: number;
export let originPort: number;

let origin: http.Server;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-liblog-"));
  // 落盘基址与 configDir 分开两个子目录：断言「哪些文件是日志」时不被别的产物混进来
  logDir = path.join(dir, "logs");
  // 账号表
  fs.writeFileSync(
    path.join(dir, "users.json"),
    JSON.stringify([{ username: "alice", password: ALICE_PW }]),
  );
  // 上游路由黑名单：让 client 模式回落直连**并带 reason**（`[route]` 行的 jq 契约字段）
  fs.writeFileSync(
    path.join(dir, "acl.json"),
    JSON.stringify({ upstream: { blacklist: [TARGET_IP] } }),
  );

  origin = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("origin-ok");
  });
  originPort = await getFreePort();
  await listen(origin, originPort);
  port = await getFreePort();
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    origin.closeAllConnections?.();
    origin.close(() => resolve());
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 落盘用的库侧配置：控制台静音，落盘 info 级，基址钉死到本例临时目录 */
export function baseConfig(): Record<string, unknown> {
  return {
    host: TARGET_IP,
    port,
    logLevel: "silent",
    logFileLevel: "debug",
    proxyProtocol: "http",
    proxyMode: "client",
    upstreamProtocol: "http",
    upstreamHost: TARGET_IP,
    upstreamPort: originPort,
    authEnabled: true,
    authType: "basic",
    authUsersFile: path.join(dir, "users.json"),
    authLogging: true,
    aclFile: path.join(dir, "acl.json"),
  };
}

/**
 * 库调用方注入的真 logger：`createLogger` 是包入口**唯一**导出的构造入口
 * （`LoggerImpl` 在 `src/index.ts` 上是 **type-only** re-export，库调用方压根 new 不出来），
 * 所以走 `createLogger({ config })` 才是真实的库故事而不是测试专用捷径。
 */
export function libraryLogger(): ReturnType<typeof createLogger> {
  const store = new ConfigStore({
    logLevel: "silent",
    logFileLevel: "debug",
    logFile: logDir,
  });
  return createLogger({ config: configAccessorFromStore(store) });
}

/** 读全部 JSONL 记录（逐行 JSON.parse）；`logger.flush()` 之后不必轮询 */
export async function readRecords(logger: { flush?(): Promise<void> }): Promise<Record_[]> {
  await logger.flush?.();
  const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl")) : [];
  const lines: Record_[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(logDir, f), "utf8");
    for (const l of text.split("\n")) {
      if (l.trim() !== "") {
        lines.push(JSON.parse(l) as Record_);
      }
    }
  }
  return lines;
}

/** 一次完整往返：好凭证 200（`[forward]` + `[route]`）→ 坏凭证 407（`[auth] deny`） */
export async function driveTraffic(proxyPort: number): Promise<void> {
  const good = await rawRequest(
    proxyPort,
    `GET http://${TARGET_IP}:${originPort}/ok HTTP/1.1`,
    [`Host: ${TARGET_IP}:${originPort}`, `Proxy-Authorization: ${basic("alice", ALICE_PW)}`],
  );
  expect(good.status.startsWith("HTTP/1.1 200")).toBe(true);
  expect(good.raw).toContain("origin-ok");

  const bad = await rawRequest(
    proxyPort,
    `GET http://${TARGET_IP}:${originPort}/deny HTTP/1.1`,
    [`Host: ${TARGET_IP}:${originPort}`, `Proxy-Authorization: ${basic("mallory", "pw")}`],
  );
  expect(bad.status.startsWith("HTTP/1.1 407")).toBe(true);
}

/** 采集一次原始 HTTP 往返（绝对形式请求直发代理） */
export function rawRequest(
  port: number,
  requestLine: string,
  headers: string[],
): Promise<{ status: string; raw: string }> {
  return new Promise((resolve) => {
    const sock = net.connect(port, TARGET_IP, () => {
      sock.write([requestLine, ...headers, "Connection: close", "", ""].join("\r\n"));
    });
    let buf = "";
    sock.on("data", (c: Buffer) => {
      buf += c.toString();
    });
    sock.on("close", () => resolve({ status: buf.split("\r\n")[0] ?? "", raw: buf }));
    sock.on("error", () => {
      // close 仍会触发
    });
  });
}

export function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}
