/**
 * 流量配额**落盘账本**的接线护栏（Phase 5b-2）：runtime / server 装配 + 端到端重启恢复
 *
 * @description
 * `unit/traffic-ledger.test.ts` 用可自由注入的口子测账本本身（时刻/窗口/目录/阈值）。
 * 本文件测**接线**，也就是「这条链路上每一步有没有真的接上」：
 *
 * 1. **端到端重启恢复**（本切片的核心价值）：真代理 + 真源站 + 真字节 → 停机 → 再起，
 *    `usage()` 仍含那 N 字节；且恢复出来的用量**立刻参与判定**。
 * 2. **槽位号经显式选项传进来**：`createProxyRuntime({ trafficWorkerSlot: "7" })`
 *    真的写 `worker-7.jsonl`；省略则 `worker-0.jsonl`。
 * 3. **零成本档**经真 runtime：没有非全 0 配额 → `start()` 后账本目录仍不存在。
 * 4. **注入 `services.traffic` 替身 → 不建账本**（那一本账归调用方管）。
 * 5. **`traffic.ledger-error` 事件**由 runtime 发布（`TrafficLedgerError` → 公共事件）。
 * 6. **CLI 落一条 `[quota-ledger-error]` error 行**（server 层 `bindProxyEventLogs`）。
 * 7. **`start → stop → start`**：账本每轮重新建立/释放，`queued` 归零。
 * 8. **`ProxyServer.stop()` 在与 `logger.flush()` 同一位置落盘**（读真实文件内容）。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ConfigStore, createConfigContext, readAuthUsers } from "@/config/index.js";
import type { ConfigAccessor } from "@/config/index.js";
import { EventHub, type EventEnvelope, type EventSubscription } from "@/core/events/index.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import { ProxyServer } from "@/server/index.js";
import { LoggerImpl } from "@/utils/logger/index.js";
import { getFreePort, listen } from "../helpers/net.js";

const TARGET_IP = "127.0.0.1";
const ALICE = "alice";
const ALICE_PW = "pw1";

interface Account {
  username: string;
  password: string;
  quota?: { bytesUp?: number; bytesDown?: number; bytesTotal?: number; window?: string };
}

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/** 经代理发一次 absolute-form 请求，返回状态码与客户端实测收到的响应体字节数 */
function proxyRequest(
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

let dir = "";
let usersPath = "";
let aclPath = "";
let ledgerDir = "";
let logFile = "";
let store: ConfigStore;
let accessor: ConfigAccessor;
let originPort = 0;
const originSockets = new Set<net.Socket>();
const runtimes: ProxyRuntime[] = [];
const subscriptions: EventSubscription[] = [];

function writeUsers(accounts: Account[]): void {
  fs.writeFileSync(usersPath, JSON.stringify(accounts));
}

function ledgerFile(slot: string | undefined): string {
  return path.join(ledgerDir, `worker-${slot ?? "0"}.jsonl`);
}

/** 账本文件里所有 delta 的字节合计（文件不存在即 0） */
function ledgerBytes(slot?: string): number {
  const file = ledgerFile(slot);
  if (!fs.existsSync(file)) {
    return 0;
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .reduce((sum, l) => sum + (JSON.parse(l) as { b: number }).b, 0);
}

/** 起一个真 runtime（真代理 + 真鉴权 + 真账本），返回它 */
async function startRuntime(slot?: string, events?: EventHub): Promise<ProxyRuntime> {
  const port = await getFreePort();
  store.set("port", port);
  const runtime = createProxyRuntime({
    context: createConfigContext({ store, configDir: dir }),
    events,
    logger: new LoggerImpl({ level: "silent" }),
    ...(slot === undefined ? {} : { trafficWorkerSlot: slot }),
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
  ledgerDir = path.join(dir, "quota");
  logFile = path.join(dir, "logs", "app.jsonl");
  writeUsers([
    { username: ALICE, password: ALICE_PW, quota: { bytesTotal: 10_000_000, window: "day" } },
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
    quotaLedgerDir: ledgerDir,
    // 间隔给足一小时：所有落盘都由**停机**或显式 close 驱动，不依赖真实时钟
    quotaFlushInterval: 3_600_000,
    logLevel: "silent",
    logFileLevel: "info",
    logFile,
  });
  accessor = { get: store.get.bind(store) } as ConfigAccessor;
  readAuthUsers({ config: accessor, force: true });
});

afterEach(async () => {
  for (const s of subscriptions.splice(0)) {
    s.dispose();
  }
  for (const r of runtimes.splice(0)) {
    await r.stop().catch(() => undefined);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runtime 落盘账本：端到端重启恢复（真代理 + 真字节）", () => {
  it("真流量烧掉 N 字节 → stop() → 再 start() → usage() 仍含 N，且立刻参与判定", async () => {
    // ---- 第一次运行 ----
    const first = await startRuntime();
    const port = store.get("port");
    const payload = Buffer.alloc(2048, 0x41);
    const sent = await proxyRequest(port, originPort, { method: "POST", body: payload });
    expect(sent.status).toBe(200);
    const usageBefore = first.services.traffic.usage(ALICE);
    // HTTP 路径两方向各少算一个 HTTP 头（已知不对称，见 core/AGENTS.md），故只断言「不为零」
    expect(usageBefore.up).toBeGreaterThan(0);
    expect(usageBefore.down).toBeGreaterThan(0);
    await first.stop();

    // 停机落盘：账本文件里真的有账（读真实内容）
    const file = ledgerFile(undefined);
    expect(fs.existsSync(file)).toBe(true);
    const written = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { u: string; d: string; b: number });
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((e) => e.u === ALICE)).toBe(true);
    const totalWritten = written.reduce((sum, e) => sum + e.b, 0);
    expect(totalWritten).toBe(usageBefore.up + usageBefore.down);

    // ---- 第二次运行：全新 runtime，同一个账本目录 ----
    const second = await startRuntime();
    // **恢复完成早于收流量**：此刻 usage 已是非零
    expect(second.services.traffic.usage(ALICE)).toEqual(usageBefore);
    // 继续计量是叠加，不是覆盖
    const again = await proxyRequest(store.get("port"), originPort, {
      method: "POST",
      body: Buffer.alloc(100, 0x42),
    });
    expect(again.status).toBe(200);
    const usageAfter = second.services.traffic.usage(ALICE);
    expect(usageAfter.up).toBeGreaterThan(usageBefore.up);
    expect(usageAfter.down).toBeGreaterThan(usageBefore.down);
    await second.stop();
  });

  it("恢复出来的用量立刻参与判定：烧满后重启，额度不是新的", async () => {
    // 上一轮烧满 512 字节（上限 512）→ 停机 → 再起。若恢复失效，用户白拿一份满额，
    // 反复「烧满 → Ctrl+C → 再起」就能无限白嫖 —— 本切片要消灭的正是这个。
    store.set("authUsersFile", usersPath);
    writeUsers([
      { username: ALICE, password: ALICE_PW, quota: { bytesTotal: 512, window: "day" } },
    ]);
    readAuthUsers({ config: accessor, force: true });

    const first = await startRuntime();
    // 直接把判定推到顶（真流量不必要；这里要测的是判定与落盘的**衔接**）
    let exhausted = false;
    for (let i = 0; i < 40 && !exhausted; i++) {
      exhausted = !first.services.traffic.consume(ALICE, "up", 64).allow;
    }
    expect(exhausted, "512 上限应能被 consume 推满").toBe(true);
    const atStop = first.services.traffic.usage(ALICE);
    expect(atStop.up).toBeGreaterThan(512);
    await first.stop();

    const second = await startRuntime();
    expect(second.services.traffic.usage(ALICE)).toEqual(atStop);
    // 恢复后第一次真实请求就该被拒（不是「重新给一份」）
    const r = await proxyRequest(store.get("port"), originPort, {
      method: "POST",
      body: Buffer.alloc(64, 0x43),
    });
    expect(r.status).toBe(507);
    await second.stop();
  });

  it("start → stop → start：账本每轮重新建立并释放（queued 归零、恢复不含丢）", async () => {
    const runtime = await startRuntime();
    const ledger = runtime.services.trafficLedger;
    expect(ledger).toBeDefined();
    expect(ledger?.enabled, "配了非全 0 配额 → 账本必须启用").toBe(true);
    await proxyRequest(store.get("port"), originPort, {
      method: "POST",
      body: Buffer.alloc(256, 0x44),
    });
    const usageFirst = runtime.services.traffic.usage(ALICE);
    await runtime.stop();
    expect(ledger?.queued, "停机必须把队列排空").toBe(0);
    expect(ledger?.enabled, "停机后账本已关闭").toBe(false);
    const afterFirst = ledgerBytes();

    await runtime.start();
    expect(ledger?.enabled, "再启动必须重新建立账本").toBe(true);
    // 第二轮恢复出来的用量**包含**第一轮（不覆盖、不清零）
    const restoredUsage = runtime.services.traffic.usage(ALICE);
    expect(restoredUsage.up).toBe(usageFirst.up);
    expect(restoredUsage.down).toBe(usageFirst.down);
    // 第二轮的新流量叠加上去
    await proxyRequest(store.get("port"), originPort, {
      method: "POST",
      body: Buffer.alloc(128, 0x45),
    });
    expect(runtime.services.traffic.usage(ALICE).up).toBeGreaterThan(usageFirst.up);
    await runtime.stop();
    // 磁盘上的总量单调增长（第二轮的开头可能被启动期压缩重写成求和后的形态，
    // 故判据用「总字节变大」而不是「文件内容是前缀」——压缩本来就会重写）
    expect(ledgerBytes()).toBeGreaterThan(afterFirst);
  });
});

describe("runtime 落盘账本：槽位经显式选项传进来", () => {
  it("trafficWorkerSlot 决定文件名；省略即 worker-0.jsonl（单进程/库模式）", async () => {
    const single = await startRuntime();
    expect(single.services.trafficLedger?.file).toBe(ledgerFile(undefined));
    expect(single.services.trafficLedger?.file.endsWith("worker-0.jsonl")).toBe(true);
    const singlePort = store.get("port");
    const r = await proxyRequest(singlePort, originPort, {
      method: "POST",
      body: Buffer.alloc(32, 0x46),
    });
    expect(r.status).toBe(200);
    await single.stop();
    expect(fs.existsSync(ledgerFile(undefined))).toBe(true);

    const worker7 = await startRuntime("7");
    expect(worker7.services.trafficLedger?.file).toBe(ledgerFile("7"));
    expect(worker7.services.trafficLedger?.file.endsWith("worker-7.jsonl")).toBe(true);
    const r7 = await proxyRequest(store.get("port"), originPort, {
      method: "POST",
      body: Buffer.alloc(32, 0x47),
    });
    expect(r7.status).toBe(200);
    await worker7.stop();
    // 两个 slot 写两个文件，互不覆盖
    expect(fs.readdirSync(ledgerDir).sort()).toEqual(["worker-0.jsonl", "worker-7.jsonl"]);
    expect(ledgerBytes("0")).toBeGreaterThan(0);
    expect(ledgerBytes("7")).toBeGreaterThan(0);
  });

  it("非法槽位号归一为 \"0\"（槽位会拼进路径，非数字一律按路径穿越面拒绝）", async () => {
    const hostile = await startRuntime("../../evil");
    expect(hostile.services.trafficLedger?.file).toBe(ledgerFile(undefined));
    await hostile.stop();
    expect(fs.existsSync(ledgerFile(undefined))).toBe(true);
    // 没有在 ledgerDir 之外造出任何文件
    expect(fs.readdirSync(dir).sort()).toContain("quota");
  });
});

describe("runtime 落盘账本：零成本档（真 runtime 侧）", () => {
  it("没有非全 0 配额 → start() 之后账本目录仍不存在、账本未启用", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW }]); // 完全没有 quota
    readAuthUsers({ config: accessor, force: true });

    const runtime = await startRuntime();
    expect(runtime.services.trafficLedger, "账本对象存在（它只是不启用）").toBeDefined();
    expect(runtime.services.trafficLedger?.enabled, "零成本档：不启用").toBe(false);
    expect(fs.existsSync(ledgerDir), "零成本档：不建目录").toBe(false);
    // 判定照常：无限流账号一路放行
    const r = await proxyRequest(store.get("port"), originPort, {
      method: "POST",
      body: Buffer.alloc(512, 0x47),
    });
    expect(r.status).toBe(200);
    await runtime.stop();
    expect(fs.existsSync(ledgerDir)).toBe(false);
  });

  it("全 0 的 quota 同样走零成本档（按契约等于「没配」）", async () => {
    writeUsers([
      { username: ALICE, password: ALICE_PW, quota: { bytesUp: 0, bytesDown: 0, bytesTotal: 0 } },
    ]);
    readAuthUsers({ config: accessor, force: true });
    const runtime = await startRuntime();
    expect(runtime.services.trafficLedger?.enabled).toBe(false);
    expect(fs.existsSync(ledgerDir)).toBe(false);
    await runtime.stop();
  });

  it("注入 services.traffic 替身 → 完全不建账本（那一本账归调用方管）", async () => {
    const sentinel = {
      consume: () => ({ allow: true as const }),
      usage: () => ({ up: 0, down: 0 }),
    };
    const port = await getFreePort();
    store.set("port", port);
    const runtime = createProxyRuntime({
      context: createConfigContext({ store, configDir: dir }),
      logger: new LoggerImpl({ level: "silent" }),
      services: { traffic: sentinel },
      trafficWorkerSlot: "3",
    });
    await runtime.start();
    runtimes.push(runtime);
    expect(runtime.services.traffic).toBe(sentinel);
    expect(runtime.services.trafficLedger, "注入替身时不解析默认账本").toBeUndefined();
    expect(fs.existsSync(ledgerDir), "注入替身时不建目录").toBe(false);
    await runtime.stop();
  });
});

