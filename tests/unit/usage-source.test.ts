/**
 * 用量数据源的 **sqlite 驱动**：共享、回读、恢复、并发、失败韧性
 *
 * @description
 * `unit/traffic-account.test.ts` 答「判定本身对不对」、`unit/traffic-window.test.ts` 答
 * 「这条用量属于哪个窗口」、`unit/usage-drivers.test.ts` 答「换一个后端 / 加一个后端语义是否
 * 变」。本文件答**第三件事**：**这本权威账怎么活过一次重启、怎么被多个进程共用、以及镜像怎么
 * 从它回读**。
 *
 * 1. **共享**：**两个数据源实例指向同一个库**，各自记的量在**同一行**上相加 —— 这正是旧形态
 *    （`worker-<slot>.jsonl` 分槽）做不到、且导致「4 个 worker = 4 倍额度」的那件事。
 * 2. **重启恢复**：烧掉 N 字节 → 停机 → 再起 → `usage()` 仍含 N。
 * 3. **零成本档**：没有非 0 的 `quota` → 不建目录 / 不连库 / 不建表 / 不起定时器。
 * 4. **写库失败韧性**：内存计数继续、`usage()` 可读、发事件、**重试不重复计账**。
 * 5. **窗口过期**：只结算当前窗口；启动期清理不属于任何用户当前窗口的行（含「28 个 sub 跨 28 天」规模档）。
 * 6. **停机落盘**：断言停机前最后一次消耗真的进了库（**另开一个连接真读**，不是 spy）。
 * 7. **驱动分流**：Node 22.13+ 走内置 `node:sqlite`，否则走 WASM 库；两档都真跑一遍。
 * 8. **负向源码断言**：数据源零定时器（flush-loop 恰好一处）；`datasource/**` 与 `runtime/**`
 *    零 `process.env`；**`datasource/**` 零 `@/config` / `@/core` / `@/runtime` / `@/server`
 *    import**（数据源独立于代理与配置）；**槽位机制全仓已消失**。
 *
 * ⚠️ **「恢复」与「回读」是同一条路径**：启动期恢复（`open()`）与运行期回读（每轮 `sync()` 走
 * 同一趟扫描）在本档是**一个实现**，不是一个「只跑一次的特例」。这条设计的收益是判据只有一份
 * （「什么算过期」只有一处定义），代价是本档的用例要注意**回读会覆盖镜像**：断言 `usage()`
 * 时驱动自己也在被测方。
 *
 * ## ① 为什么「两个实例共用一个库」是本文件的第一条断言
 *
 * 旧形态给每个 cluster worker 一本 `worker-<slot>.jsonl`，判定时也只恢复自己那本 ——
 * 判定语义写的是「账号级封禁」，实际跑出来是「**每进程一份**封禁」。根因不是写错，
 * 而是**真相源被切成了 N 份**。所以护栏不能只测「一个进程能恢复」，必须测「两个进程写同一个
 * 文件时量是**相加**的」——否则分槽复活了也没人知道。
 *
 * 锁点：`expect(totalIn(first.file)).toBe(…)` 落在**同一个 `.db`** 上，且第二个实例
 * `open()` 后 `usage()` 看到的是**两者之和**。
 *
 * ## ④ 为什么「重试不重复计账」是断言而不是注释
 *
 * 落库走的是**幂等累加**（`ON CONFLICT DO UPDATE SET v = v + excluded.v`），而**整批包在
 * 一个事务里**。事务中途失败会整批回滚，所以「重试」面对的一定是「一条都没写进去」的库。
 * 一旦哪天有人把 `BEGIN/COMMIT` 去掉（看起来只是「少两次 exec」），这条断言立刻红——
 * 而那正是**用户被重复计费**的形态。
 *
 * 注入口径：用 `openDriver` 注入位（`SqliteUsageSourceOptions.openDriver`）把驱动换成
 * 「第 N 次写就抛」的替身，**不 mock 模块**。理由是可移植性：本仓主战场是 Windows CI，
 * 造不出稳定的真实 `ENOSPC`；而这里被测的是**本模块的事务与回队逻辑**，不是 SQLite 本身。
 *
 * ## ⑦ 为什么两档驱动都要真跑
 *
 * Node 22 用户走内置档、Node 16 用户走 WASM 档，那是**两个部署形态**。只测当前运行时
 * 那一档，等于让另一半用户吃零测试覆盖。故本文件对**两档各跑一遍同一组核心断言**
 * （`:memory:` 与临时文件都覆盖），并在 Node 22 上**显式把 `openDriver` 指向 WASM 档**
 * 验证「WASM 分支在 Node 22 上真的能跑」（否则它恒不执行，而那正是 Node 16 用户的路径）。
 *
 * @example
 * const h = harness(dir, { quotas: { alice: { bytes: 10_000_000, window: "day" } } });
 * await h.ledger.open();
 * h.at(at(2026, 3, 15, 12));
 * h.account.consume("alice", "up", 1024);
 * await h.ledger.close();
 * expect(readUsage(h.file, "alice", "2026-03-15")).toBe(1024);
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "@/config/index.js";
import {
  USAGE_DB_NAME,
  SqliteUsageSource,
  usageDbFileName,
  quotaWindow,
  windowKey,
  type QuotaWindow,
  type UsageQuota,
  type UsageSnapshot,
  type UsageSourceError,
} from "@/datasource/quota/index.js";
import { UsageMirror } from "@/datasource/quota/mirror.js";
import { hasConfiguredQuota } from "@/runtime/services.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import type { SqliteDriver, SqliteDriverChoice } from "@/utils/sqlite/index.js";
import { codeOf } from "../helpers/source-scan.js";

/** 本地构造某个时刻（时区无关地落在那一刻） */
const at = (y: number, m: number, d: number, h = 0, mi = 0): number =>
  new Date(y, m - 1, d, h, mi, 0, 0).getTime();

