/**
 * 流量配额**落盘账本**的接线护栏：runtime / server 装配 + 端到端重启恢复
 *
 * @description
 * `unit/usage-source.test.ts` 用可自由注入的口子测账本本身（时刻/窗口/目录/阈值）。
 * 本文件测**接线**，也就是「这条链路上每一步有没有真的接上」：
 *
 * 1. **端到端重启恢复**（本档的核心价值）：真代理 + 真源站 + 真字节 → 停机 → 再起，
 *    `usage()` 仍含那 N 字节；且恢复出来的用量**立刻参与判定**。
 * 2. **所有 runtime 共用同一个库文件**（本档的共享断言）：两个 runtime 实例（模拟两个
 *    cluster worker）指向**同一个** `usage.db`，各自的量落在同一行上相加。
 *    旧形态是每个 slot 一本 `worker-<slot>.jsonl` —— 那让配额判定从「账号级封禁」
 *    退化成「每进程一份封禁」，故槽位机制整体删除。
 * 3. **落盘无条件**经真 runtime：没人配 `quota.bytes` 也照样建目录建表，转发后账里真有量
 * 4. **注入 `services.traffic` 替身 → 不建账本**（那一本账归调用方管）。
 * 5. **`usage.write-error` 事件**由 runtime 发布（`UsageSourceError` → 公共事件）。
 * 6. **CLI 落一条 `[usage-write-error]` error 行**（runtime 层
 *    `runtime/event-log.ts:bindProxyEventLogs`）。
 * 7. **`start → stop → start`**：账本每轮重新建立/释放，`queued` 归零。
 * 8. **`ProxyServer.stop()` 在与 `logger.flush()` 同一位置落盘**（读真实文件内容）。
 * 9. **`services.usageSource` 注入位是真的**（它曾经是个死注入点：两条 return 分支都不读
 *    `overrides.usageSource`，传了等于没传且零告警）。含**编译期**牙齿：只实现生命周期面的
 *    账本过不了注入位（`@ts-expect-error` + TS2578）。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConfigStore, accountLocatorFor, createConfigContext } from "@/config/index.js";
import { readAuthUsers } from "@/datasource/users/index.js";
import type { ConfigAccessor } from "@/config/index.js";
import { EventHub, type EventEnvelope, type EventSubscription } from "@/core/events/index.js";
import type { UsageSource, UsageSourceController } from "@/datasource/quota/index.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import { ProxyServer } from "@/server/index.js";
import { LoggerImpl } from "@/utils/logger/index.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import { getFreePort, listen } from "../helpers/net.js";
import { blockAfter, codeOf } from "../helpers/source-scan.js";

const TARGET_IP = "127.0.0.1";
const ALICE = "alice";
const ALICE_PW = "pw1";

interface Account {
  username: string;
  password: string;
  quota?: { bytes?: number; window?: string };
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

/** 账本库文件（**所有进程共用这一个**；旧形态的 `worker-<slot>.jsonl` 已删除） */
function ledgerFile(): string {
  return path.join(ledgerDir, "usage.db");
}

/**
 * 库里的字节合计（另开连接真读；文件不存在 / 表未建即 0）
 * @description **真读**而不是 spy：本档的价值全在「字节真的落到磁盘上了」，
 * 而 SQLite 的内容只能通过另一个连接读到。关连接是必须的——Windows 上未释放的句柄
 * 会让后续的 `rmSync` 报 `EBUSY`。
 */
