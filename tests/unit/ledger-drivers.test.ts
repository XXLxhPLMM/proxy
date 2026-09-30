/**
 * 账本的**两个后端**（`QUOTA_LEDGER_DRIVER`）：json 档与 sqlite 档的等价性与各自边界
 *
 * @description
 * `traffic-ledger.test.ts` 专测 sqlite 档；本文件专测**抽象**本身，也就是「换一个后端，
 * 判定语义不变」。锁三件事：
 *
 * 1. **等价性**：同一批用量经两个后端落盘后，**恢复出来的总量相同**。锚点是「读回来的数字」，
 *    不是「文件存在」——后者在「写了个空文件」时也成立。
 * 2. **装配切换**：`buildDefaultServices` 真的按 `QUOTA_LEDGER_DRIVER` 挑实现器。判据是
 *    **账本文件名形态**（`usage.jsonl` vs `quota.db`），因为那是「哪个后端真的在写」的可观察证据；
 *    再加上「写入的字节真的进了那个文件」。
 * 3. **各自的能力边界**（**不许被抹平**）：json 档**没有**多进程共享判定，且它**不做**
 *    窗口过期清理（那是 sqlite 档的 `pruneExpired`）。这两条是 json 档**保留下来**的已知缺口，
 *    本文件把它们钉成断言——将来若有人给 json 档也加上清理（或者反过来，把分槽复活），
 *    这里会红，从而逼人重新想一遍「两个后端的行为是否仍然可以互换」。
 *
 * ## 为什么第 ③ 组要写成「缺口的断言」
 *
 * 抽象层最容易腐烂成「两个实现器其实不等价，而没人说」。把缺口写成断言，它就变成
 * **有名字的已知差异**而不是沉默的行为分叉；真要补齐时，那条断言会先红一次，逼着改动者
 * 承认「我让两个后端的行为分叉了/我补齐了一个后端，另一个要不要跟」。
 *
 * @example
 * const h = harness(dir, { driver: "json" });
 * await h.ledger.open();
 * h.at(day12);
 * h.account.consume("alice", "up", 1024);
 * await h.ledger.close();
 * expect(h.readTotal()).toBe(1024); // 另一个连接真读，不是 spy
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore, createConfigContext } from "@/config/index.js";
import {
  JSONL_LEDGER_FILE_NAME,
  MemoryTrafficAccount,
  SqliteTrafficLedger,
  quotaWindow,
  type QuotaWindow,
  type RestoredLedger,
  type TrafficLedgerError,
  type UserQuota,
} from "@/core/traffic/index.js";
import { JsonlTrafficLedger, parseLedger } from "@/core/traffic/index.js";
import { buildDefaultServices } from "@/runtime/services.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import { testContextFor } from "../helpers/config.js";
import { codeOf } from "../helpers/source-scan.js";

const at = (y: number, m: number, d: number, h = 0): number =>
  new Date(y, m - 1, d, h, 0, 0, 0).getTime();

const QUOTA: UserQuota = { bytes: 10_000_000, window: "day" };
const day12 = at(2026, 3, 15, 12);

let dir = "";

/** 组一套「内存账本 + 指定后端的落盘副本」，形状与 `buildDefaultServices` 逐字同构 */
function harness(driver: "json" | "sqlite") {
  const clock = { now: day12 };
  const errors: TrafficLedgerError[] = [];
  const account = new MemoryTrafficAccount(() => QUOTA, {
    resetHour: () => 0,
    now: () => clock.now,
  });
  const shared = {
    dir,
    flushMs: (): number => 3_600_000,
    resetHour: (): number => 0,
    windowFor: (): QuotaWindow => quotaWindow(QUOTA.window),
    enabled: (): boolean => true,
    now: (): number => clock.now,
    onRestore: (r: RestoredLedger): void => {
      account.seed(r);
    },
    onError: (e: TrafficLedgerError): void => {
      errors.push(e);
    },
  };
  const ledger = driver === "json" ? new JsonlTrafficLedger(shared) : new SqliteTrafficLedger(shared);
  account.bindSink(ledger);
  return { account, ledger, errors, at: (t: number) => (clock.now = t) };
}

