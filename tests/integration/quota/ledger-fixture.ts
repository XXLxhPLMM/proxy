/**
 * `ledger-*` 三档共用的装配面：每例独立的临时 `users.json` / `acl.json` / 账本目录 / 日志文件、
 * 一份自带全部钉值的 `ConfigStore`、真源站与四组 hook。
 *
 * @description
 * 档级不变量（落盘为什么无条件、注入位为什么曾经是死注入点、为什么整档钉 sqlite 档专属机制）
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
import { ConfigStore, accountLocatorFor, createConfigContext } from "@/config/index.js";
import type { ConfigAccessor } from "@/config/index.js";
import { readAuthUsers } from "@/datasource/users/index.js";
import { EventHub, type EventSubscription } from "@/core/events/index.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import { LoggerImpl } from "@/utils/logger/index.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import { getFreePort, listen } from "../../helpers/net.js";

export const TARGET_IP = "127.0.0.1";
export const ALICE = "alice";
export const ALICE_PW = "pw1";

export interface Account {
  username: string;
  password: string;
  quota?: { bytes?: number; window?: string };
}

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/** 经代理发一次 absolute-form 请求，返回状态码与客户端实测收到的响应体字节数 */
export function proxyRequest(
  proxyPort: number,
  targetPort: number,
  opts: { method?: string; path?: string; body?: Buffer } = {},
): Promise<{ status: number; got: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: TARGET_IP,
        port: proxyPort,
        method: opts.method ?? "GET",
        path: `http://${TARGET_IP}:${targetPort}${opts.path ?? "/x"}`,
        headers: {
          Host: `${TARGET_IP}:${targetPort}`,
          "Proxy-Authorization": basic(ALICE, ALICE_PW),
          Connection: "close",
          ...(opts.body === undefined ? {} : { "content-length": String(opts.body.length) }),
        },
      },
      (res) => {
        let got = 0;
        res.on("data", (c: Buffer) => {
          got += c.length;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, got }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
    req.end(opts.body);
  });
}

export let dir = "";
export let usersPath = "";
export let aclPath = "";
export let ledgerDir = "";
export let logFile = "";
export let store: ConfigStore;
export let accessor: ConfigAccessor;
export let originPort = 0;
const originSockets = new Set<net.Socket>();
export const runtimes: ProxyRuntime[] = [];
export const subscriptions: EventSubscription[] = [];

export function writeUsers(accounts: Account[]): void {
  fs.writeFileSync(usersPath, JSON.stringify(accounts));
}

/** 账本库文件（**所有进程共用这一个**；旧形态的 `worker-<slot>.jsonl` 已删除） */
export function ledgerFile(): string {
  return path.join(ledgerDir, "usage.db");
}

/**
 * 库里的字节合计（另开连接真读；文件不存在 / 表未建即 0）
 * @description **真读**而不是 spy：本档的价值全在「字节真的落到磁盘上了」，
 * 而 SQLite 的内容只能通过另一个连接读到。关连接是必须的——Windows 上未释放的句柄
 * 会让后续的 `rmSync` 报 `EBUSY`。
 */
export function ledgerBytes(): number {
  const file = ledgerFile();
  if (!fs.existsSync(file)) {
    return 0;
  }
  const db = openSqliteDriver()(file);
  try {
    let sum = 0;
    for (const row of db.all<{ v: number }>("SELECT v FROM usage")) {
      sum += row.v;
    }
    return sum;
  } catch {
    // 表还没建（建表失败）→ 当作 0，与「文件不存在」同一口径
    return 0;
  } finally {
    db.close();
  }
}

/** 库里出现过的用户名清单（诊断「有没有别的用户混进来」） */
export function ledgerUsers(): string[] {
  const file = ledgerFile();
  if (!fs.existsSync(file)) {
    return [];
  }
  const db = openSqliteDriver()(file);
  try {
    return db.all<{ u: string }>("SELECT DISTINCT u FROM usage ORDER BY u").map((r) => r.u);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** 起一个真 runtime（真代理 + 真鉴权 + 真账本），返回它 */
export async function startRuntime(events?: EventHub): Promise<ProxyRuntime> {
  const port = await getFreePort();
  store.set("port", port);
  const runtime = createProxyRuntime({
    context: createConfigContext({ store, configDir: dir }),
    events,
    logger: new LoggerImpl({ level: "silent" }),
  });
  await runtime.start();
  runtimes.push(runtime);
  return runtime;
}

beforeAll(async () => {
  const server = http.createServer((req, res) => {
    if (req.method === "POST") {
      req.resume();
      req.on("end", () => {
        const body = Buffer.alloc(64, 0x5a);
        res.writeHead(200, { "content-length": String(body.length) });
        res.end(body);
      });
      return;
    }
    const size = Number(new URL(`http://x${req.url ?? "/x"}`).searchParams.get("n") ?? "0");
    const body = Buffer.alloc(size, 0x5a);
    res.writeHead(200, { "content-length": String(body.length) });
    res.end(body);
  });
  server.on("connection", (s) => {
    originSockets.add(s);
    s.on("error", () => undefined);
    s.on("close", () => originSockets.delete(s));
  });
  originPort = await getFreePort();
  await listen(server, originPort);
});

afterAll(async () => {
  for (const s of originSockets) {
    s.destroy();
  }
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "traffic-ledger-rt-"));
  usersPath = path.join(dir, "users.json");
  aclPath = path.join(dir, "acl.json");
  ledgerDir = path.join(dir, "usage");
  logFile = path.join(dir, "logs", "app.jsonl");
  writeUsers([
    { username: ALICE, password: ALICE_PW, quota: { bytes: 10_000_000, window: "day" } },
  ]);
  fs.writeFileSync(aclPath, JSON.stringify({}));

  store = new ConfigStore();
  store.merge({
    host: TARGET_IP,
    port: 1,
    proxyMode: "server",
    authEnabled: true,
    authType: "basic",
    authLogging: false,
    authUsersFile: usersPath,
    aclFile: aclPath,
    quotaUsageDir: ledgerDir,
    // 显式钉 sqlite，不跟随产品缺省：本档整档断言的是 **sqlite 档专属机制**——库文件名恒为
    // `usage.db`、所有 runtime 共用同一个库、停机后**另开连接真读**那个库。缺省是产品决策，
    // 让这档骑在上面等于把 16 条断言绑在一个改默认值就会全红的地方。
    quotaUsageDriver: "sqlite",
    // 间隔给足一小时：所有落盘都由**停机**或显式 close 驱动，不依赖真实时钟
    quotaFlushInterval: 3_600_000,
    logLevel: "silent",
    logFileLevel: "info",
    logFile,
  });
  accessor = { get: store.get.bind(store) } as ConfigAccessor;
  readAuthUsers({ locator: accountLocatorFor(accessor), force: true });
});

afterEach(async () => {
  for (const s of subscriptions.splice(0)) {
    s.dispose();
  }
  for (const r of runtimes.splice(0)) {
    await r.stop().catch(() => undefined);
  }
  // SQLite 有 `-wal` / `-shm` 旁挂文件，且 **Windows 上任何未释放的句柄都让 `rmSync`
  // 报 `EBUSY`**。重试若干次：清理失败不该把一条断言正确的用例判成失败，而真占用
  // 会在重试耗尽后照常抛出来。
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      last = undefined;
      break;
    } catch (error) {
      last = error;
    }
  }
  if (last !== undefined) {
    throw last;
  }
});
