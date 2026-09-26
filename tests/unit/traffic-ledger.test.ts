/**
 * 流量配额的**落盘账本**（Phase 5b-2）：格式、追加、恢复、压缩、失败韧性
 *
 * @description
 * `unit/traffic-account.test.ts` 答「判定本身对不对」、`unit/traffic-window.test.ts` 答
 * 「这条用量属于哪个窗口」。本文件答**第三件事**：**这本账怎么活过一次重启**。
 *
 * 1. **重启恢复**（本切片的核心价值）：烧掉 N 字节 → 停机 → 再起 → `usage()` 仍含 N。
 * 2. **压缩幂等** + 压缩前后用量一致。
 * 3. **崩溃安全**：`.tmp` 残留不污染原文件；压缩真失败时原文件仍完整可读。
 * 4. **slot 隔离**：不同 slot 写不同文件、互不污染；同 slot 重启读回自己的账。
 * 5. **零成本档**：没有非全 0 的 `quota` → 不建目录 / 不开句柄 / 不起定时器。
 * 6. **写盘失败韧性**：内存计数继续、`usage()` 可读、发事件、恢复后补写。
 * 7. **窗口过期**：只结算当前窗口；压缩清理过期窗口（含「28 个 sub 跨 28 天」规模档）。
 * 8. **停机落盘**：断言停机前最后一次消耗真的进了文件（读**文件内容**，不是 spy）。
 * 9. **负向源码断言**：账本两个文件零定时器（flush-loop 恰好一处）、零 LRU、零限速字段；
 *    `core/**` 与 `runtime/**` 零 `process.env`；`config → core` 的边只允许 `import type`。
 *
 * **关于写失败注入的口径**：本文件用 `vi.mock("node:fs/promises")` 把 `handle.write`
 * 换成可控的 reject。理由是**可移植性**：本仓主战场是 Windows CI，造不出一个稳定的
 * 真实 `ENOSPC`/`EACCES`（`chmod` 在 Windows 上只切只读属性，而句柄已开时写入照旧成功）。
 * 被测的是 `runOnce` 的 catch/回队/上抛逻辑，`FileHandle.write` 本身是 Node 的实现。
 * 另配一条**真 IO** 的失败档（把 `.tmp` 预置成目录 → 压缩真拿到 `EISDIR`/`EPERM`），
 * 证明「压缩失败 → 原文件完好 → 句柄照常重开 → append 继续」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 可开关的写失败注入 + rename 计数（见文件头「关于写失败注入的口径」）
 * @description `vi.mock` 工厂被提升到文件最上方，所以这两个对象必须用 `vi.hoisted`
 * 一起提升，否则工厂闭包引用的是尚未初始化的 TDZ。
 */
const probe = vi.hoisted(() => ({ failWrite: false, renames: 0, writes: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const patched = {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      probe.renames += 1;
      await actual.rename(from, to);
    },
    open: async (target: string, flags: string): Promise<unknown> => {
      const handle = await actual.open(target, flags);
      // ⚠️ `FileHandle.write` 依赖 `this`，必须**先 bind** 再从代理里转发；
      // 反射出来的裸函数直接调会 `TypeError: Illegal invocation`，而那个错会被
      // 账本的 catch 吞成「没落盘」—— 表现是「所有写入都静默失败」，极难定位。
      const realWrite = (
        Reflect.get(handle, "write") as (...args: unknown[]) => Promise<unknown>
      ).bind(handle);
      // **总是**返回代理：`write` 在**调用时**才读 `probe.failWrite`。
      // 若在 open 时就按当时的开关决定返不返回代理，用例就会因为「开关晚于 open 打开」
      // 而静默测了个真磁盘（表现为「注入失败后 delta 照样落盘」——最容易被放过的那种假绿）。
      return new Proxy(handle, {
        get(handle_, prop) {
          if (prop === "write") {
            return async (...args: unknown[]): Promise<unknown> => {
              if (!probe.failWrite) {
                return realWrite(...args);
              }
              probe.writes += 1;
              const err: NodeJS.ErrnoException = new Error(
                "ENOSPC: no space left on device, write",
              );
              err.code = "ENOSPC";
              throw err;
            };
          }
          const value = Reflect.get(handle_, prop);
          return typeof value === "function" ? value.bind(handle_) : value;
        },
      });
    },
  };
  return { ...actual, default: patched };
});

import { ConfigStore } from "@/config/index.js";
import {
  DEFAULT_LEDGER_COMPACT_BYTES,
  DEFAULT_TRAFFIC_SLOT,
  JsonlTrafficLedger,
  TRAFFIC_SLOT_ENV,
  compactEntries,
  ledgerFileName,
  normalizeSlot,
  parseLedger,
  quotaWindow,
  summarizeCurrent,
  type QuotaWindow,
  type RestoredLedger,
  type TrafficLedgerError,
  type UserQuota,
} from "@/core/traffic/index.js";
import { MemoryTrafficAccount } from "@/core/traffic/memory.js";
import { hasConfiguredQuota } from "@/runtime/services.js";
import { codeOf } from "../helpers/source-scan.js";

const HOUR = 3_600_000;
/** 本地构造某个时刻（时区无关地落在那一刻） */
const at = (y: number, m: number, d: number, h = 0, mi = 0): number =>
  new Date(y, m - 1, d, h, mi, 0, 0).getTime();

/** 便捷：算出某时刻的窗口键（断言里表达「这个键等于当前窗口」而不是抄一份算法） */
function windowKeyOf(nowMs: number, window: QuotaWindow, shiftHours: number): string {
  const shifted = new Date(nowMs - shiftHours * HOUR);
  const month = String(shifted.getMonth() + 1).padStart(2, "0");
  const date = String(shifted.getDate()).padStart(2, "0");
  return window === "month"
    ? `${shifted.getFullYear()}-${month}`
    : `${shifted.getFullYear()}-${month}-${date}`;
}

const UNLIMITED: UserQuota = { bytesUp: 0, bytesDown: 0, bytesTotal: 0 };
const withWindow = (window: QuotaWindow, rest: Partial<UserQuota> = {}): UserQuota => ({
  ...UNLIMITED,
  window,
  ...rest,
});

interface HarnessOptions {
  readonly quotas?: Record<string, UserQuota>;
  readonly slot?: string;
  readonly resetHour?: () => number;
  readonly compactBytes?: () => number;
  readonly flushMs?: () => number;
  readonly enabled?: () => boolean;
  readonly start?: number;
  readonly onError?: (event: TrafficLedgerError) => void;
}