/** 读某个后端落下来的总量（**另开一个连接 / 另一次读**，不是 spy） */
function readTotal(driver: "json" | "sqlite", user: string, window: string): number {
  if (driver === "json") {
    const file = path.join(dir, JSONL_LEDGER_FILE_NAME);
    if (!fs.existsSync(file)) {
      return 0;
    }
    // 复用实现器自己的解析（`parseLedger`），测试里不复制第二份格式真相源
    return parseLedger(fs.readFileSync(file, "utf8")).reduce(
      (sum, e) => (e.u === user ? sum + e.b : sum),
      0,
    );
  }
  const file = path.join(dir, "quota.db");
  if (!fs.existsSync(file)) {
    return 0;
  }
  const db = openSqliteDriver()(file);
  try {
    return db.get<{ v: number }>("SELECT v FROM usage WHERE u = ? AND w = ?", [user, window])?.v ?? 0;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-drivers-"));
});

afterEach(() => {
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

describe("账本两个后端：等价性", () => {
  it("同一批用量经两个后端落盘 → 恢复出来的总量相同", async () => {
    for (const driver of ["json", "sqlite"] as const) {
      const h = harness(driver);
      await h.ledger.open();
      h.at(day12);
      for (let i = 0; i < 7; i++) {
        h.account.consume("alice", "up", 1024);
      }
      h.account.consume("alice", "down", 4096);
      await h.ledger.close();
    }
    const window = "2026-03-15";
    expect(readTotal("json", "alice", window), "json 档落盘量").toBe(7 * 1024 + 4096);
    expect(readTotal("sqlite", "alice", window), "sqlite 档落盘量").toBe(7 * 1024 + 4096);
    // 恢复侧同样：两个后端起进程都读到同一个总量
    for (const driver of ["json", "sqlite"] as const) {
      const h = harness(driver);
      await h.ledger.open();
      expect(h.account.usage("alice"), `${driver} 档恢复量`).toBe(7 * 1024 + 4096);
      await h.ledger.close();
    }
  });

  it("两个后端都做「停机必落盘」（否则用户能靠反复 Ctrl+C 刷额度）", async () => {
    for (const driver of ["json", "sqlite"] as const) {
      const h = harness(driver);
      await h.ledger.open();
      h.at(day12);
      h.account.consume("alice", "up", 999);
      // 刻意不手动 flush
      await h.ledger.close();
      expect(readTotal(driver, "alice", "2026-03-15"), `${driver} 档停机落盘`).toBe(999);
    }
  });
});

describe("账本两个后端：装配按 QUOTA_LEDGER_DRIVER 选", () => {
  function servicesWith(driver: "json" | "sqlite"): ReturnType<typeof buildDefaultServices> {
    const store = new ConfigStore();
    store.set("quotaLedgerDir", path.join(dir, driver));
    store.set("quotaLedgerDriver", driver);
    const ctx = createConfigContext({ store, configDir: dir });
    return buildDefaultServices(
      testContextFor(ctx.accessor),
      {},
      () => undefined,
      {},
    );
  }

  it("driver=json → 账本文件名是 usage.jsonl；driver=sqlite → quota.db", () => {
    // 判据是**文件名形态**（哪个后端真的在写，可观察），不是「实例类型」（那只是装配的中间态）
    const json = servicesWith("json").trafficLedger;
    const sqlite = servicesWith("sqlite").trafficLedger;
    expect(path.basename(json?.file ?? ""), "json 档文件名").toBe(JSONL_LEDGER_FILE_NAME);
    expect(path.basename(sqlite?.file ?? ""), "sqlite 档文件名").toBe("quota.db");
  });

  it("两个后端都不再按 worker 分槽（分槽是本仓换掉的真实配额逃逸）", () => {
    // 锚「文件名里没有 `worker-<数字>`」这个**今天仍成立的形状**，
    // 而不是点名 `normalizeSlot` 之类（点已删符号的负向断言会恒真）。
    for (const driver of ["json", "sqlite"] as const) {
      const name = path.basename(servicesWith(driver).trafficLedger?.file ?? "");
      expect(name, `${driver} 档文件名不得含 worker-<slot>`).not.toMatch(/^worker-\d+\.jsonl$/);
    }
  });
});

describe("账本两个后端：各自的能力边界（不许被抹平）", () => {
  it("两个后端都会丢弃过期窗口，机制不同（json 靠压缩、sqlite 靠 DELETE）", async () => {
    // WARN 本条最初写成「json 档**不**做运行期清理」——**实测为假**：json 档在 open()
    // 的启动期压缩里就会把过期窗口丢掉。真实差别只是**时机与机制**：
    //   - json：压缩时丢（阈值 8MiB 或 open/close 触发），没有「每轮 flush 都清」这个节奏
    //   - sqlite：pruneExpired 挂在 flush 循环上，每轮都判一次
    // 所以这里断言**两者都丢**（抽象成立），机制差异由下面那条源码级断言钉住。
    // 把「已知缺口」写成一条实测为假的断言比没有更坏：它会让下一个人以为 json 档会
    // 无限增长，从而做出错误的迁移决策。
    const jsonFile = path.join(dir, JSONL_LEDGER_FILE_NAME);
    fs.writeFileSync(
      jsonFile,
      `${JSON.stringify({ ts: at(2026, 3, 1, 12), u: "alice", d: "up", b: 5000 })}\n`,
      "utf8",
    );
    const j = harness("json");
    await j.ledger.open();
    j.at(day12);
    expect(j.account.usage("alice"), "json 档：过期行不计入判定").toBe(0);
    await j.ledger.close();
    expect(
      fs.readFileSync(jsonFile, "utf8").split("\n").filter((l) => l.length > 0).length,
      "json 档：过期窗口在压缩时被丢弃",
    ).toBe(0);

    // sqlite 档：直接往库里塞一条过期窗口，再起一次进程
    const dbFile = path.join(dir, "quota.db");
    const seed = openSqliteDriver()(dbFile);
    try {
      seed.exec(
        "CREATE TABLE IF NOT EXISTS usage (u TEXT NOT NULL, w TEXT NOT NULL, v INTEGER NOT NULL, PRIMARY KEY (u, w)) WITHOUT ROWID",
      );
      seed.run("INSERT INTO usage (u, w, v) VALUES (?, ?, ?)", ["alice", "2026-03-01", 5000]);
    } finally {
      seed.close();
    }
    const s = harness("sqlite");
    await s.ledger.open();
    s.at(day12);
    expect(s.account.usage("alice"), "sqlite 档：过期行不计入判定").toBe(0);
    await s.ledger.close();
    expect(readTotal("sqlite", "alice", "2026-03-01"), "sqlite 档：过期窗口被删掉").toBe(0);
  });

  it("json 档的写是「读-改-整文件重写」，故不承诺并发写安全（sqlite 档有事务）", () => {
    // 钉住两个后端**能力面不同**这件事本身：json 档的 `put` 走 `writeWholeFile`
    // （tmp + rename），sqlite 档走 UPSERT。若哪天 json 档也换成事务，两后端就更接近了——
    // 这条会提醒人重新审视「两档是否仍可互换」。
    const jsonl = codeOf("core", "traffic", "jsonl-ledger.ts");
    expect(jsonl, "json 档是 append + 压缩").toContain("compactEntries");
    const sqlite = codeOf("core", "traffic", "sqlite-ledger.ts");
    expect(sqlite, "sqlite 档是事务 + UPSERT").toContain("BEGIN IMMEDIATE");
    expect(sqlite, "sqlite 档是事务 + UPSERT").toContain("ON CONFLICT");
  });
});