function ledgerBytes(): number {
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
function ledgerUsers(): string[] {
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
async function startRuntime(events?: EventHub): Promise<ProxyRuntime> {
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

describe("runtime 落盘账本：端到端重启恢复（真代理 + 真字节）", () => {
  it("真流量烧掉 N 字节 → stop() → 再 start() → usage() 仍含 N，且立刻参与判定", async () => {
    // ---- 第一次运行 ----
    const first = await startRuntime();
    const port = store.get("port");
    const payload = Buffer.alloc(2048, 0x41);
    const sent = await proxyRequest(port, originPort, { method: "POST", body: payload });
    expect(sent.status).toBe(200);
    const usageBefore = first.services.traffic.usage(ALICE);
    // usage 是**合计**字节数（上传 + 下载算在一起）；HTTP 路径两方向各少算一个 HTTP 头
    // （已知不对称），故只断言「不为零」
    expect(usageBefore).toBeGreaterThan(0);
    await first.stop();

    // 停机落盘：库里真的有账（**另开连接真读**，不是 spy）
    const file = ledgerFile();
    expect(fs.existsSync(file)).toBe(true);
    expect(ledgerBytes(), "停机后库里的字节合计 = 停机前的 usage").toBe(usageBefore);
    expect(ledgerUsers(), "库里只有该用户").toEqual([ALICE]);

    // ---- 第二次运行：全新 runtime，同一个账本目录 ----
    const second = await startRuntime();
    // **恢复完成早于收流量**：此刻 usage 已是非零
    expect(second.services.traffic.usage(ALICE)).toBe(usageBefore);
    // 继续计量是叠加，不是覆盖
    const again = await proxyRequest(store.get("port"), originPort, {
      method: "POST",
      body: Buffer.alloc(100, 0x42),
    });
    expect(again.status).toBe(200);
    expect(second.services.traffic.usage(ALICE)).toBeGreaterThan(usageBefore);
    await second.stop();
  });

  it("恢复出来的用量立刻参与判定：烧满后重启，额度不是新的", async () => {
    // 上一轮烧满 512 字节（上限 512）→ 停机 → 再起。若恢复失效，用户白拿一份满额，
    // 反复「烧满 → Ctrl+C → 再起」就能无限白嫖 —— 要消灭的正是这个。
    store.set("authUsersFile", usersPath);
    writeUsers([
      { username: ALICE, password: ALICE_PW, quota: { bytes: 512, window: "day" } },
    ]);
    readAuthUsers({ locator: accountLocatorFor(accessor), force: true });

    const first = await startRuntime();
    // 直接把判定推到顶（真流量不必要；这里要测的是判定与落盘的**衔接**）
    let exhausted = false;
    for (let i = 0; i < 40 && !exhausted; i++) {
      exhausted = !first.services.traffic.consume(ALICE, "up", 64).allow;
    }
    expect(exhausted, "512 上限应能被 consume 推满").toBe(true);
    const atStop = first.services.traffic.usage(ALICE);
    expect(atStop).toBeGreaterThan(512);
    await first.stop();

    const second = await startRuntime();
    expect(second.services.traffic.usage(ALICE)).toBe(atStop);
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
    const ledger = runtime.services.usageSource;
    expect(ledger).toBeDefined();
    expect(ledger?.enabled, "配了非 0 配额 → 账本必须启用").toBe(true);
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
    expect(restoredUsage).toBe(usageFirst);
    // 第二轮的新流量叠加上去
    await proxyRequest(store.get("port"), originPort, {
      method: "POST",
      body: Buffer.alloc(128, 0x45),
    });
    expect(runtime.services.traffic.usage(ALICE)).toBeGreaterThan(usageFirst);
    await runtime.stop();
    // 磁盘上的总量单调增长（第二轮的开头可能被启动期压缩重写成求和后的形态，
    // 故判据用「总字节变大」而不是「文件内容是前缀」——压缩本来就会重写）
    expect(ledgerBytes()).toBeGreaterThan(afterFirst);
  });
});

describe("runtime 落盘账本：所有 runtime 共用同一个库（多进程共享）", () => {
  it("两个 runtime（模拟两个 cluster worker）写同一个库 → 量在同一行上相加", async () => {
    // ⚠️ **本档是旧形态那个配额逃逸的牙齿**：分槽时两个 worker 各记一本、判定时也只看
    // 自己那本，于是「账号级封禁」实际是「每进程一份封禁」——4 个 worker 就是 4 倍额度。
    // 现在两个 runtime 指向**同一个** `usage.db`，第二个启动时必须**看得见**第一个记的量，
    // 且两轮流量落在同一行上相加。
    const first = await startRuntime();
    const firstPort = store.get("port");
    const r1 = await proxyRequest(firstPort, originPort, {
      method: "POST",
      body: Buffer.alloc(128, 0x46),
    });
    expect(r1.status).toBe(200);
    const usageAfterFirst = first.services.traffic.usage(ALICE);
    expect(usageAfterFirst).toBeGreaterThan(0);
    await first.stop();
    const bytesAfterFirst = ledgerBytes();
    expect(bytesAfterFirst).toBe(usageAfterFirst);

    // ---- 第二个 runtime（= 另一个 worker 进程）----
    const second = await startRuntime();
    expect(
      second.services.usageSource?.file,
      "两个 runtime 指向同一个库文件",
    ).toBe(ledgerFile());
    expect(
      second.services.traffic.usage(ALICE),
      "第二个 runtime 恢复出来的就是第一个记的量（不另起一本）",
    ).toBe(usageAfterFirst);

    const secondPort = store.get("port");
    const r2 = await proxyRequest(secondPort, originPort, {
      method: "POST",
      body: Buffer.alloc(128, 0x47),
    });
    expect(r2.status).toBe(200);
    await second.stop();

    // 两轮流量在**同一行**上相加：总量是二者之和，而不是「各记一本」
    expect(ledgerBytes(), "两轮流量相加在同一行上").toBeGreaterThan(bytesAfterFirst);
    expect(ledgerUsers(), "库里只有该用户（一行，不是两行）").toEqual([ALICE]);
    // 旧形态的产物：一个 slot 一个文件。**这个判据今天仍成立**（`readdirSync` 的形状），
    // 而「worker-<slot>.jsonl」这个文件名是**已删除**的符号——故锚在目录清单的形状上。
    const entries = fs.readdirSync(ledgerDir).filter((n) => n.endsWith(".jsonl"));
    expect(entries, "分槽时代的 .jsonl 产物不得复活").toEqual([]);
  });

  it("库文件名恒为 usage.db（不拼任何进程标识，杜绝路径穿越面）", async () => {
    const runtime = await startRuntime();
    expect(runtime.services.usageSource?.file).toBe(ledgerFile());
    expect(runtime.services.usageSource?.file.endsWith("usage.db")).toBe(true);
    // 只有**一个** `.db`——真相源只有一份
    expect(fs.readdirSync(ledgerDir).filter((n) => n.endsWith(".db"))).toEqual(["usage.db"]);
    await runtime.stop();
  });
});

/**
 * 真 runtime 侧的「落盘无条件」：**在判定 ⇒ 一定在记账**。
 * @description 判据是**代理真的在跑**（走一次转发），不是只查 `enabled` 标志 —— 拆掉
 * `open()` 里那道「没人配配额就不启用」的门之后，标志照样是 true，只有「真发一次请求、
 * 再真读一次库」能分辨出账到底记没记。
 */
describe("runtime 落盘账本：落盘无条件（真 runtime 侧）", () => {
  it("没有配任何 quota → 照样建目录建表，转发 512B 后账里真有这 512B", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW }]); // 完全没有 quota
    readAuthUsers({ locator: accountLocatorFor(accessor), force: true });

    const runtime = await startRuntime();
    expect(runtime.services.usageSource, "账本对象存在").toBeDefined();
    expect(runtime.services.usageSource?.enabled, "无配额也启用（否则判定与落盘脱钩）").toBe(true);
    expect(fs.existsSync(ledgerDir), "账本目录建出来了").toBe(true);

    // 判定照常：无限流账号一路放行
    const r = await proxyRequest(store.get("port"), originPort, {
      method: "POST",
      body: Buffer.alloc(512, 0x47),
    });
    expect(r.status).toBe(200);
    await runtime.stop(); // 停机必须落盘（这是正确性要求：丢掉队列里的量等于能刷额度）

    // ⚠️ 判据落在**真读库**上。锚点是这个文件路径而不是「enabled 为 true」——
    // 后者在门被拆掉之后恒成立，护栏就成了摆设。
    const db = new DatabaseSync(ledgerFile(), { readOnly: true });
    try {
      const row = db.prepare("SELECT v FROM usage WHERE u = ?").get(ALICE) as { v: number } | undefined;
      expect(row?.v, "无配额账号的用量也落库了（「没有上限」≠「不计量」）").toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("全 0 的 quota 同样记账（bytes=0 按契约等于「不限流」，但仍计量）", async () => {
    writeUsers([
      { username: ALICE, password: ALICE_PW, quota: { bytes: 0 } },
    ]);
    readAuthUsers({ locator: accountLocatorFor(accessor), force: true });
    const runtime = await startRuntime();
    expect(runtime.services.usageSource?.enabled).toBe(true);
    expect(fs.existsSync(ledgerDir)).toBe(true);
    await runtime.stop();
  });

  it("注入 services.traffic 替身 → 完全不建账本（那一本账归调用方管）", async () => {
    // ⚠️ 「不建」指的是**默认那一份**（`QUOTA_USAGE_DRIVER` 选出来的）：调用方若**同时**注入了
    // `usageSource` 替身，那个替身是原样生效的（见下一组 describe）。本例只注入 `traffic`，
    // 所以 `usageSource` 恒 undefined。
    const sentinel = {
      consume: () => ({ allow: true as const }),
      usage: () => 0,
    };
    const port = await getFreePort();
    store.set("port", port);
    const runtime = createProxyRuntime({
      context: createConfigContext({ store, configDir: dir }),
      logger: new LoggerImpl({ level: "silent" }),
      services: { traffic: sentinel },
    });
    await runtime.start();
    runtimes.push(runtime);
    expect(runtime.services.traffic).toBe(sentinel);
    expect(runtime.services.usageSource, "注入替身时不解析默认账本").toBeUndefined();
    expect(fs.existsSync(ledgerDir), "注入替身时不建目录").toBe(false);
    await runtime.stop();
  });
});

/** 账本替身自报状态：`openCalls` / `closeCalls` 让「生命周期真被 runtime 驱动」可断言 */
interface LedgerSentinel extends UsageSource {
  readonly openCalls: number;
  readonly closeCalls: number;
}

interface Recorded {
  user: string;
  dir: string;
  bytes: number;
}

/**
 * 一份**只记账不落盘**的账本替身（满足 `UsageSource` 全形状：数据面 + 生命周期面）
 * @description `enabled` 跟着 `open`/`close` 翻，于是「建不了存储」与「已启用」在替身上同样可区分。
 * `file` 恒为哨兵串：真账本的路径在诊断里有意义，替身没有文件，故给一个一眼看出不是路径的值。
 */
function ledgerSentinel(recorded: Recorded[]): LedgerSentinel {
  const calls = { open: 0, close: 0 };
  let enabled = false;
  return {
    file: "<sentinel:no-file>",
    get openCalls() {
      return calls.open;
    },
    get closeCalls() {
      return calls.close;
    },
    get enabled() {
      return enabled;
    },
    get queued() {
      return recorded.length;
    },
    async open() {
      enabled = true;
      calls.open += 1;
    },
    async close() {
      enabled = false;
      calls.close += 1;
    },
    record(user, dir, bytes) {
      recorded.push({ user, dir, bytes });
    },
  };
}

describe("runtime 落盘账本：注入位是**真**注入位（它曾经是个死注入点）", () => {
  // ⚠️ 本组存在的理由：`RuntimeServices` 上**一直**有那个数据源字段，而
  // `buildDefaultServices(overrides: Partial<RuntimeServices>)` 的签名因此**放行**
  // `services: { usageSource: 替身 }` —— 可那个函数从头到尾**没读过这个字段**：两条 return
  // 分支分别写死 `usageSource: undefined` 与内置那一份（且不带 `UsageSource` 全形状）。
  //
  // 于是「传了等于没传」，**且零告警、零报错、全绿**。这比「没有这个位」更坏：类型系统在替
  // 一个空壳背书，库调用方会以为持久化后端换掉了。
  //
  // 本组三条都在**行为面**钉住，末条再钉一层源码面。

  it("只注入账本 → 替身原样生效，且**数据面真的接上了**（record 收得到）", async () => {
    // 保护：只断言 `services.usageSource === 替身` 证明的只是「赋值发生」——一份没人调用的替身
    // 照样通过（`countingAccess()` 那条纪律同源）。真正要锁的是 `bindSink` 那一步，所以数 record。
    const recorded: Recorded[] = [];
    const substitute = ledgerSentinel(recorded);

    const port = await getFreePort();
    store.set("port", port);
    const runtime = createProxyRuntime({
      context: createConfigContext({ store, configDir: dir }),
      logger: new LoggerImpl({ level: "silent" }),
      services: { usageSource: substitute },
    });
    await runtime.start();
    runtimes.push(runtime);

    // 保护：此前这里是内置那一份，替身被静默丢弃
    expect(runtime.services.usageSource, "注入的账本替身原样生效").toBe(substitute);
    expect(fs.existsSync(ledgerDir), "注入账本时默认那份不建（连目录都不建）").toBe(false);

    const sent = await proxyRequest(port, originPort, {
      method: "POST",
      body: Buffer.alloc(256, 0x41),
    });
    expect(sent.status).toBe(200);

    // 判定侧照走：仍是默认内存账本，usage 涨了
    expect(runtime.services.traffic.usage(ALICE)).toBeGreaterThan(0);
    // 数据面：同一次计量**同时**落进替身。少 `bindSink` 那一步时这里是空数组，而上面两条全过。
    expect(recorded.length, "bindSink 把替身接进了数据面").toBeGreaterThan(0);
    expect(recorded.every((r) => r.user === ALICE)).toBe(true);
    expect(new Set(recorded.map((r) => r.dir)), "按方向记（上传 + 下载各一条）").toEqual(
      new Set(["up", "down"]),
    );

    // 生命周期仍由 runtime 驱动（这一半此前也不成立：替身压根没被读，`open()` 永不发生）
    expect(substitute.openCalls, "runtime.start() 真的调了替身的 open()").toBe(1);
    expect(runtime.services.usageSource?.enabled).toBe(true);
    await runtime.stop();
    expect(substitute.closeCalls, "runtime.stop() 真的调了替身的 close()").toBe(1);
  });

  it("traffic 与账本都注入 → 替身原样生效（此前恒 undefined），生命周期照常、数据接线归调用方", async () => {
    // 保护：早返回分支曾经写死那个字段为 `undefined`，于是注入的账本连 `open()` 都不会被调
    // ——「注入 = 传了个没人读的对象」。
    const recorded: Recorded[] = [];
    const substitute = ledgerSentinel(recorded);
    const trafficSentinel = { consume: () => ({ allow: true as const }), usage: () => 0 };

    const port = await getFreePort();
    store.set("port", port);
    const runtime = createProxyRuntime({
      context: createConfigContext({ store, configDir: dir }),
      logger: new LoggerImpl({ level: "silent" }),
      services: { traffic: trafficSentinel, usageSource: substitute },
    });
    await runtime.start();
    runtimes.push(runtime);

    expect(runtime.services.traffic).toBe(trafficSentinel);
    expect(runtime.services.usageSource, "注入的账本替身原样生效（此前恒 undefined）").toBe(substitute);
    expect(substitute.openCalls, "生命周期仍由 runtime 驱动").toBe(1);
    expect(substitute.enabled).toBe(true);

    // **数据面刻意不接**，并把这个「不接」钉成契约而不是让它读起来像 bug：`UsageAccount` 端口上
    // 没有 `bindSink`（它是内存实现的具体方法），我们无法给一个陌生的 traffic 挂 sink。
    const sent = await proxyRequest(port, originPort, {
      method: "POST",
      body: Buffer.alloc(64, 0x42),
    });
    expect(sent.status).toBe(200);
    expect(recorded, "traffic 是替身时数据接线归调用方，我们不挂 sink").toEqual([]);

    await runtime.stop();
    expect(substitute.closeCalls).toBe(1);
  });

  it("源码级：两条 return 分支都真的读 `overrides.usageSource`，且不许回到写死 undefined", () => {
    // 行为面已钉住，但**死回去的方式**恰好有一半是行为面钉不住的：把注入换成另一个硬编码值，
    // 上面两条会红；可「读的是 `overrides.usageSource`、而不是某个局部常量」这件事只有源码
    // 断言能说。锚点是**今天仍然存在**的形状（`overrides.usageSource`），不是被删掉的符号名
    // ——点名已删符号的负向断言会恒真而不是失败。
    //
    // ⚠️ 锚点是**返回类型那一行**而不是 `export function buildDefaultServices(`：后者后面第一个
    // `{` 是**参数里** `Partial<RuntimeServices>` 的花括号，`blockAfter` 会切出 `RuntimeServices`
    // 这一个词、然后下面所有计数恒为 0 —— 切错块的表现是「零命中」而不是「报错」，所以下面
    // 先用一条正向断言证明切对了块。
    const fn = blockAfter(codeOf("runtime", "services.ts"), "): RuntimeServices");
    expect(fn, "锚点失效：没切到 buildDefaultServices 的函数体（签名或返回类型变了）").toContain(
      "overrides.usageSource",
    );

    const reads = (fn.match(/overrides\.usageSource/g) ?? []).length;
    expect(reads, "两条 return 分支各读一次 `overrides.usageSource`").toBe(2);
    expect(fn, "早返回分支不许写死 `usageSource: undefined`（那正是它曾经的样子）").not.toMatch(
      /usageSource:\s*undefined/,
    );
    // 正向：注入必须**真的**参与 `bindSink`，否则又回到「只认生命周期、不认数据面」的半截子形状
    expect(fn, "注入的数据源与内置数据源走同一条 `??` 汇流，因而同样被 bindSink").toMatch(
      /overrides\.usageSource\s*\?\?/,
    );
  });

  it("类型面：只实现生命周期面的账本，编译期就过不去注入位", () => {
    // 真正的牙齿在**编译期**：`@ts-expect-error` 一旦变成「未使用」，`pnpm typecheck` 会报
    // TS2578（而 `.cnb.yml` 只做 Docker build、不跑 typecheck，所以本地那四条收尾是唯一关口）。
    // 这也是本档不能只留行为断言的原因：把 `RuntimeServices.usageSource` 的类型悄悄改回
    // `UsageSourceController`，行为面**一条都不会红**——那只账本照样 open/close、照样
    // `enabled: true`、照样一个像模像样的 `file`，只是一辈子收不到 `record`。
    const lifecycleOnly: UsageSourceController = ledgerSentinel([]);
    // @ts-expect-error 只满足生命周期面的对象不能当注入位：它会 open/close 却收不到任何 record
    const asSource: UsageSource = lifecycleOnly;
    expect(asSource).toBeDefined();
  });
});

describe("runtime 落盘账本：写盘失败 → 事件 + CLI error 行", () => {
  it("账本目录不可用 → 一条 usage.write-error，且 start() 不抛、判定不受影响", async () => {
    const events = new EventHub({ onListenerError: () => undefined });
    const seen: Array<EventEnvelope<"usage.write-error">> = [];
    subscriptions.push(events.subscribe("usage.write-error", (e) => seen.push(e)));

    const runtime = await startRuntime(events);
    expect(runtime.services.usageSource?.enabled).toBe(true);
    // 先干净地停一轮（`open()` 幂等：已启用时直接返回，所以必须先关）
    await runtime.stop();
    expect(runtime.services.usageSource?.enabled).toBe(false);
    // 让「下一次 open 拿不到目录」：把目录换成一个**同名普通文件**
    fs.rmSync(ledgerDir, { recursive: true, force: true });
    fs.writeFileSync(ledgerDir, "not a directory", "utf8");
    seen.length = 0;

    // start() 遇到不可用的账本目录：**不抛**，代理照常起
    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.services.usageSource?.enabled).toBe(false);
    // 一条可见事实（否则运维完全不知道「配额账本从这一刻起不落盘了」）
    expect(seen).toHaveLength(1);
    expect(seen[0].data.path).toBe(ledgerFile());
    // 判定完全不受影响：真实请求仍成功（配额远未耗尽）
    const r = await proxyRequest(store.get("port"), originPort, {
      method: "POST",
      body: Buffer.alloc(64, 0x49),
    });
    expect(r.status).toBe(200);
    expect(runtime.services.traffic.usage(ALICE)).toBeGreaterThan(0);
    await runtime.stop();
  });

  it("CLI 侧把 usage.write-error 落成一条 [usage-write-error] error 行", async () => {
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
      hub?.events.publish("usage.write-error", {
        path: ledgerFile(),
        error: new Error("ENOSPC: no space left on device"),
      });
      // 事件总线是同步分发，故断言不需要 await
      const line = records.find((r) => String(r.args[0]).includes("[usage-write-error]"));
      expect(line, "必须落一条 [usage-write-error]").toBeDefined();
      expect(line?.level).toBe("error");
      const text = line?.args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ") ?? "";
      expect(text).toContain(ledgerFile());
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
    // 停机前库里**一条都没有**（间隔 1 小时，全靠停机 flush；表在 `open()` 的建表步骤里
    // 就建出来了，故判据是字节合计而不是「表不存在」）
    expect(ledgerBytes()).toBe(0);
    await server.stop(3000);
    // 停机后：库里真的有那批字节（另开连接真读）
    expect(ledgerBytes()).toBeGreaterThan(256);
    expect(ledgerUsers()).toEqual([ALICE]);
  });
});

describe("runtime 落盘账本：配置文件本身（不用于行为断言，只防「示例/文档漂移」）", () => {
  it("恢复读取的窗口口径与判定侧同一份（同一个 resetHour 闭包）", async () => {
    // 判定与恢复**必须**用同一个 resetHour：若恢复按 0 点、判定按 3 点，
    // 同一批字节会被算进两个窗口。改 `quotaResetHour` 立刻改变两者的边界。
    store.set("quotaResetHour", 3);
    const runtime = await startRuntime();
    expect(runtime.services.usageSource?.file.endsWith("usage.db")).toBe(true);
    await runtime.stop();

    // 直接往库里塞一条**过期窗口**的用量（窗口键写成 2026-02-15，在 resetHour=3 下
    // 那属于早已过去的窗口）。⚠️ **不能靠 `consume` 造**：账本只往「当前窗口」写，
    // 过期行要靠手写库才造得出来——而那正是恢复路径必须扛住的形状（真实世界里
    // 它由上一个窗口期产生）。
    const db = openSqliteDriver()(ledgerFile());
    try {
      db.run("INSERT INTO usage (u, w, v) VALUES (?, ?, ?)", [ALICE, "2026-02-15", 4096]);
    } finally {
      db.close();
    }

    const second = await startRuntime();
    // 墙钟远在 3/15 之后，故 2026-02-15 那条属于**已过期**窗口 → 不参与当前判定
    expect(second.services.traffic.usage(ALICE)).toBe(0);
    await second.stop();
    // 过期行在启动期被清理掉（一条 DELETE 顶掉旧形态的整套压缩）
    expect(ledgerBytes(), "过期窗口的行不参与恢复").toBe(0);
  });
});