interface Harness {
  readonly account: MemoryTrafficAccount;
  readonly ledger: JsonlTrafficLedger;
  readonly file: string;
  readonly errors: TrafficLedgerError[];
  readonly restored: RestoredLedger[];
  /** 拨钟（**账本与判定共用同一个时钟源**，这正是「delta 的 ts 与窗口键同一时刻」的由来） */
  at(t: number): Harness;
}

/**
 * 组一套「内存账本 + 它的落盘副本」
 * @description 刻意**不走** `runtime/services.ts` 的默认装配：那层要 ConfigAccessor 与
 * `users.json`，本文件要的是「窗口/时刻/目录/阈值」四个可自由注入的口子。装配形状与
 * `buildDefaultServices` 逐字同构（同一个 `MemoryTrafficAccount` + `bindSink` +
 * `onRestore → seed`），所以这里跑通的路径就是生产路径。
 */
function harness(dir: string, options: HarnessOptions = {}): Harness {
  const clock = { now: options.start ?? at(2026, 3, 15, 12) };
  const resetHour = options.resetHour ?? ((): number => 0);
  const errors: TrafficLedgerError[] = [];
  const restored: RestoredLedger[] = [];
  const account = new MemoryTrafficAccount((user: string) => options.quotas?.[user], {
    resetHour,
    now: (): number => clock.now,
  });
  const ledger = new JsonlTrafficLedger({
    dir,
    slot: options.slot,
    // 默认给一个「很长」的间隔：用例全部靠显式 `flush()` 驱动，**不依赖真实时钟**。
    // 定时器那条路径另有专门一条用例（短间隔 + 真 sleep）。
    flushMs: options.flushMs ?? ((): number => 3_600_000),
    resetHour,
    windowFor: (user: string): QuotaWindow => quotaWindow(options.quotas?.[user]?.window),
    enabled: options.enabled ?? ((): boolean => true),
    compactBytes: options.compactBytes,
    now: (): number => clock.now,
    onRestore: (value) => {
      restored.push(value);
      account.seed(value);
    },
    onError: (event) => {
      errors.push(event);
      options.onError?.(event);
    },
  });
  account.bindSink(ledger);
  const self: Harness = {
    account,
    ledger,
    file: ledger.file,
    errors,
    restored,
    at: (t: number): Harness => {
      clock.now = t;
      return self;
    },
  };
  return self;
}

/** 重开一次（模拟「停机 → 再起」）：同一个目录/槽位/时刻口径，全新的一对对象 */
function restart(dir: string, options: HarnessOptions = {}): Harness {
  return harness(dir, options);
}

let dir = "";

beforeEach(() => {
  probe.failWrite = false;
  probe.renames = 0;
  probe.writes = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "traffic-ledger-"));
});