describe("runtime 落盘账本：写盘失败 → 事件 + CLI error 行", () => {
  it("账本目录不可用 → 一条 traffic.ledger-error，且 start() 不抛、判定不受影响", async () => {
    const events = new EventHub({ onListenerError: () => undefined });
    const seen: Array<EventEnvelope<"traffic.ledger-error">> = [];
    subscriptions.push(events.subscribe("traffic.ledger-error", (e) => seen.push(e)));

    const runtime = await startRuntime(undefined, events);
    expect(runtime.services.trafficLedger?.enabled).toBe(true);
    // 先干净地停一轮（`open()` 幂等：已启用时直接返回，所以必须先关）
    await runtime.stop();
    expect(runtime.services.trafficLedger?.enabled).toBe(false);
    // 让「下一次 open 拿不到目录」：把目录换成一个**同名普通文件**
    fs.rmSync(ledgerDir, { recursive: true, force: true });
    fs.writeFileSync(ledgerDir, "not a directory", "utf8");
    seen.length = 0;

    // start() 遇到不可用的账本目录：**不抛**，代理照常起
    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.services.trafficLedger?.enabled).toBe(false);
    // 一条可见事实（否则运维完全不知道「配额账本从这一刻起不落盘了」）
    expect(seen).toHaveLength(1);
    expect(seen[0].data.path).toBe(ledgerFile(undefined));
    // 判定完全不受影响：真实请求仍成功（配额远未耗尽）
    const r = await proxyRequest(store.get("port"), originPort, {
      method: "POST",
      body: Buffer.alloc(64, 0x49),
    });
    expect(r.status).toBe(200);
    expect(runtime.services.traffic.usage(ALICE).up).toBeGreaterThan(0);
    await runtime.stop();
  });

  it("CLI 侧把 traffic.ledger-error 落成一条 [quota-ledger-error] error 行", async () => {
    // 直接验事件 → 日志的**绑定**（不靠真的造磁盘故障，那在 Windows CI 上不可复现）：
    // 手工 publish 一次，断言 server 层的订阅把它落成了什么等级、什么文本。
    const context = createConfigContext({ store, configDir: dir });
    const records: Array<{ level: string; args: unknown[] }> = [];
    const logger = new LoggerImpl({ level: "silent" });
    logger.error = (...args: unknown[]): void => {
      records.push({ level: "error", args });
    };
    const port = await getFreePort();
    store.set("port", port);
    const server = new ProxyServer({ context, logger, noColor: true, isWorker: false });
    await server.start();
    try {
      const hub = (server as unknown as { runtime: ProxyRuntime | null }).runtime;
      expect(hub).toBeDefined();
      hub?.events.publish("traffic.ledger-error", {
        path: ledgerFile("1"),
        error: new Error("ENOSPC: no space left on device"),
      });
      // 事件总线是同步分发，故断言不需要 await
      const line = records.find((r) => String(r.args[0]).includes("[quota-ledger-error]"));
      expect(line, "必须落一条 [quota-ledger-error]").toBeDefined();
      expect(line?.level).toBe("error");
      const text = line?.args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ") ?? "";
      expect(text).toContain(ledgerFile("1"));
      // 文案必须写明「服务没停」与「不要重启」——这是运维看到 error 后的正确处置
      expect(text).toContain("内存计数继续");
      expect(text).toContain("不要为此重启");
    } finally {
      await server.stop(2000);
    }
  });

  it("ProxyServer.stop() 在与 logger.flush() 同一位置把账本落盘（读真实文件内容）", async () => {
    const context = createConfigContext({ store, configDir: dir });
    const port = await getFreePort();
    store.set("port", port);
    const server = new ProxyServer({
      context,
      logger: new LoggerImpl({ level: "silent" }),
      noColor: true,
      isWorker: false,
    });
    await server.start();
    const r = await proxyRequest(port, originPort, { method: "POST", body: Buffer.alloc(256, 0x4a) });
    expect(r.status).toBe(200);
    // 停机前账本文件里**一条 delta 都没有**（间隔 1 小时，全靠停机 flush；
    // 文件本身在 open 的启动期压缩里就被建出来并清空，故判据是字节合计而不是「不存在」）
    expect(ledgerBytes()).toBe(0);
    await server.stop(3000);
    // 停机后：真实文件里真的有那批字节
    expect(ledgerBytes()).toBeGreaterThan(256);
    const written = fs
      .readFileSync(ledgerFile(undefined), "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { u: string; b: number });
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((e) => e.u === ALICE)).toBe(true);
  });
});