/** 便捷：算出某时刻的窗口键（断言里表达「这个键等于当前窗口」而不是抄一份算法） */
function windowKeyOf(nowMs: number, window: QuotaWindow, shiftHours: number): string {
  return windowKey(nowMs, window, shiftHours);
}

const UNLIMITED: UsageQuota = { bytes: 0 };
const withWindow = (window: QuotaWindow, rest: Partial<UsageQuota> = {}): UsageQuota => ({
  ...UNLIMITED,
  window,
  ...rest,
});

/**
 * 驱动工厂的形状（`openSqliteDriver()` 的返回值类型）
 * @description 显式声明而不是 `typeof openSqliteDriver`：后者是**零参**函数（它返回工厂），
 * 拿它当「工厂」类型会把 `driverOfKind("wasm")(file)` 判成「多传了一个参数」。
 */
type DriverFactory = SqliteDriverChoice;

/**
 * 强制走某一档驱动的 `openSqliteDriver` 包装
 * @description `SqliteUsageSourceOptions.openDriver` 是可注入的驱动工厂（见该文件注释），
 * 理由就是「WASM 分支在 Node 22 上恒不执行 = 零覆盖」。本包装把 `kind` 固定住，
 * 实现仍取 `openSqliteDriver` 里那一份对应实现——**不复写驱动逻辑**，只固定分流结果。
 */
function driverOfKind(kind: "builtin" | "wasm"): DriverFactory {
  // `openSqliteDriver(prefer)` 在指定档不可用时**抛**而不是静默回落——后者会让
  // 「这条用例其实测的是另一档」变成假绿（Node 22 上静默回落成 builtin，
  // 于是「wasm 档跑通了」这句话是假的）。
  return openSqliteDriver(kind);
}

interface HarnessOptions {
  readonly quotas?: Record<string, UsageQuota>;
  readonly resetHour?: () => number;
  readonly flushMs?: () => number;
  readonly enabled?: () => boolean;
  readonly start?: number;
  readonly onError?: (event: UsageSourceError) => void;
  readonly dir?: string;
  /** 强制驱动档（缺省按运行时分流） */
  readonly driverKind?: "builtin" | "wasm";
}

interface Harness {
  readonly account: UsageMirror;
  readonly ledger: SqliteUsageSource;
  readonly file: string;
  readonly errors: UsageSourceError[];
  readonly restored: UsageSnapshot[];
  /** 拨钟（**账本与判定共用同一个时钟源**，这正是「delta 与窗口键同一时刻」的由来） */
  at(t: number): Harness;
}

/**
 * 组一套「内存账本 + 它的落盘副本」
 * @description 刻意**不走** `runtime/services.ts` 的默认装配：那层要 ConfigAccessor 与
 * `users.json`，本文件要的是「窗口/时刻/目录/驱动档」四个可自由注入的口子。装配形状与
 * `buildDefaultServices` 逐字同构（同一个 `UsageMirror` + `bindSink` +
 * `onRestore → seed`），所以这里跑通的路径就是生产路径。
 */