afterEach(() => {
  probe.failWrite = false;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 读账本文件的所有非空行 */
function lines(file: string): string[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

/** 账本文件里所有 delta 的字节合计（两个方向都算） */
function totalBytes(file: string): number {
  return parseLedger(fs.readFileSync(file, "utf8")).reduce((sum, e) => sum + e.b, 0);
}

const dayAt = (d: number, h = 12): number => at(2026, 3, d, h);

describe("core/traffic ledger：文件布局与槽位（稳定序号，不是 PID）", () => {
  it("文件路径是 <dir>/worker-<slot>.jsonl；单进程/库模式缺省 \"0\"", () => {
    expect(DEFAULT_TRAFFIC_SLOT).toBe("0");
    expect(ledgerFileName(path.join("q", "quota"), undefined)).toBe(
      path.join("q", "quota", "worker-0.jsonl"),
    );
    expect(ledgerFileName(path.join("q", "quota"), "0")).toBe(
      path.join("q", "quota", "worker-0.jsonl"),
    );
    // cluster worker：1..N
    expect(ledgerFileName(path.join("q", "quota"), "1")).toBe(
      path.join("q", "quota", "worker-1.jsonl"),
    );
    expect(ledgerFileName(path.join("q", "quota"), "7")).toBe(
      path.join("q", "quota", "worker-7.jsonl"),
    );
  });

  it("槽位值会被拼进路径，故非数字一律按路径穿越面拒绝（回落 \"0\"）", () => {
    for (const hostile of [
      "../../evil",
      "..",
      "1; rm -rf /",
      "0x1",
      "12345",
      " 1",
      "-1",
      "",
    ]) {
      expect(normalizeSlot(hostile), `槽位 ${JSON.stringify(hostile)} 必须被拒`).toBe("0");
    }
    expect(normalizeSlot("1")).toBe("1");
    expect(normalizeSlot("1024")).toBe("1024");
    expect(normalizeSlot(undefined)).toBe("0");
  });

  it("env 名是 PROXY_WORKER_SLOT，且刻意不进 FIELDS（它不是配置项）", () => {
    expect(TRAFFIC_SLOT_ENV).toBe("PROXY_WORKER_SLOT");
    // 不在配置表里：槽位不进 ConfigStore、不参与 loadConfig、不打印在 logConfig 快照里。
    // 塞进 FIELDS 会让 setup-env 的「与 FIELDS 逐项相同」断言与「env 唯一真相源」失去意义。
    expect(codeOf("config", "schema", "fields.ts")).not.toContain("PROXY_WORKER_SLOT");
    const setupEnv = fs.readFileSync(path.join(__dirname, "..", "setup-env.ts"), "utf8");
    expect(setupEnv).not.toContain("PROXY_WORKER_SLOT");
  });

  it("一行一条 delta，形状是 { ts, u, d, b }（只写增量，绝不写绝对值）", async () => {
    const h = harness(dir, { quotas: { alice: UNLIMITED } });
    await h.ledger.open();
    h.at(at(2026, 3, 15, 12));
    h.account.consume("alice", "up", 100);
    h.account.consume("alice", "down", 40);
    await h.ledger.close();

    const raw = lines(h.file);
    expect(raw).toEqual([
      `{"ts":${at(2026, 3, 15, 12)},"u":"alice","d":"up","b":100}`,
      `{"ts":${at(2026, 3, 15, 12)},"u":"alice","d":"down","b":40}`,
    ]);
    // 绝对值是**读取时求和**的产物，文件里没有那个 140
    expect(raw.join("\n")).not.toContain("140");
  });
});

describe("core/traffic ledger：重启恢复（本切片的核心价值）", () => {
  const opts: HarnessOptions = {
    quotas: { alice: withWindow("day", { bytesTotal: 10_000_000 }) },
  };

  it("烧掉 N 字节 → 停机 → 再起，usage() 仍含那 N 字节", async () => {
    // ---- 第一次运行 ----
    const first = harness(dir, opts);
    await first.ledger.open();
    first.at(at(2026, 3, 15, 12));
    for (let i = 0; i < 7; i++) {
      first.account.consume("alice", "up", 1024);
    }
    first.account.consume("alice", "down", 4096);
    expect(first.account.usage("alice")).toEqual({ up: 7 * 1024, down: 4096 });
    await first.ledger.close();

    // 停机后文件里真的有账（不靠 spy，直接读文件）
    expect(totalBytes(first.file)).toBe(7 * 1024 + 4096);

    // ---- 第二次运行：全新对象，同一个目录/槽位 ----
    const second = restart(dir, opts);
    await second.ledger.open();
    // **恢复完成早于任何新计量**：这里一个字节都还没 consume
    expect(second.restored).toHaveLength(1);
    expect(second.account.usage("alice")).toEqual({ up: 7 * 1024, down: 4096 });
    // 恢复之后继续计量是叠加，不是覆盖
    second.account.consume("alice", "up", 1);
    expect(second.account.usage("alice")).toEqual({ up: 7 * 1024 + 1, down: 4096 });
    await second.ledger.close();
  });

  it("恢复出来的用量立刻参与判定（重启不是配额刷新窗口）", async () => {
    // 上一窗口烧满了 100 字节 → 停机 → 再起。若恢复失效，用户就白拿一份满额，
    // 反复「烧满 → Ctrl+C → 再起」就能无限白嫖 —— 这是本切片要消灭的故障形态。
    const limited: HarnessOptions = {
      quotas: { alice: withWindow("day", { bytesTotal: 100 }) },
    };
    const first = harness(dir, limited);
    await first.ledger.open();
    first.at(at(2026, 3, 15, 12));
    first.account.consume("alice", "up", 100);
    // 被拒的那 1 字节**照实计数**（5a 裁决：账本不截断到上限），所以磁盘上是 101。
    // 判据用「与内存逐字相同」而不是抄一个数 —— 内存与磁盘必须永远一致。
    expect(first.account.consume("alice", "up", 1).allow).toBe(false);
    const usageAtStop = first.account.usage("alice");
    expect(usageAtStop).toEqual({ up: 101, down: 0 });
    await first.ledger.close();

    const second = restart(dir, limited);
    await second.ledger.open();
    expect(second.account.usage("alice")).toEqual(usageAtStop);
    expect(second.account.consume("alice", "up", 1).allow).toBe(false);
    expect(second.account.consume("alice", "up", 1).scope).toBe("total");
    await second.ledger.close();
  });

  it("停机落盘：断言停机前最后一次消耗真的进了文件内容（不是 spy）", async () => {
    const h = harness(dir, { quotas: { alice: UNLIMITED } });
    await h.ledger.open();
    h.at(at(2026, 3, 15, 12));
    h.account.consume("alice", "up", 111);
    h.account.consume("alice", "down", 222);
    // 此刻一个字节都还没 flush（间隔给了 1 小时）
    expect(lines(h.file)).toEqual([]);
    await h.ledger.close();
    // 文件内容逐字节验证：停机前**最后那一笔**也在里面
    expect(lines(h.file)).toEqual([
      `{"ts":${at(2026, 3, 15, 12)},"u":"alice","d":"up","b":111}`,
      `{"ts":${at(2026, 3, 15, 12)},"u":"alice","d":"down","b":222}`,
    ]);
    expect(h.ledger.queued).toBe(0);
  });

  it("open / close 都幂等（start→stop→start 同一对对象）", async () => {
    const h = harness(dir, { quotas: { alice: UNLIMITED } });
    await h.ledger.open();
    h.at(at(2026, 3, 15, 12));
    h.account.consume("alice", "up", 64);
    await h.ledger.close();
    await h.ledger.close(); // 幂等：第二次是空转，不重复落、不抛
    await h.ledger.open();
    await h.ledger.open(); // 幂等
    expect(h.ledger.enabled).toBe(true);
    expect(h.account.usage("alice")).toEqual({ up: 64, down: 0 });
    await h.ledger.close();
    expect(h.ledger.enabled).toBe(false);
  });
});

describe("core/traffic ledger：槽位隔离（不同 slot 互不污染；同 slot 恢复）", () => {
  const quotas: Record<string, UserQuota> = { alice: UNLIMITED };

  it("两个不同 slot 写两个不同文件、互不污染", async () => {
    const w1 = harness(dir, { quotas, slot: "1" });
    const w2 = harness(dir, { quotas, slot: "2" });
    expect(w1.file).not.toBe(w2.file);
    await w1.ledger.open();
    await w2.ledger.open();
    const t = at(2026, 3, 15, 12);
    w1.at(t);
    w2.at(t);
    w1.account.consume("alice", "up", 1000);
    w1.account.consume("alice", "down", 5);
    w2.account.consume("alice", "up", 7);
    await w1.ledger.close();
    await w2.ledger.close();

    expect(fs.readdirSync(dir).sort()).toEqual(["worker-1.jsonl", "worker-2.jsonl"]);
    // 每个文件只有自己那份账
    expect(parseLedger(fs.readFileSync(w1.file, "utf8")).map((e) => e.b)).toEqual([1000, 5]);
    expect(parseLedger(fs.readFileSync(w2.file, "utf8")).map((e) => e.b)).toEqual([7]);
    expect(totalBytes(w1.file)).toBe(1005);
    expect(totalBytes(w2.file)).toBe(7);
  });

  it("同 slot 重启读回自己的文件（两个 slot 各自的用量互不串）", async () => {
    const t = at(2026, 3, 15, 12);
    const a1 = harness(dir, { quotas, slot: "1" });
    const b1 = harness(dir, { quotas, slot: "2" });
    await a1.ledger.open();
    await b1.ledger.open();
    a1.at(t);
    b1.at(t);
    a1.account.consume("alice", "up", 11);
    b1.account.consume("alice", "up", 22);
    await a1.ledger.close();
    await b1.ledger.close();

    const a2 = restart(dir, { quotas, slot: "1" });
    const b2 = restart(dir, { quotas, slot: "2" });
    await a2.ledger.open();
    await b2.ledger.open();
    expect(a2.account.usage("alice")).toEqual({ up: 11, down: 0 });
    expect(b2.account.usage("alice")).toEqual({ up: 22, down: 0 });
    await a2.ledger.close();
    await b2.ledger.close();
  });
});

describe("core/traffic ledger：零成本档（没配配额就一个字节的开销都不该有）", () => {
  it("没有任何用户配非全 0 的 quota → 不建目录、不开句柄、不起定时器、record 全程 no-op", async () => {
    const target = path.join(dir, "never-created");
    const h = harness(target, {
      // 全 0 的 quota 按契约等于「不限流」= 没配
      quotas: { alice: UNLIMITED, bob: { ...UNLIMITED, window: "day" } },
      enabled: (): boolean => false,
    });
    await h.ledger.open();
    // 目录根本不存在 —— 这是可观测的硬证据（不是「建了但空」：判据在 mkdir **之前**返回）
    expect(fs.existsSync(target)).toBe(false);
    expect(h.ledger.enabled).toBe(false);
    h.at(at(2026, 3, 15, 12));
    // 判定照常计量（内存账本不受账本缺席影响）
    h.account.consume("alice", "up", 999);
    expect(h.account.usage("alice")).toEqual({ up: 999, down: 0 });
    // 队列恒空：没启用时让 pending 无限增长才是 bug（「没配配额」反而吃内存）
    expect(h.ledger.queued).toBe(0);
    await h.ledger.close();
    expect(fs.existsSync(target)).toBe(false);
  });

  it("零成本判据是**文件事实**：全 0 的 quota 不算「配了」，有任一非零子字段才算", () => {
    // 这一条是零成本档与 `quota-inert` 告警的**同一份**判据（两处各写一份，
    // 迟早会出现「告警说没配、账本说配了」）。
    //
    // 每个档用**各自的文件路径**：`readJsonCached` 的缓存键是 `label + path` 且对同一
    // path 有 1s stat 节流，同一路径连着改内容会读到上一档的结果（其它热加载用例靠
    // `sleep(1100)` 绕过，这里用不同路径更干净也更快）。
    let seq = 0;
    const probeFor = (quota: unknown): boolean => {
      const usersFile = path.join(dir, `users-${seq++}.json`);
      fs.writeFileSync(
        usersFile,
        JSON.stringify([{ username: "a", password: "p", ...(quota ? { quota } : {}) }]),
        "utf8",
      );
      const store = new ConfigStore({ authUsersFile: usersFile });
      return hasConfiguredQuota({ get: store.get.bind(store) });
    };
    expect(probeFor(undefined)).toBe(false); // 完全没配 quota
    expect(probeFor({ bytesUp: 0, bytesDown: 0, bytesTotal: 0 })).toBe(false);
    // 只配了 window 也不算「有上限」（窗口不限制任何字节）
    expect(probeFor({ window: "day" })).toBe(false);
    // 有一个非零子字段即为真
    expect(probeFor({ bytesTotal: 1 })).toBe(true);
    expect(probeFor({ bytesUp: 2 })).toBe(true);
    expect(probeFor({ bytesDown: 3 })).toBe(true);
  });

  it("users.json 缺失 → 空表 → 没配（非全 0 配额一个都没有）", () => {
    const store = new ConfigStore({ authUsersFile: path.join(dir, "nope", "users.json") });
    expect(hasConfiguredQuota({ get: store.get.bind(store) })).toBe(false);
  });
});

describe("core/traffic ledger：窗口过期（只结算当前窗口 + 压缩清理）", () => {
  it("账本里存在旧窗口条目时，只按当前窗口结算，旧条目不影响判定", async () => {
    const quotas: Record<string, UserQuota> = { alice: withWindow("day") };
    const file = ledgerFileName(dir, "0");
    // 手写一份「多窗口」账本：3/13、3/14（旧）与 3/15（当前）三条 up
    fs.writeFileSync(
      file,
      `${[13, 14, 15].map((d) => `{"ts":${dayAt(d)},"u":"alice","d":"up","b":${d * 10}}`).join("\n")}\n`,
      "utf8",
    );

    const h = harness(dir, { quotas });
    h.at(dayAt(15));
    await h.ledger.open();
    // 3/13 的 130 与 3/14 的 140 **不参与**判定：只有 3/15 的 150
    expect(h.account.usage("alice")).toEqual({ up: 150, down: 0 });
    expect(h.restored[0].get("alice")).toEqual({
      windowKey: windowKeyOf(dayAt(15), "day", 0),
      up: 150,
      down: 0,
    });
    await h.ledger.close();
  });

  it("窗口类型按用户独立：day 用户与 month 用户在同一个账本文件里各按各的", async () => {
    const quotas: Record<string, UserQuota> = {
      alice: withWindow("day"),
      bob: withWindow("month"),
    };
    const file = ledgerFileName(dir, "0");
    // alice 有一条 3/14（旧 day）与一条 3/15；bob 只有一条 3/02（本月，仍有效）
    fs.writeFileSync(
      file,
      `${[
        `{"ts":${dayAt(14)},"u":"alice","d":"up","b":5}`,
        `{"ts":${dayAt(15)},"u":"alice","d":"down","b":7}`,
        `{"ts":${at(2026, 3, 2, 8)},"u":"bob","d":"up","b":9}`,
      ].join("\n")}\n`,
      "utf8",
    );

    const h = harness(dir, { quotas });
    h.at(dayAt(15));
    await h.ledger.open();
    expect(h.account.usage("alice")).toEqual({ up: 0, down: 7 });
    expect(h.account.usage("bob")).toEqual({ up: 9, down: 0 });
    await h.ledger.close();
  });

  it("压缩丢弃已过期窗口的条目：28 个 sub 跨 28 天 → 压缩后文件行数降到 0", async () => {
    // 这就是「authType=jwt 的 sub 无限增长」在**持久层**的答案：
    // 28 天 28 个不同 sub 各留一行，一天后一次压缩全部消失，重启时不会回到内存。
    const quotas: Record<string, UserQuota> = {};
    const h = harness(dir, { quotas, compactBytes: (): number => Number.MAX_SAFE_INTEGER });
    await h.ledger.open();
    for (let d = 1; d <= 28; d++) {
      h.at(dayAt(d));
      quotas[`sub-${d}`] = withWindow("day");
      h.account.consume(`sub-${d}`, "up", d);
      await h.ledger.flush();
    }
    await h.ledger.close();
    // 阈值给到极大 → 本次压缩只由「启动时」这一个安全点触发
    expect(lines(h.file)).toHaveLength(28);

    // 第 29 天重启：open() 读完立刻压缩，28 条全部过期
    const next = restart(dir, { quotas });
    next.at(dayAt(29));
    await next.ledger.open();
    expect(lines(h.file)).toHaveLength(0);
    // 过期槽位**根本没有回到内存**：读一次是零值、且不建槽
    expect(next.account.usage("sub-1")).toEqual({ up: 0, down: 0 });
    expect(next.account.size).toBe(0);
    await next.ledger.close();
  });

  it("压缩保留当前窗口的条目（混合档：过期与当前的共存）", async () => {
    const quotas: Record<string, UserQuota> = {};
    const h = harness(dir, { quotas, compactBytes: (): number => Number.MAX_SAFE_INTEGER });
    await h.ledger.open();
    h.at(dayAt(14));
    quotas.stale = withWindow("day");
    h.account.consume("stale", "up", 11);
    await h.ledger.flush();
    h.at(dayAt(15));
    quotas.fresh = withWindow("day");
    h.account.consume("fresh", "up", 22);
    await h.ledger.flush();
    await h.ledger.close();
    expect(lines(h.file)).toHaveLength(2);

    const next = restart(dir, { quotas });
    next.at(dayAt(15));
    await next.ledger.open();
    // 只有 fresh 留下
    expect(lines(next.file)).toEqual([`{"ts":${dayAt(15)},"u":"fresh","d":"up","b":22}`]);
    expect(next.account.usage("fresh")).toEqual({ up: 22, down: 0 });
    expect(next.account.usage("stale")).toEqual({ up: 0, down: 0 });
    await next.ledger.close();
  });
});

describe("core/traffic ledger：压缩（幂等 + 两个安全点 + 崩溃安全）", () => {
  it("compactEntries 是纯函数：只保留当前窗口、按 (user,窗口) 求和、ts 取幸存条目最大值", () => {
    const windowFor = (): QuotaWindow => "day";
    const entries = parseLedger(
      [
        `{"ts":${dayAt(15, 1)},"u":"a","d":"up","b":10}`,
        `{"ts":${dayAt(15, 2)},"u":"a","d":"up","b":20}`,
        `{"ts":${dayAt(15, 3)},"u":"a","d":"down","b":5}`,
        `{"ts":${dayAt(14, 9)},"u":"a","d":"up","b":999}`, // 旧窗口 → 丢弃
        `{"ts":${dayAt(15, 4)},"u":"b","d":"down","b":7}`,
      ].join("\n"),
    );
    // `ts` 是**每用户一个**（幸存条目的最大值，两个方向共用）而不是每方向一个：
    // 它唯一的用途是「重压时算出同一个窗口键」，方向各自记一份纯属噪音。
    expect(compactEntries(entries, windowFor, 0, dayAt(15, 6))).toEqual([
      { ts: dayAt(15, 3), u: "a", d: "up", b: 30 },
      { ts: dayAt(15, 3), u: "a", d: "down", b: 5 },
      { ts: dayAt(15, 4), u: "b", d: "down", b: 7 },
    ]);
  });

  it("压缩幂等：压两次结果逐字节相同（保留幸存条目的 ts 是原因）", () => {
    const windowFor = (): QuotaWindow => "day";
    const entries = parseLedger(
      [
        `{"ts":${dayAt(15, 1)},"u":"a","d":"up","b":10}`,
        `{"ts":${dayAt(15, 5)},"u":"a","d":"up","b":20}`,
      ].join("\n"),
    );
    const once = compactEntries(entries, windowFor, 0, dayAt(15, 6));
    expect(compactEntries(once, windowFor, 0, dayAt(15, 9))).toEqual(once);
    // 同一窗口内换个时刻再压一次仍相同
    expect(compactEntries(once, windowFor, 0, at(2026, 3, 15, 23, 59))).toEqual(once);
  });

  it("文件级幂等：连开三次账本，文件内容逐字节不变，且用量在每次重启后保持一致", async () => {
    const quotas: Record<string, UserQuota> = { alice: withWindow("day") };
    const seed = harness(dir, { quotas });
    await seed.ledger.open();
    seed.at(dayAt(15));
    for (let i = 0; i < 20; i++) {
      seed.account.consume("alice", "up", 100);
      seed.account.consume("alice", "down", 10);
    }
    const usageBefore = seed.account.usage("alice");
    await seed.ledger.close();
    // 本次 open 时文件还是空的 → 启动期压缩无事可做；40 条 delta 原样落盘
    expect(lines(seed.file)).toHaveLength(40);

    // 第一次重启：启动期压缩把 40 条求和成两条（alice 的 up 与 down 各一条）
    const first = restart(dir, { quotas });
    first.at(dayAt(15));
    await first.ledger.open();
    expect(first.account.usage("alice")).toEqual(usageBefore);
    await first.ledger.close();
    expect(lines(first.file)).toHaveLength(2);
    const afterFirst = fs.readFileSync(first.file, "utf8");

    // 第二次重启：已经压不动了 → 逐字节不变
    const second = restart(dir, { quotas });
    second.at(dayAt(15));
    await second.ledger.open();
    expect(second.account.usage("alice")).toEqual(usageBefore);
    await second.ledger.close();
    expect(fs.readFileSync(second.file, "utf8")).toBe(afterFirst);
  });

  it("运行期按文件大小阈值压缩（第二个安全点，同一轮 flush 内做完）", async () => {
    // 阈值 300 字节：写够 delta 后，下一次 flush 内触发压缩（关句柄 → 压 → 重开）
    const quotas: Record<string, UserQuota> = { alice: withWindow("day") };
    const h = harness(dir, { quotas, compactBytes: (): number => 300 });
    await h.ledger.open();
    h.at(dayAt(15));
    for (let i = 0; i < 40; i++) {
      h.account.consume("alice", "up", 10);
    }
    await h.ledger.flush();
    // 40 条 delta 被压成 1 条（同一个用户 + 同一个窗口 + 同一方向）
    expect(lines(h.file)).toHaveLength(1);
    expect(totalBytes(h.file)).toBe(400);
    expect(probe.renames).toBeGreaterThanOrEqual(1);
    // 压缩后句柄已重开：还能继续追加
    h.account.consume("alice", "down", 3);
    await h.ledger.flush();
    expect(lines(h.file)).toHaveLength(2);
    await h.ledger.close();
    // 用量一条不少（压缩是重写，不是丢弃当前窗口）
    const next = restart(dir, { quotas });
    next.at(dayAt(15));
    await next.ledger.open();
    expect(next.account.usage("alice")).toEqual({ up: 400, down: 3 });
    await next.ledger.close();
  });

  it("压缩已经压不动的账本不会被反复压（compactedAt 门槛）", async () => {
    // 一份「每人一条」的账本压完大小不变。若只看阈值就会每次 flush 都全量重写一遍
    // （每次都要读全文件 + 写临时文件 + rename）。
    const quotas: Record<string, UserQuota> = { alice: withWindow("day") };
    const h = harness(dir, { quotas, compactBytes: (): number => 1 });
    await h.ledger.open();
    // 基线取在 open 之后：启动期那次压缩是对空文件做的，与本题无关
    const renamesAfterOpen = probe.renames;
    h.at(dayAt(15));
    h.account.consume("alice", "up", 10);
    await h.ledger.flush();
    const renamesAfterFirst = probe.renames;
    expect(renamesAfterFirst - renamesAfterOpen).toBe(1);
    for (let i = 0; i < 5; i++) {
      h.account.consume("alice", "up", 0); // 非正字节 → 不产生 delta
      await h.ledger.flush();
    }
    // 判据用 rename 次数（内容相同不足以证明「没重写」—— 幂等压缩产出同样的字节）
    expect(probe.renames).toBe(renamesAfterFirst);
    expect(lines(h.file)).toHaveLength(1);
    await h.ledger.close();
  });

  it("崩溃安全：残留的 .tmp 不污染原文件（且启动时被清掉）", async () => {
    const quotas: Record<string, UserQuota> = { alice: withWindow("day") };
    const first = harness(dir, { quotas });
    await first.ledger.open();
    first.at(dayAt(15));
    first.account.consume("alice", "up", 42);
    await first.ledger.close();

    // 模拟「压缩写到一半就崩」：留一个内容完全不同的 .tmp
    const tmp = `${first.file}.tmp`;
    fs.writeFileSync(tmp, '{"ts":0,"u":"attacker","d":"up","b":999999}\n', "utf8");

    const second = restart(dir, { quotas });
    second.at(dayAt(15));
    await second.ledger.open();
    // 恢复读的是**原文件**，不是 .tmp
    expect(second.account.usage("alice")).toEqual({ up: 42, down: 0 });
    expect(second.account.usage("attacker")).toEqual({ up: 0, down: 0 });
    // 残留的 .tmp 已被清掉（我们从不读它，删它只为不让垃圾一直堆着）
    expect(fs.existsSync(tmp)).toBe(false);
    await second.ledger.close();
  });

  it("压缩真失败时原文件仍完整可读（真 IO：.tmp 预置成目录 → writeFile 拿到 EISDIR/EPERM）", async () => {
    const quotas: Record<string, UserQuota> = { alice: withWindow("day") };
    const first = harness(dir, { quotas });
    await first.ledger.open();
    first.at(dayAt(15));
    first.account.consume("alice", "up", 77);
    first.account.consume("alice", "down", 5);
    await first.ledger.close();
    const original = fs.readFileSync(first.file, "utf8");

    const second = restart(dir, { quotas });
    // 把 .tmp 预置成**目录** → 压缩的 `writeFile(tmp)` 真拿到失败
    fs.mkdirSync(`${second.file}.tmp`, { recursive: true });
    second.at(dayAt(15));
    await second.ledger.open();
    expect(second.errors.length).toBeGreaterThan(0);
    // rename 从未发生 → 原文件逐字节完好
    expect(fs.readFileSync(second.file, "utf8")).toBe(original);
    // 恢复仍然拿到完整的旧账
    expect(second.account.usage("alice")).toEqual({ up: 77, down: 5 });
    // 压缩失败后句柄照常重开，append 继续（压缩失败不能变成「此后再也不落盘」）
    second.account.consume("alice", "up", 1);
    await second.ledger.flush();
    expect(totalBytes(second.file)).toBe(83);
    await second.ledger.close();
  });
});

describe("core/traffic ledger：写盘失败韧性（内存继续 + 可见事实 + 恢复后补写）", () => {
  it("append 失败：内存计数继续、usage() 可读、事件上抛；恢复写权限后 delta 被补写", async () => {
    const quotas: Record<string, UserQuota> = {
      alice: withWindow("day", { bytesTotal: 10_000 }),
    };
    const h = harness(dir, { quotas });
    await h.ledger.open();
    h.at(at(2026, 3, 15, 12));

    // ---- 注入写失败 ----
    probe.failWrite = true;
    h.account.consume("alice", "up", 1000);
    h.account.consume("alice", "down", 500);
    // 内存计数继续走：配额判定完全不受磁盘影响
    expect(h.account.usage("alice")).toEqual({ up: 1000, down: 500 });
    // 判定也照常（撞顶仍然被拒 —— 磁盘坏了不等于配额失效）
    h.account.consume("alice", "up", 20_000);
    expect(h.account.consume("alice", "up", 1).allow).toBe(false);

    await h.ledger.flush();
    // 一条可见事实（runtime 把它变成 traffic.ledger-error 事件 + CLI error 日志）
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0].path).toBe(h.file);
    expect((h.errors[0].error as NodeJS.ErrnoException).code).toBe("ENOSPC");
    // 未落盘的 delta **累积留待重试**（不是丢弃）：4 次 consume 各一条（含被拒的那 1 字节 ——
    // 5a 裁决「账本不截断到上限」，内存与磁盘因此记的是同一份账）
    expect(h.ledger.queued).toBe(4);
    // 文件里一个字都没有（失败的批次没有半写进去）
    expect(fs.existsSync(h.file) ? totalBytes(h.file) : 0).toBe(0);

    // ---- 恢复写权限，下一次 flush 补写全部累积的 delta ----
    probe.failWrite = false;
    await h.ledger.flush();
    expect(h.ledger.queued).toBe(0);
    expect(totalBytes(h.file)).toBe(1000 + 500 + 20_000 + 1);

    // 补写后的账与内存完全一致
    await h.ledger.close();
    const next = restart(dir, { quotas });
    next.at(at(2026, 3, 15, 12));
    await next.ledger.open();
    expect(next.account.usage("alice")).toEqual({ up: 21_001, down: 500 });
    await next.ledger.close();
  });

  it("反复失败不会丢掉 delta，每轮一条事实（不刷屏也不沉默）", async () => {
    const h = harness(dir, { quotas: { alice: withWindow("day") } });
    await h.ledger.open();
    h.at(at(2026, 3, 15, 12));
    probe.failWrite = true;
    h.account.consume("alice", "up", 10);
    for (let i = 0; i < 3; i++) {
      await h.ledger.flush();
      expect(h.ledger.queued).toBe(1);
    }
    expect(h.errors).toHaveLength(3);
    probe.failWrite = false;
    await h.ledger.flush();
    expect(h.ledger.queued).toBe(0);
    expect(h.errors).toHaveLength(3);
    expect(totalBytes(h.file)).toBe(10);
    await h.ledger.close();
  });

  it("onError 旁路抛错绝不能把「写盘失败」升级成「代理崩」", async () => {
    const h = harness(dir, {
      quotas: { alice: withWindow("day") },
      onError: (): void => {
        throw new Error("旁路自己炸了");
      },
    });
    await h.ledger.open();
    h.at(at(2026, 3, 15, 12));
    probe.failWrite = true;
    expect(() => h.account.consume("alice", "up", 1)).not.toThrow();
    await expect(h.ledger.flush()).resolves.toBeUndefined();
    probe.failWrite = false;
    // 队列仍被保留（失败被隔离成「没落盘」而不是「抛出去」）
    expect(h.ledger.queued).toBe(1);
    await h.ledger.flush();
    expect(h.ledger.queued).toBe(0);
    await h.ledger.close();
  });
});

describe("core/traffic ledger：落盘与 consume 的同步性互不干扰", () => {
  it("consume 在有账本时仍是同步函数、返回值仍不是 Promise", async () => {
    const h = harness(dir, { quotas: { alice: withWindow("day", { bytesTotal: 100 }) } });
    await h.ledger.open();
    h.at(at(2026, 3, 15, 12));
    const verdict = h.account.consume("alice", "up", 1);
    expect(verdict).not.toBeInstanceOf(Promise);
    expect(typeof (verdict as { then?: unknown }).then).toBe("undefined");
    // 挂上账本之后 consume 的返回值与耗时都仍与磁盘无关（入队成功即可返回）
    expect(verdict.allow).toBe(true);
    expect(h.ledger.queued).toBe(1);
    await h.ledger.close();
  });

  it("周期定时器真的在跑（短间隔 + 真实 sleep，不靠显式 flush）", async () => {
    // 唯一一条依赖真实时钟的用例：证明 `flush-loop.ts` 的自重排 setTimeout 真的连上了账本。
    // 间隔给 20ms、给足 1.5s 预算；判据是**文件内容**而不是 spy。
    const h = harness(dir, {
      quotas: { alice: withWindow("day") },
      flushMs: (): number => 20,
    });
    await h.ledger.open();
    h.at(at(2026, 3, 15, 12));
    h.account.consume("alice", "up", 512);
    const deadline = Date.now() + 1500;
    while (h.ledger.queued > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.ledger.queued).toBe(0);
    expect(totalBytes(h.file)).toBe(512);
    await h.ledger.close();
    // 停机后定时器已摘：不会再有新的落盘
    const after = fs.readFileSync(h.file, "utf8");
    await new Promise((r) => setTimeout(r, 60));
    expect(fs.readFileSync(h.file, "utf8")).toBe(after);
  });

  it("坏行被跳过而不是让整本账打不开（残缺文件必须还能读）", async () => {
    const quotas: Record<string, UserQuota> = { alice: withWindow("day") };
    const file = ledgerFileName(dir, "0");
    fs.writeFileSync(
      file,
      [
        `{"ts":${at(2026, 3, 15, 12)},"u":"alice","d":"up","b":30}`,
        '{"ts":notanumber,"u":"alice","d":"up","b":999}', // 类型不符
        "{ 这不是 json", // 解析失败（崩溃在写一半的残缺行）
        `{"ts":${at(2026, 3, 15, 12)},"u":"alice","d":"down","b":-5}`, // 非正字节
        `{"ts":${at(2026, 3, 15, 12)},"u":"alice","d":"sideways","b":7}`, // 非法方向
        `{"ts":${at(2026, 3, 15, 12)},"u":"alice","d":"down","b":12}`,
        "",
      ].join("\n"),
      "utf8",
    );
    const h = harness(dir, { quotas });
    h.at(at(2026, 3, 15, 12));
    await h.ledger.open();
    // 只算了那两条合法的（30 + 12）；坏行最多丢一点额度，绝不让整本账读不出来
    expect(h.account.usage("alice")).toEqual({ up: 30, down: 12 });
    await h.ledger.close();
  });
});

describe("core/traffic ledger：源码级负向断言（禁止项不许回来）", () => {
  it("账本两个文件零定时器；全切片唯一的定时器站点在 flush-loop.ts（恰好一处 setTimeout）", () => {
    // 5b-1 那条「memory.ts 零定时器」是**无锁论证**的一部分；5b-2 落了盘，
    // 定时器不可避免，但必须**收敛到唯一一处**，否则「清账靠定时器」这条会重新长回来。
    for (const file of ["ledger.ts", "memory.ts"] as const) {
      const code = codeOf("core", "traffic", file);
      expect(code, `${file} 不许有定时器`).not.toMatch(
        /setTimeout|setInterval|setImmediate|nextTick|queueMicrotask/,
      );
    }
    const loop = codeOf("core", "traffic", "flush-loop.ts");
    expect((loop.match(/setTimeout\(/g) ?? []).length).toBe(1);
    expect(loop).not.toMatch(/setInterval|setImmediate|nextTick|queueMicrotask/);
    // 定时器必须 unref：不许把进程钉住
    expect(loop).toMatch(/\.unref\(\)/);
  });

  it("memory.ts 零 async/零 await（5b-1 那条同步性断言到 5b-2 仍是原话）", () => {
    const code = codeOf("core", "traffic", "memory.ts");
    expect(code).not.toMatch(/\basync\b/);
    expect(code).not.toMatch(/\bawait\b/);
    // 落盘接线真的在 consume 路径上（入队一行而已，不是 IO）
    expect(code).toMatch(/sink\?\.record\(/);
    // 惰性滚动的两个动作仍在
    expect(code).toMatch(/windowKey\(/);
    expect(code).toMatch(/windowKey: key/);
  });

  it("账本零 LRU / 零容量淘汰（淘汰必须与配额窗口一起设计）", () => {
    for (const file of ["ledger.ts", "flush-loop.ts"] as const) {
      const code = codeOf("core", "traffic", file);
      expect(code, `${file} 不许有 LRU/容量淘汰`).not.toMatch(
        /\.delete\(|maxEntries|evict|\bLRU\b|\blru\b/i,
      );
    }
  });

  it("账本零限速字段、零滚动窗（5a 的两条否决不许借落盘绕回来）", () => {
    for (const file of ["ledger.ts", "flush-loop.ts", "types.ts"] as const) {
      const code = codeOf("core", "traffic", file);
      expect(code, `${file} 不许出现限速/连接池字段`).not.toMatch(
        /rateBps|maxConnections|concurrency|tokenBucket|\brolling\b/i,
      );
    }
  });

  it("core/** 与 runtime/** 零 process.env（槽位必须显式传进来）", () => {
    const srcRoot = path.join(__dirname, "..", "..", "src");
    for (const dirName of ["core", "runtime"] as const) {
      const found = fs.readdirSync(path.join(srcRoot, dirName), { recursive: true });
      const files = (found as string[]).filter((f) => f.endsWith(".ts"));
      expect(files.length).toBeGreaterThan(5);
      for (const rel of files) {
        const code = codeOf(dirName, rel);
        expect(code, `src/${dirName}/${rel} 不许读 process.env`).not.toMatch(
          /process\s*\.\s*env/,
        );
      }
    }
  });

  it("config → core 的边只允许 import type（值 import 会把 core 整条链拉进 config）", () => {
    const users = codeOf("config", "files", "users.ts");
    expect(users).toMatch(
      /import\s+type\s+\{\s*QuotaWindow\s*\}\s+from\s+"@\/core\/traffic\/index\.js"/,
    );
    expect(users).not.toMatch(/import\s+\{\s*QuotaWindow\s*\}/);
    const types = codeOf("config", "types.ts");
    expect(types).toMatch(/import\s+type\s+\{\s*ProxyProtocol\s*\}/);
    expect(types).not.toMatch(/import\s+\{\s*ProxyProtocol\s*\}/);
  });

  it("cluster 的 fork 注入 PROXY_WORKER_SLOT，且三条 fork 点都走同一个 forkWorker", () => {
    const code = codeOf("server", "cluster.ts");
    expect(code).toMatch(/cluster\.fork\(\{ \.\.\.process\.env, \[TRAFFIC_SLOT_ENV\]: slot \}\)/);
    // 槽位必须是稳定序号：进程退出时释放（重启复用同一个号，账本接得上）
    expect(code).toMatch(/slotByPid\.delete\(pid\)/);
    // 不能有裸的 cluster.fork()：那会绕过槽位派发
    expect(code).not.toMatch(/cluster\.fork\(\)/);
    expect((code.match(/forkWorker\(\)/g) ?? []).length).toBe(3);
  });

  it("压缩阈值是 8MiB 缺省，且压缩在 rename 之前必定已关句柄", () => {
    expect(DEFAULT_LEDGER_COMPACT_BYTES).toBe(8 * 1024 * 1024);
    const code = codeOf("core", "traffic", "ledger.ts");
    const body = code.slice(code.indexOf("private async compact("));
    const closeAt = body.indexOf("await this.closeHandle()");
    const renameAt = body.indexOf("await fsp.rename(");
    expect(closeAt).toBeGreaterThan(-1);
    expect(renameAt).toBeGreaterThan(closeAt);
    // .tmp + rename 是唯一的写回路径；残留 .tmp 只删不读
    expect(body).toMatch(/const tmp = tmpPathOf\(this\.file\)/);
    expect(code).toMatch(/async discardStaleTmp\(\)/);
  });
});

describe("core/traffic summarizeCurrent：只认当前窗口（判定侧唯一的读账本口径）", () => {
  it("逐用户求和，每个用户至多一条；旧窗口条目被忽略", () => {
    const windowFor = (u: string): QuotaWindow => (u === "bob" ? "month" : "day");
    const restored = summarizeCurrent(
      parseLedger(
        [
          `{"ts":${dayAt(15)},"u":"alice","d":"up","b":1}`,
          `{"ts":${dayAt(15)},"u":"alice","d":"up","b":2}`,
          `{"ts":${dayAt(15)},"u":"alice","d":"down","b":4}`,
          `{"ts":${dayAt(14)},"u":"alice","d":"up","b":1000}`,
          `{"ts":${at(2026, 3, 2)},"u":"bob","d":"down","b":9}`,
          `{"ts":${at(2026, 2, 27)},"u":"bob","d":"down","b":900}`,
        ].join("\n"),
      ),
      windowFor,
      0,
      dayAt(15),
    );
    expect(restored.get("alice")).toEqual({
      windowKey: windowKeyOf(dayAt(15), "day", 0),
      up: 3,
      down: 4,
    });
    expect(restored.get("bob")).toEqual({
      windowKey: windowKeyOf(dayAt(15), "month", 0),
      up: 0,
      down: 9,
    });
    expect(restored.size).toBe(2);
  });

  it("窗口键走夹取后的口径：非法 shiftHours 不会产出 NaN-NaN-NaN 畸形键", () => {
    // 同一个账本、同一批条目，shiftHours 非法时按夹取后的口径判定，
    // 而不是产出一个畸形键让恢复彻底失灵（键会被写进恢复结果并参与判定）。
    const entries = parseLedger(
      [`{"ts":${at(2026, 3, 15, 12)},"u":"a","d":"up","b":7}`].join("\n"),
    );
    const good = summarizeCurrent(entries, (): QuotaWindow => "day", 0, at(2026, 3, 15, 12));
    for (const hostile of [Number.NaN, Number.POSITIVE_INFINITY, 99, -5, 3.7]) {
      const clamped = summarizeCurrent(entries, (): QuotaWindow => "day", hostile, at(2026, 3, 15, 12));
      const key = [...clamped.values()][0].windowKey;
      expect(key).not.toContain("NaN");
      // 99 / 3.7 夹到 23 之外的定义域 → 键仍然是合法形状，且对 NaN/±Infinity 与 0 等价
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const nan = summarizeCurrent(entries, (): QuotaWindow => "day", Number.NaN, at(2026, 3, 15, 12));
    expect([...nan.values()][0].windowKey).toBe([...good.values()][0].windowKey);
  });
});