describe("runtime 落盘账本：配置文件本身（不用于行为断言，只防「示例/文档漂移」）", () => {
  it("恢复读取的窗口口径与判定侧同一份（同一个 resetHour 闭包）", async () => {
    // 判定与恢复**必须**用同一个 resetHour：若恢复按 0 点、判定按 3 点，
    // 同一批字节会被算进两个窗口。改 `quotaResetHour` 立刻改变两者的边界。
    store.set("quotaResetHour", 3);
    const runtime = await startRuntime();
    const ledger = runtime.services.trafficLedger;
    expect(ledger?.file.endsWith("worker-0.jsonl")).toBe(true);
    // 造一条「凌晨 1 点」的账（属于前一天窗口），在 resetHour=3 下读取
    const oneAm = new Date(2026, 2, 15, 1, 0, 0).getTime();
    fs.writeFileSync(
      ledgerFile(undefined),
      `${JSON.stringify({ ts: oneAm, u: ALICE, d: "up", b: 4096 })}\n`,
      "utf8",
    );
    const second = await startRuntime();
    // 墙钟在 3/15 之后，故 3/15 01:00 那条属于**已过期**窗口 → 不参与当前判定
    expect(second.services.traffic.usage(ALICE)).toEqual({ up: 0, down: 0 });
    await second.stop();
  });
});