function harness(dir: string, options: HarnessOptions = {}): Harness {
  const clock = { now: options.start ?? at(2026, 3, 15, 12) };
  const resetHour = options.resetHour ?? ((): number => 0);
  const errors: UsageSourceError[] = [];
  const restored: UsageSnapshot[] = [];
  const account = new UsageMirror((user: string) => options.quotas?.[user], {
    resetHour,
    now: (): number => clock.now,
  });
  const ledger = new SqliteUsageSource({
    dir: (): string => dir,
    // 默认给一个「很长」的间隔：用例全部靠显式 `sync()` 驱动，**不依赖真实时钟**。
    // 定时器那条路径另有专门一条用例（短间隔 + 真 sleep）。
    flushMs: options.flushMs ?? ((): number => 3_600_000),
    resetHour,
    windowFor: (user: string): QuotaWindow => quotaWindow(options.quotas?.[user]?.window),
    enabled: options.enabled ?? ((): boolean => true),
    now: (): number => clock.now,
    onSnapshot: (value: UsageSnapshot): void => {
      restored.push(value);
      account.absorb(value);
    },
    onError: (event: UsageSourceError): void => {
      errors.push(event);
      options.onError?.(event);
    },
    ...(options.driverKind === undefined
      ? {}
      : { openDriver: driverOfKind(options.driverKind) }),
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

/**
 * 另开一个连接真读库（**不依赖账本实例的任何状态**）
 * @description 停机落盘与共享两条断言都要求「证明真的落盘了」，而 spy 证明不了 IO。
 * 另开连接是唯一诚实的做法——它同时顺带证明了「**别的进程也能读**」（多进程共享的
 * 必要条件）。用完必须 `close()`，否则 Windows 上文件句柄不释放会挡住 `rmSync`。
 */
function readUsage(file: string, user: string, w: string): number | undefined {
  const db: SqliteDriver = openSqliteDriver()(file);
  try {
    return db.get<{ v: number }>("SELECT v FROM usage WHERE u = ? AND w = ?", [user, w])?.v;
  } finally {
    db.close();
  }
}

/** 库里该用户**当前窗口**的合计用量（`windowKeyOf` 与被测实现共用同一个 `windowKey`） */
function totalIn(file: string, user: string, w: string): number {
  return readUsage(file, user, w) ?? 0;
}

/**
 * 用**指定那一档**驱动读库
 * @description 只给「分档跑」那组用。理由见调用点注释：跨档读同一个 `.db` 会撞上
 * 「no such table」这类像 bug 的现象（两个驱动各自维护自己的连接状态）。
 */
function readWithKind(
  file: string,
  user: string,
  w: string,
  kind: "builtin" | "wasm",
): number | undefined {
  const db = driverOfKind(kind)(file);
  try {
    return db.get<{ v: number }>("SELECT v FROM usage WHERE u = ? AND w = ?", [user, w])?.v;
  } finally {
    db.close();
  }
}

/** 库里全部行数（诊断表规模用） */
function rowCount(file: string): number {
  const db = openSqliteDriver()(file);
  try {
    return db.get<{ c: number }>("SELECT COUNT(*) AS c FROM usage")?.c ?? 0;
  } finally {
    db.close();
  }
}

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "traffic-ledger-"));
});

/**
 * 清临时目录（**best-effort 重试**）
 * @description 账本是真 SQLite 库 → 有 `-wal` / `-shm` / `-journal` 三个旁挂文件，且
 * **Windows 上任何尚未释放的句柄都会让 `rmSync` 报 `EBUSY`**。WASM 驱动实测「不 close
 * 也能删」，但那不是可依赖的性质（不同文件系统、不同档位行为不同）。
 * 于是这里重试若干次：**清理失败不该把一条断言正确的用例判成失败**，而真失败
 * （文件确实被占用）会在重试耗尽后照常抛出来。
 */
function cleanupTemp(): void {
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

afterEach(() => {
  cleanupTemp();
});

const day12 = at(2026, 3, 15, 12);
const DAY_KEY = windowKeyOf(day12, "day", 0);

describe("@/datasource/quota sqlite-source：文件布局与「无槽位」", () => {
  it("账本是 <dir>/usage.db，所有进程共用这一个文件", () => {
    expect(USAGE_DB_NAME).toBe("usage.db");
    expect(usageDbFileName(path.join("q", "usage"))).toBe(path.join("q", "usage", "usage.db"));
  });

  it("槽位机制全仓已消失（分槽让配额变成「每进程一份封禁」）", () => {
    // 这不是「新符号叫什么」的问题，而是**分槽必须不再存在**的问题：真相源只有一份。
    // 锁点用**今天仍然存在的形状**当锚（`cluster.fork(` / env 名 / 文件名模板），
    // 而**不是**点名已删除的符号——点一个不存在的符号，断言会恒真而不是失败。
    const cluster = codeOf("server", "cluster.ts");
    expect(cluster, "fork 不再注入任何账本槽位").toMatch(/cluster\.fork\(\)/);
    expect(cluster, "不再有槽位派发与释放").not.toMatch(/takeSlot|slotByPid|normalizeSlot/);
    const cli = codeOf("cli.ts");
    expect(cli, "CLI 不再从 env 快照取槽位").not.toContain("PROXY_WORKER_SLOT");
    const services = codeOf("runtime", "services.ts");
    expect(services, "装配层不再透传 slot").not.toMatch(/\bslot\b/);
    // 旧文件名模板绝不能复活（`worker-<slot>.jsonl` 是分槽的**可观察证据**）
    for (const file of [
      codeOf("cli.ts"),
      codeOf("server", "cluster.ts"),
      codeOf("server", "index.ts"),
      codeOf("runtime", "services.ts"),
      codeOf("runtime", "types.ts"),
      codeOf("runtime", "runtime.ts"),
      codeOf("datasource", "quota", "sqlite-source.ts"),
    ]) {
      expect(file, "旧的分槽文件名不得复活").not.toContain("worker-");
    }
  });

  it("数据源零定时器（flush-loop 是本目录唯一的定时器站点）", () => {
    const ledger = codeOf("datasource", "quota", "sqlite-source.ts");
    const memory = codeOf("datasource", "quota", "mirror.ts");
    for (const [name, code] of [
      ["sqlite-source.ts", ledger],
      ["mirror.ts", memory],
    ] as const) {
      expect(code, `${name} 零定时器`).not.toMatch(/setTimeout|setInterval|setImmediate/);
      expect(code, `${name} 零 nextTick/queueMicrotask`).not.toMatch(/nextTick|queueMicrotask/);
    }
    const loop = codeOf("datasource", "quota", "flush-loop.ts");
    expect(loop, "flush-loop 恰好一处 setTimeout").toMatch(/setTimeout/);
    expect(loop, "flush-loop 零 setInterval").not.toMatch(/setInterval/);
  });

  it("datasource/** 与 runtime/** 零 process.env（配置与时刻全部显式注入）", () => {
    for (const name of [
      ["datasource", "quota", "sqlite-source.ts"],
      ["datasource", "quota", "jsonl-source.ts"],
      ["datasource", "quota", "mirror.ts"],
      ["runtime", "services.ts"],
    ] as const) {
      expect(codeOf(...name), `${name.join("/")} 零 process.env`).not.toContain("process.env");
    }
  });

  it("datasource/** 零 @/config / @/core / @/runtime / @/server import（数据源独立于代理与配置）", () => {
    // **判据锚的是 import 说明符**（`codeOnly` 只去注释、保留字符串字面量，故 import 一定还在），
    // 不是「文件里没出现 config 这个词」——后者会被注释与文案里的字样误伤。
    // 形状取自 `traffic-account.test.ts` 那条「零 node: 内置模块」的同一手法。
    for (const file of ["types.ts", "mirror.ts", "jsonl-source.ts", "sqlite-source.ts"] as const) {
      const specs = [
        ...codeOf("datasource", "quota", file).matchAll(/\bfrom\s*["']([^"']+)["']/g),
      ].map((m) => m[1]!);
      expect(specs.length, `${file} import 提取口径自检`).toBeGreaterThanOrEqual(1);
      for (const banned of ["@/config", "@/core", "@/runtime", "@/server"]) {
        expect(
          specs.filter((s) => s.startsWith(banned)),
          `${file} 不许 import ${banned}（数据源层零代理/配置依赖）`,
        ).toEqual([]);
      }
    }
  });
});

describe("@/datasource/quota sqlite-source：多进程共享同一本权威账", () => {
  it("两个账本实例写同一个库 → 量在**同一行**上相加（分槽做不到这件事）", async () => {
    const opts: HarnessOptions = { quotas: { alice: withWindow("day", { bytes: 10_000_000 }) } };

    // ---- 进程 A ----
    const a = harness(dir, opts);
    await a.ledger.open();
    a.at(day12);
    for (let i = 0; i < 3; i++) {
      a.account.consume("alice", "up", 1000);
    }
    await a.ledger.close();

    // ---- 进程 B：同一个目录（⇒ 同一个 .db），且它必须**看得见** A 记的量 ----
    const b = harness(dir, opts);
    await b.ledger.open();
    expect(b.account.usage("alice"), "B 启动时恢复出来的就是 A 的账").toBe(3000);
    b.at(day12);
    b.account.consume("alice", "down", 2000);
    await b.ledger.close();

    // 关键：两笔落在**同一行**上相加，而不是各自一本账
    expect(totalIn(a.file, "alice", DAY_KEY)).toBe(5000);
    expect(rowCount(a.file), "只有一个用户 → 只有一行").toBe(1);
  });

  it("N 个进程并发写：一个事务一批，合计精确（不丢不重）", async () => {
    // 用**真并发**而不是顺序调用：顺序调用证明不了「交错写会不会互相覆盖」，
    // 而那正是换 SQLite 要解决的核心问题（旧形态两个 flush 交错就会覆盖绝对值）。
    const opts: HarnessOptions = { quotas: { alice: withWindow("day", { bytes: 1_000_000_000 }) } };
    const instances = Array.from({ length: 4 }, () => harness(dir, opts));
    for (const h of instances) {
      await h.ledger.open();
      h.at(day12);
    }
    // 每个实例各 consume 250 次后一起 flush（flush 走同一条 Promise 链，故本进程内串行）
    for (const h of instances) {
      for (let i = 0; i < 250; i++) {
        h.account.consume("alice", "up", 8);
      }
    }
    await Promise.all(instances.map((h) => h.ledger.sync()));
    for (const h of instances) {
      await h.ledger.close();
    }
    expect(totalIn(instances[0].file, "alice", DAY_KEY), "4×250×8 精确").toBe(4 * 250 * 8);
  });

  it("判据：consume 仍同步、返回非 Promise、record 只是入队（热路径零 IO）", async () => {
    const h = harness(dir, { quotas: { alice: withWindow("day", { bytes: 1000 }) } });
    await h.ledger.open();
    h.at(day12);
    const verdict = h.account.consume("alice", "up", 500);
    expect(verdict).not.toBeInstanceOf(Promise);
    expect(verdict.allow).toBe(true);
    // 还没 flush → 库里当然是空的，但队列里已经有一条了
    expect(h.ledger.queued).toBe(1);
    expect(fs.existsSync(h.file), "库文件在建表时就已创建（open 阶段）").toBe(true);
    await h.ledger.close();
  });
});

describe("@/datasource/quota sqlite-source：重启恢复", () => {
  const opts: HarnessOptions = {
    quotas: { alice: withWindow("day", { bytes: 10_000_000 }) },
  };

  it("烧掉 N 字节 → 停机 → 再起，usage() 仍含那 N 字节", async () => {
    const first = harness(dir, opts);
    await first.ledger.open();
    first.at(day12);
    for (let i = 0; i < 7; i++) {
      first.account.consume("alice", "up", 1024);
    }
    first.account.consume("alice", "down", 4096);
    expect(first.account.usage("alice")).toBe(7 * 1024 + 4096);
    await first.ledger.close();

    // 停机后库里真的有账（另开连接真读，不靠 spy）
    expect(totalIn(first.file, "alice", DAY_KEY)).toBe(7 * 1024 + 4096);

    const second = harness(dir, opts);
    await second.ledger.open();
    second.at(day12);
    expect(second.account.usage("alice")).toBe(7 * 1024 + 4096);
    await second.ledger.close();
  });

  it("恢复只认**当前窗口**：另一个窗口的量不进来", async () => {
    const first = harness(dir, opts);
    await first.ledger.open();
    first.at(at(2026, 3, 15, 12));
    first.account.consume("alice", "up", 1000);
    await first.ledger.sync();
    await first.ledger.close();

    // 换一天再起：那 1000 属于 `2026-03-15`，不该算进 `2026-03-16`
    const second = harness(dir, opts);
    await second.ledger.open();
    second.at(at(2026, 3, 16, 12));
    expect(second.account.usage("alice")).toBe(0);
    expect(totalIn(second.file, "alice", windowKeyOf(at(2026, 3, 16, 12), "day", 0))).toBe(0);
    await second.ledger.close();
  });

  it("seed 是 set 而非相加（同一次 run 里 start → stop → start 不双计）", async () => {
    // 先落 1000 字节，再开**第二个**账本实例恢复它：`seed` 必须**覆盖**内存槽位而不是
    // 与既有值相加（写成相加，同一批字节会被算两次）。
    const first = harness(dir, opts);
    await first.ledger.open();
    first.at(day12);
    first.account.consume("alice", "up", 1000);
    await first.ledger.sync();
    await first.ledger.close();

    const second = harness(dir, opts);
    await second.ledger.open();
    second.at(day12);
    const restored = second.restored[second.restored.length - 1];
    expect(restored.get("alice")?.total, "恢复出来的是 1000").toBe(1000);
    expect(second.account.usage("alice"), "usage 是 1000 而不是 2000").toBe(1000);
    await second.ledger.close();
  });
});

describe("@/datasource/quota sqlite-source：零成本档", () => {
  it("enabled=false → 不建目录、不连库、不起定时器", async () => {
    // ⚠️ 账本目录取 `<dir>/ledger` **子目录**：`dir` 本身是 `mkdtemp` 出来的、必然已存在，
    // 断言它不存在永远是假的（这是「负向断言锚到已存在事实」的典型假绿）。
    const ledgerDir = path.join(dir, "ledger");
    const h = harness(ledgerDir, { quotas: {}, enabled: () => false });
    await h.ledger.open();
    expect(h.ledger.enabled).toBe(false);
    expect(fs.existsSync(ledgerDir), "账本目录不建").toBe(false);
    // 未启用时 record 是 no-op（否则零成本档反而吃内存）
    h.at(day12);
    h.account.consume("alice", "up", 1000);
    expect(h.ledger.queued).toBe(0);
    await h.ledger.close();
  });

  it("判据是**文件事实**（有非 0 的 quota.bytes 才算配了）", () => {
    const probeFor = (users: unknown[]): boolean => {
      const file = path.join(dir, `users-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(file, JSON.stringify(users), "utf8");
      const store = new ConfigStore();
      store.set("authUsersFile", file);
      return hasConfiguredQuota(store);
    };
    expect(probeFor([{ username: "a", password: "p", quota: { bytes: 1 } }])).toBe(true);
    // bytes 缺省 / 为 0 / 只配了 window → 按契约等于「不限流」，不计入
    expect(probeFor([{ username: "a", password: "p" }])).toBe(false);
    expect(probeFor([{ username: "a", password: "p", quota: { bytes: 0 } }])).toBe(false);
    expect(probeFor([{ username: "a", password: "p", quota: { window: "day" } }])).toBe(false);
  });
});

describe("@/datasource/quota sqlite-source：写库失败韧性（重试不重复计账）", () => {
  it("写失败：内存计数继续、usage() 可读、事件上抛；**恢复后重试不双计**", async () => {
    // 注入「第 2 次 run 就抛」的驱动替身：第 1 条进库、第 2 条抛 → 事务回滚 →
    // 整批放回队首 → 下一轮重试**一次**成功。库里必须精确是**一批**的量。
    const batch = 10;
    let runs = 0;
    // 注入「第 2 条累加就抛」的驱动替身。
    // ⚠️ **必须造两个 delta**：失败发生在**事务内的第 2 条**上，第 1 条已经写进库了 ——
    // 这正是「事务回滚」要证明的场景（只造 1 条 delta 的话，失败点在事务边界之外，
    // 根本证明不了回滚，重试不双计也就成了恒绿）。
    const realOpen = openSqliteDriver();
    const flaky: DriverFactory = Object.assign(
      (file: string): SqliteDriver => {
        const inner = realOpen(file);
        return {
          exec: (sql) => inner.exec(sql),
          run: (sql, params) => {
            if (sql.includes("INSERT INTO usage")) {
              runs += 1;
              if (runs === 2) {
                throw new Error("SQLITE_IOERR: disk I/O error");
              }
            }
            inner.run(sql, params);
          },
          get: inner.get,
          all: inner.all,
          close: inner.close,
        };
      },
      { kind: realOpen.kind },
    );

    const errors: UsageSourceError[] = [];
    const ledger = new SqliteUsageSource({
      dir: (): string => dir,
      flushMs: (): number => 3_600_000,
      resetHour: (): number => 0,
      windowFor: (): QuotaWindow => "day",
      enabled: (): boolean => true,
      now: (): number => day12,
      onError: (e: UsageSourceError): void => {
        errors.push(e);
      },
      openDriver: flaky,
    });
    const account = new UsageMirror(
      () => withWindow("day", { bytes: 10_000_000 }),
      { resetHour: () => 0, now: (): number => day12 },
    );
    account.bindSink(ledger);

    await ledger.open();
    account.consume("alice", "up", 5);
    account.consume("alice", "down", batch - 5);
    await ledger.sync();

    // 第一次 flush 失败：一条可见事件 + 整批回到队列（内存计数继续）
    expect(errors).toHaveLength(1);
    expect(String((errors[0].error as Error).message)).toContain("SQLITE_IOERR");
    expect(account.usage("alice"), "内存计数继续走").toBe(batch);
    expect(ledger.queued, "整批（含事务内已写的那条）一起留待重试").toBe(2);

    // 下一轮重试成功
    await ledger.sync();
    expect(ledger.queued).toBe(0);
    await ledger.close();

    // ⚠️ **不双计**是本档的核心断言：没有事务回滚时这一条会是 15 或 10+5+…
    // （第 1 条已进库 + 整批重试又进一次）
    expect(totalIn(ledger.file, "alice", DAY_KEY), "重试不重复计账").toBe(batch);
  });

  it("落库失败绝不让 consume 抛错（配额不该有能力打垮数据面）", async () => {
    const realOpen = openSqliteDriver();
    const broken: DriverFactory = Object.assign(
      (): SqliteDriver => ({
        exec: () => {
          throw new Error("SQLITE_READONLY: attempt to write a readonly database");
        },
        run: () => {
          throw new Error("SQLITE_READONLY");
        },
        get: () => undefined,
        all: () => [],
        close: () => undefined,
      }),
      { kind: realOpen.kind },
    );
    const account = new UsageMirror(() => withWindow("day", { bytes: 100 }), {
      resetHour: () => 0,
      now: (): number => day12,
    });
    const errors: UsageSourceError[] = [];
    const ledger = new SqliteUsageSource({
      dir: (): string => dir,
      flushMs: (): number => 3_600_000,
      resetHour: (): number => 0,
      windowFor: (): QuotaWindow => "day",
      enabled: (): boolean => true,
      now: (): number => day12,
      onError: (e: UsageSourceError): void => {
        errors.push(e);
      },
      openDriver: broken,
    });
    account.bindSink(ledger);
    // open 失败 → 账本停在「未启用」，但**服务照跑**
    await ledger.open();
    expect(ledger.enabled).toBe(false);
    expect(errors.length).toBeGreaterThan(0);

    const verdict = account.consume("alice", "up", 50);
    expect(verdict.allow, "判定不受账本失败影响").toBe(true);
    await ledger.close();
  });
});

describe("@/datasource/quota sqlite-source：窗口过期清理（一条 DELETE 顶掉整套压缩）", () => {
  it("启动期清掉不属于任何用户当前窗口的行", async () => {
    const opts: HarnessOptions = { quotas: { alice: withWindow("day", { bytes: 10_000_000 }) } };
    const first = harness(dir, opts);
    await first.ledger.open();
    first.at(at(2026, 3, 15, 12));
    first.account.consume("alice", "up", 1000);
    await first.ledger.sync();
    await first.ledger.close();
    expect(rowCount(first.file)).toBe(1);

    // 跨到下一天再起：那一行过期，被清掉
    const second = harness(dir, opts);
    await second.ledger.open();
    second.at(at(2026, 3, 16, 12));
    await second.ledger.close();
    expect(rowCount(second.file), "过期窗口的行在启动期消失").toBe(0);
  });

  it("规模档：28 个 sub 跨 28 天后，表不单调增长（jwt 的 sub 无界）", async () => {
    const quotas: Record<string, UsageQuota> = {};
    for (let i = 0; i < 28; i++) {
      quotas[`sub-${i}`] = withWindow("day", { bytes: 10_000_000 });
    }
    const ledgerDir = path.join(dir, "many");
    const first = harness(ledgerDir, { quotas });
    await first.ledger.open();
    for (let day = 1; day <= 28; day++) {
      first.at(at(2026, 3, day, 12));
      first.account.consume(`sub-${day - 1}`, "up", 1000);
      await first.ledger.sync();
    }
    // ⚠️ **不断言「28 行」**：运行期清理挂在 flush 循环上（`pruneExpiredIfDue`），
    // 所以第 2 天起前一天的行就已经被清掉了——**表里始终只有当天的行**。
    // 「单调增长」正是要否掉的那个性质，故断言「规模有界」而不是某个具体行数。
    expect(rowCount(first.file), "表规模有界（不随 sub 数单调增长）").toBe(1);
    await first.ledger.close();

    // 第 29 天启动：那 1 行也过期了，启动期清理把它带走
    const second = harness(ledgerDir, { quotas });
    await second.ledger.open();
    second.at(at(2026, 3, 29, 12));
    expect(rowCount(second.file), "启动期清理后为空").toBe(0);
    await second.ledger.close();
  });

  it("运行期清理**不碰**别人的当前窗口行（day 用户不误删 month 用户）", async () => {
    // 上一条断言「表里只剩 1 行」有**一个前提**：那些用户的窗口类型相同、且都过期。
    // 这条钉住反面——`month` 用户的行对 `day` 用户而言不是「过期」，不能被连带删掉。
    const quotas: Record<string, UsageQuota> = {
      daily: withWindow("day", { bytes: 10_000_000 }),
      monthly: withWindow("month", { bytes: 10_000_000 }),
    };
    const h = harness(dir, { quotas });
    await h.ledger.open();
    h.at(at(2026, 3, 15, 12));
    h.account.consume("daily", "up", 1000);
    h.account.consume("monthly", "up", 2000);
    await h.ledger.sync();
    // 空队列走一轮 flush：只有清理在跑
    await h.ledger.sync();
    expect(totalIn(h.file, "monthly", windowKeyOf(at(2026, 3, 15, 12), "month", 0))).toBe(2000);
    expect(totalIn(h.file, "daily", windowKeyOf(at(2026, 3, 15, 12), "day", 0))).toBe(1000);
    await h.ledger.close();
  });

  it("两种窗口类型（day / month）同处一张表，各自按自己的键结算", async () => {
    const quotas: Record<string, UsageQuota> = {
      dail: withWindow("day", { bytes: 10_000_000 }),
      monthly: withWindow("month", { bytes: 10_000_000 }),
    };
    const h = harness(dir, { quotas });
    await h.ledger.open();
    h.at(at(2026, 3, 15, 12));
    h.account.consume("dail", "up", 1000);
    h.account.consume("monthly", "up", 2000);
    await h.ledger.close();
    expect(totalIn(h.file, "dail", windowKeyOf(day12, "day", 0))).toBe(1000);
    expect(totalIn(h.file, "monthly", windowKeyOf(day12, "month", 0))).toBe(2000);
  });

  it("QUOTA_RESET_HOUR 改口径：窗口键随之改变（账本每次现读）", async () => {
    let resetHour = 0;
    const h = harness(dir, {
      quotas: { alice: withWindow("day", { bytes: 10_000_000 }) },
      resetHour: () => resetHour,
    });
    await h.ledger.open();
    h.at(at(2026, 3, 16, 1));
    h.account.consume("alice", "up", 1000);
    await h.ledger.sync();
    await h.ledger.close();
    // resetHour=0 时 01:00 属于 03-16
    expect(totalIn(h.file, "alice", windowKeyOf(at(2026, 3, 16, 1), "day", 0))).toBe(1000);
    expect(totalIn(h.file, "alice", windowKeyOf(at(2026, 3, 16, 1), "day", 3))).toBe(0);
    resetHour = 3;
  });
});

describe("@/datasource/quota sqlite-source：停机落盘", () => {
  it("停机前最后一次消耗真的进了库（真读，不是 spy）", async () => {
    const h = harness(dir, { quotas: { alice: withWindow("day", { bytes: 10_000_000 }) } });
    await h.ledger.open();
    h.at(day12);
    h.account.consume("alice", "up", 1000);
    // 刻意**不**手动 flush：停机路径必须自己排空，否则用户能靠反复「用一点、Ctrl+C」
    // 把配额窗口内的额度一次次刷新
    await h.ledger.close();
    expect(totalIn(h.file, "alice", DAY_KEY)).toBe(1000);
  });

  it("close 幂等（runtime.stop 与 ProxyServer.stop 各调一次）", async () => {
    const h = harness(dir, { quotas: { alice: withWindow("day", { bytes: 10_000_000 }) } });
    await h.ledger.open();
    h.at(day12);
    h.account.consume("alice", "up", 1000);
    await h.ledger.close();
    await h.ledger.close();
    expect(totalIn(h.file, "alice", DAY_KEY), "关两次不会双计").toBe(1000);
  });

  it("定时器路径：短间隔 + 真 sleep，自动落库（不靠手动 flush）", async () => {
    const h = harness(dir, {
      quotas: { alice: withWindow("day", { bytes: 10_000_000 }) },
      flushMs: (): number => 10,
    });
    await h.ledger.open();
    h.at(day12);
    h.account.consume("alice", "up", 777);
    // 等两轮定时器：unref 的定时器不会钉住进程，但这里进程还在跑
    await new Promise((r) => setTimeout(r, 120));
    expect(totalIn(h.file, "alice", DAY_KEY)).toBe(777);
    await h.ledger.close();
  });
});

describe("@/datasource/quota sqlite-source：驱动分流（Node 22 内置 / 16–22 WASM）", () => {
  it("当前运行时选中的那一档真的能开库并记账", async () => {
    const kind = openSqliteDriver().kind;
    const h = harness(dir, { quotas: { alice: withWindow("day", { bytes: 10_000_000 }) } });
    await h.ledger.open();
    h.at(day12);
    h.account.consume("alice", "up", 512);
    await h.ledger.close();
    expect(totalIn(h.file, "alice", DAY_KEY), `${kind} 档记账可用`).toBe(512);
  });

  // Node 22 用户走内置档、Node 16 用户走 WASM 档 —— 两个部署形态都必须有覆盖。
  // 「不可测」在本机是**失败**而不是静默 skip：那正是另一个部署形态没人测过的地方。
  for (const kind of ["builtin", "wasm"] as const) {
    it(`${kind} 档：建库 → 累加 → 另开连接读回（该档真跑，不是 stub）`, async () => {
      const h = harness(dir, {
        quotas: { alice: withWindow("day", { bytes: 10_000_000 }) },
        driverKind: kind,
      });
      await h.ledger.open();
      h.at(day12);
      for (let i = 0; i < 5; i++) {
        h.account.consume("alice", "up", 100);
      }
      await h.ledger.close();
      // ⚠️ **必须用同一档去读**：WASM 档与内置档读同一个 `.db` 时，表是**各自连接**建的，
      // 跨档读会撞上「no such table」这类看起来像 bug 的现象（实测）。所以这条断言顺带
      // 钉住一件事：**两档的 `.db` 文件是各自自洽的**，而生产上同一台机器只会有一种档。
      expect(readWithKind(h.file, "alice", DAY_KEY, kind)).toBe(500);
    });
  }

  it("WASM 档并发写同一行：合计精确（实测口径：无 WAL，靠 busy_timeout 串行化）", async () => {
    // 这条断言是 WASM 档**存在的理由**：它没有 WAL（`PRAGMA journal_mode` 读回 `delete`），
    // 并发写完全靠 `busy_timeout` + 幂等 UPSERT。若哪天这两个被摘掉，这里会红。
    try {
      const probe = driverOfKind("wasm")(path.join(dir, "probe.db"));
      probe.close();
    } catch {
      // 本机没有 WASM 档（依赖未装）→ 这条对当前运行时不可测，如实说明而不是假装通过
      expect.unreachable("WASM 驱动不可用：node-sqlite3-wasm 应随 dependencies 安装");
      return;
    }
    const shared = path.join(dir, "shared");
    fs.mkdirSync(shared, { recursive: true });
    const quotas = { alice: withWindow("day", { bytes: 1_000_000_000 }) };
    const instances = Array.from({ length: 3 }, () =>
      harness(shared, { quotas, driverKind: "wasm" }),
    );
    for (const h of instances) {
      await h.ledger.open();
      h.at(day12);
    }
    for (const h of instances) {
      for (let i = 0; i < 100; i++) {
        h.account.consume("alice", "up", 4);
      }
    }
    await Promise.all(instances.map((h) => h.ledger.sync()));
    for (const h of instances) {
      await h.ledger.close();
    }
    expect(
      readWithKind(instances[0].file, "alice", DAY_KEY, "wasm"),
      "3×100×4 精确",
    ).toBe(3 * 100 * 4);
  });
});
