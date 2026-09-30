/**
 * 配额账本的**驱动抽象**（`QUOTA_USAGE_DRIVER`）：注册表、两个内置后端、镜像的误差上界
 *
 * @description
 * `usage-source.test.ts` 专测 sqlite 档的内部机制；本文件专测**抽象本身**，也就是
 * 「换一个后端 / 加一个后端，判定语义不变、装配真的换掉」。锁五件事：
 *
 * 1. **等价性**：同一批用量经两个后端落盘后，**回读出来的总量相同**。锚点是「读回来的数字」，
 *    不是「文件存在」——后者在「写了个空文件」时也成立。
 * 2. **装配切换**：`buildDefaultServices` 真的按 `quotaUsageDriver` 挑实现器。判据是
 *    **账本文件名形态**（`usage.jsonl` vs `usage.db`），因为那是「哪个后端真的在写」的可观察
 *    证据；再加上「写入的字节真的进了那个文件」。
 * 3. **注册表是唯一的驱动判据，且未注册即抛错**（本文件的核心，见下面「牙齿验证」）。
 * 4. **自定义驱动真的被装配用上**（`registerUsageSource` + `quotaUsageDriver=<自定义名>`）。
 * 5. **镜像的误差上界是可测的量**：另一个实例写的字节，在 `2P` 内对本进程的判定可见。
 *
 * ## ③ ④ 为什么「注册一个自定义驱动」这条必须有牙齿
 *
 * 抽象最容易腐烂成「注册表接好了，配置那条线却还写死在两支三元里」——那是一个**静默失效**的
 * 注入位：`registerUsageSource` 编译通过、`listUsageSourceDrivers()` 返回自定义名、而
 * `buildDefaultServices` 压根不问注册表，于是 `quotaUsageDriver=mysql` 真跑起来接的还是内置的
 * 某个后端。**用户以为接上了自己的后端，实际没有**。
 *
 * 判据分三段，缺一段就有一类退化测不出来：
 * - **行为面**：`registerUsageSource("mem", …)` 之后 `buildDefaultServices` 装出来的那个对象的
 *   `file` 就是自定义工厂造出来的（**不是**内置两档的任何文件名，也不是内置类的实例）。
 * - **编译期面**：内置三元退回时用到的那个「已知驱动名」集合是**闭合**的（`BUILTIN_USAGE_DRIVERS`
 *   只有两项），所以「判断驱动名是不是内置的」这件事一旦写成运行时三元就必然与注册表分叉。
 * - **源码级面**：`runtime/services.ts` 的 `buildDefaultServices` 函数体里**必须出现
 *   `resolveUsageSource(`**，且**不许**出现「取驱动名后与内置名字比较」的三元/开关形状。
 *
 * **牙齿验证（实测，已跑过）**：把 `services.ts` 那一行从
 * `resolveUsageSource(ctx.config.get("quotaUsageDriver"))(spec)` 换成写死的
 * `new SqliteUsageSource(spec)`，本文件第 ④ 组**全红**（`file` 不是 `<mem>:` 哨兵、
 * `quota-exceeded` 那一路断言也跟着失效）；换回 `resolveUsageSource` 后全绿。
 * 结论写在这里是因为「护栏有没有牙齿」这句话本身必须由一次实测背书，否则它只是一句愿望。
 *
 * ## ⑤ 为什么误差上界值得单独一条
 *
 * 「多进程判定是每进程一份」是本仓最重要也最容易被**记成好消息**的事实（听起来像「没共享」）。
 * 它现在有了精确的形状：判定落后于权威值至多 `2 × quotaFlushInterval`
 * （`mirrorLagBoundMs`，推导见 `@/datasource/quota/mirror.ts` 文件头）。这条断言就是那个数字的
 * **可执行版**：两个实例指向同一个文件，实例 B 记账，实例 A 的 `usage()` 在一个上界内跟上。
 * 将来若有人把回读从周期循环里摘掉（看起来只是「省一次 IO」），这条会先于线上问题红。
 *
 * @example
 * const h = harness("json");
 * await h.source.open();
 * h.at(day12);
 * h.account.consume("alice", "up", 1024);
 * await h.source.close();
 * expect(h.readTotal()).toBe(1024); // 另一个连接真读，不是 spy
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore, createConfigContext } from "@/config/index.js";
import {
  JSONL_USAGE_FILE_NAME,
  SqliteUsageSource,
  listUsageSourceDrivers,
  parseUsageEntries,
  quotaWindow,
  registerUsageSource,
  resolveUsageSource,
  type QuotaWindow,
  type UsageQuota,
  type UsageSnapshot,
  type UsageSourceError,
} from "@/datasource/quota/index.js";
import { UsageMirror } from "@/datasource/quota/mirror.js";
import { JsonlUsageSource } from "@/datasource/quota/jsonl-source.js";
import { buildDefaultServices } from "@/runtime/services.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import { testContextFor } from "../helpers/config.js";
import { blockAfter, codeOf } from "../helpers/source-scan.js";

const at = (y: number, m: number, d: number, h = 0): number =>
  new Date(y, m - 1, d, h, 0, 0, 0).getTime();

const QUOTA: UsageQuota = { bytes: 10_000_000, window: "day" };
const day12 = at(2026, 3, 15, 12);

let dir = "";

/** 组一套「用量镜像 + 指定后端的数据源」，形状与 `buildDefaultServices` 逐字同构 */
function harness(driver: "json" | "sqlite", quota: UsageQuota = QUOTA) {
  const clock = { now: day12 };
  const errors: UsageSourceError[] = [];
  const account = new UsageMirror(() => quota, {
    resetHour: () => 0,
    now: () => clock.now,
  });
  const shared = {
    dir: (): string => dir,
    flushMs: (): number => 3_600_000,
    resetHour: (): number => 0,
    windowFor: (): QuotaWindow => quotaWindow(quota.window),
    enabled: (): boolean => true,
    now: (): number => clock.now,
    onSnapshot: (r: UsageSnapshot): void => {
      account.absorb(r);
    },
    onError: (e: UsageSourceError): void => {
      errors.push(e);
    },
  };
  const source = driver === "json" ? new JsonlUsageSource(shared) : new SqliteUsageSource(shared);
  account.bindSink(source);
  return { account, source, errors, at: (t: number) => (clock.now = t) };
}

/** 读某个后端落下来的总量（**另开一个连接 / 另一次读**，不是 spy） */
function readTotal(driver: "json" | "sqlite", user: string, window: string): number {
  if (driver === "json") {
    const file = path.join(dir, JSONL_USAGE_FILE_NAME);
    if (!fs.existsSync(file)) {
      return 0;
    }
    // 复用实现器自己的解析（`parseUsageEntries`），测试里不复制第二份格式真相源
    return parseUsageEntries(fs.readFileSync(file, "utf8")).reduce(
      (sum, e) => (e.u === user ? sum + e.b : sum),
      0,
    );
  }
  const file = path.join(dir, "usage.db");
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
  it("同一批用量经两个后端落盘 → 回读出来的总量相同", async () => {
    for (const driver of ["json", "sqlite"] as const) {
      const h = harness(driver);
      await h.source.open();
      h.at(day12);
      for (let i = 0; i < 7; i++) {
        h.account.consume("alice", "up", 1024);
      }
      h.account.consume("alice", "down", 4096);
      await h.source.close();
    }
    const window = "2026-03-15";
    expect(readTotal("json", "alice", window), "json 档落盘量").toBe(7 * 1024 + 4096);
    expect(readTotal("sqlite", "alice", window), "sqlite 档落盘量").toBe(7 * 1024 + 4096);
    // 回读侧同样：两个后端起进程都读到同一个总量
    for (const driver of ["json", "sqlite"] as const) {
      const h = harness(driver);
      await h.source.open();
      expect(h.account.usage("alice"), `${driver} 档回读量`).toBe(7 * 1024 + 4096);
      await h.source.close();
    }
  });

  it("两个后端都做「停机必落盘」（否则用户能靠反复 Ctrl+C 刷额度）", async () => {
    for (const driver of ["json", "sqlite"] as const) {
      const h = harness(driver);
      await h.source.open();
      h.at(day12);
      h.account.consume("alice", "up", 999);
      // 刻意不手动 sync
      await h.source.close();
      expect(readTotal(driver, "alice", "2026-03-15"), `${driver} 档停机落盘`).toBe(999);
    }
  });
});

describe("账本两个后端：装配按 QUOTA_USAGE_DRIVER 选", () => {
  function servicesWith(driver: string): ReturnType<typeof buildDefaultServices> {
    const store = new ConfigStore();
    store.set("quotaUsageDir", path.join(dir, driver));
    store.set("quotaUsageDriver", driver);
    const ctx = createConfigContext({ store, configDir: dir });
    return buildDefaultServices(
      testContextFor(ctx.accessor),
      {},
      () => undefined,
      {},
    );
  }

  it("driver=json → 账本文件名是 usage.jsonl；driver=sqlite → usage.db", () => {
    // 判据是**文件名形态**（哪个后端真的在写，可观察），不是「实例类型」（那只是装配的中间态）
    const json = servicesWith("json").usageSource;
    const sqlite = servicesWith("sqlite").usageSource;
    expect(path.basename(json?.file ?? ""), "json 档文件名").toBe(JSONL_USAGE_FILE_NAME);
    expect(path.basename(sqlite?.file ?? ""), "sqlite 档文件名").toBe("usage.db");
  });

  it("两个后端都不再按 worker 分槽（分槽是本仓换掉的真实配额逃逸）", () => {
    // 锚「文件名里没有 `worker-<数字>`」这个**今天仍成立的形状**，
    // 而不是点名 `normalizeSlot` 之类（点已删符号的负向断言会恒真）。
    for (const driver of ["json", "sqlite"] as const) {
      const name = path.basename(servicesWith(driver).usageSource?.file ?? "");
      expect(name, `${driver} 档文件名不得含 worker-<slot>`).not.toMatch(/^worker-\d+\.jsonl$/);
    }
  });
});

describe("账本驱动注册表：判据是「有没有注册」，未注册即抛错", () => {
  it("内置两项随注册表一起就位（错误信息里的「已注册」从第一次装配起就完整）", () => {
    expect(listUsageSourceDrivers().sort()).toEqual(["json", "sqlite"]);
  });

  it("未注册的驱动名**抛错**并列出全部已注册项，绝不静默落到某一支", () => {
    // 判据是「抛错」+「错误文本里点名了驱动名与已注册项」。后者不是锦上添花：拼错是部署出错
    // 最常见的成因，只说「未知驱动」等于让人去翻源码。
    // ⚠️ **不许把它改成断言「装出来的是某个内置后端」**：那正是静默回落，而回落会让用户以为
    // 配生效了。负向断言锚的是**今天仍存在的形状**（注册表 API），不是被删掉的符号名。
    let caught: unknown;
    try {
      resolveUsageSource("sqlit");
    } catch (error) {
      caught = error;
    }
    expect(caught, "未注册驱动必须抛错").toBeInstanceOf(Error);
    const text = (caught as Error).message;
    expect(text, "错误文本点名那个驱动名").toContain("sqlit");
    expect(text, "错误文本列出已注册项").toContain("sqlite");
    expect(text, "错误文本列出已注册项").toContain("json");

    // 装配侧同样：配置里写一个没注册的名字，`buildDefaultServices` 就要在装配期炸掉
    const store = new ConfigStore();
    store.set("quotaUsageDir", dir);
    store.set("quotaUsageDriver", "nope");
    const ctx = createConfigContext({ store, configDir: dir });
    expect(() =>
      buildDefaultServices(testContextFor(ctx.accessor), {}, () => undefined, {}),
    ).toThrow(/未注册/);
  });

  it("装配只经注册表查表，不许出现「与内置驱动名比较」的三元/开关", () => {
    // 行为面那两条锁的是「注册表被问了」；这一条锁的是「**只有**注册表被问」——
    // 写死三元 `driver === "json" ? A : B` 的退回方式上面两条**一条都不会红**（未注册的
    // 名字会静默拿到 B），而那恰恰是最贵的退化形态。
    // 锚点用 `blockAfter` 的返回类型那一行（同 `usage-source-runtime.test.ts` 的手法：
    // `export function buildDefaultServices(` 后面第一个 `{` 是**参数**里的花括号，切错块的
    // 表现是「零命中」而不是报错，所以先有一条正向断言证明切对了块）。
    const fn = blockAfter(codeOf("runtime", "services.ts"), "): RuntimeServices");
    expect(fn, "锚点失效：没切到 buildDefaultServices 的函数体").toContain("overrides.usageSource");
    expect(fn, "驱动必须经注册表解析").toContain("resolveUsageSource(");
    // 负向：与内置名字做比较的三元/开关/查表都判为「接了内置两支的某个副本」
    expect(fn, "不许拿驱动名与内置两个字面量做比较（那是写死的两支）").not.toMatch(
      /quotaUsageDriver\)\s*(===|!==|==)/,
    );
    expect(fn, "不许出现裸的驱动名字面量（json/sqlite 应由 BUILTIN_USAGE_DRIVERS 提供）").not.toMatch(
      /"(json|sqlite)"/,
    );
  });
});

describe("账本驱动注册表：自定义驱动真的被装配用上（护栏牙齿，见文件头）", () => {
  it("registerUsageSource + quotaUsageDriver=<自定义名> → 装出来的就是它", () => {
    // 行为面：判据是**自定义工厂造出的那个对象的可观察身份**（`file` 是本驱动独有的哨兵），
    // 不是「不是内置两档之一」——后者在退回的内置恰好不是 json 时会假绿。
    let built = 0;
    // 规格本身也校验一下：驱动拿到的必须是**平值闭包**，不是 `ConfigAccessor`。
    // 判据锚的是「值都是函数」这个今天成立的形状——`spec` 若改成收 `ConfigAccessor`，
    // 这里会立刻红（`typeof spec.dir` 变成 `"object"`），而那正是数据源层零配置依赖那条的破口。
    let seenSpec: Record<string, unknown> = {};
    const off = registerUsageSource("mem", (spec) => {
      built += 1;
      seenSpec = spec as unknown as Record<string, unknown>;
      return {
        file: "<mem:in-memory>",
        enabled: false,
        queued: 0,
        async open(): Promise<void> {
          /* 零副作用替身 */
        },
        async close(): Promise<void> {
          /* 零副作用替身 */
        },
        record: (): void => undefined,
      };
    });
    try {
      expect(listUsageSourceDrivers(), "注册后立刻出现在已注册列表里").toContain("mem");

      const store = new ConfigStore();
      store.set("quotaUsageDir", dir);
      store.set("quotaUsageDriver", "mem");
      const ctx = createConfigContext({ store, configDir: dir });
      const services = buildDefaultServices(
        testContextFor(ctx.accessor),
        {},
        () => undefined,
        {},
      );
      expect(built, "自定义工厂真的被调用了一次").toBe(1);
      for (const key of ["dir", "flushMs", "resetHour", "windowFor"] as const) {
        expect(typeof seenSpec[key], `spec.${key} 是闭包（平值 + 热读，装配层负责从 config 取值）`)
          .toBe("function");
      }
      // ⚠️ `enabled` **刻意不在上面那张表里**：它曾是「有没有人配了非 0 配额」的判据，
      // 而账本落盘已经无条件（不变量：在判定 ⇒ 一定在记账），那个闭包连同它带来的
      // 「判定生效、落库不生效」一起删掉了。列进来会让这条断言要求一个已删除的接线复活。
      expect(seenSpec, "spec 上不该再有 enabled（落盘无条件的代价：这条接线已删除）").not.toHaveProperty("enabled");
      expect(services.usageSource?.file, "装配用的是自定义驱动，不是内置两档的任何一个").toBe(
        "<mem:in-memory>",
      );
      // 退订之后同一个名字回到「未注册」——证明装配确实只认注册表
      off();
      expect(listUsageSourceDrivers()).not.toContain("mem");
      expect(() => resolveUsageSource("mem"), "退订后未注册即抛错").toThrow(/未注册/);
    } finally {
      off();
    }
  });

  it("重名注册必须抛错（不静默替换），除非显式 override", () => {
    const make = (): (() => void) =>
      registerUsageSource("dup", () => {
        throw new Error("不该被构造");
      });
    const off1 = make();
    try {
      expect(make, "重名且未给 override 即抛错").toThrow(/已注册/);
      const off2 = registerUsageSource("dup", () => {
        throw new Error("不该被构造");
      }, { override: true });
      // 覆盖之后，先前那个注册方的退订**不许**把新项删掉
      off1();
      expect(listUsageSourceDrivers(), "已被覆盖的那项不许被旧退订删掉").toContain("dup");
      off2();
    } finally {
      off1();
    }
  });
});

describe("镜像的误差上界：另一个实例写的字节在一个上界内对本进程可见", () => {
  it("两个实例指向同一个库：B 记的量在 A 的下一轮回读里出现，且判定随之收紧", async () => {
    // 锚是 `mirrorLagBoundMs` 那个**声明过的量**，不是「等一会儿就看见了」——
    // 后者会随机器快慢漂移，且测不出「回读从周期循环里被摘掉」这种退化。
    const { mirrorLagBoundMs } = await import("@/datasource/quota/mirror.js");
    const P = 20;
    expect(mirrorLagBoundMs(P), "上界 = 2 × 周期（一个给写入方落库，一个给读出方回读）").toBe(2 * P);

    // 上限 300：A 自己的 100 看不见 B 的 250 时它判定「还有 200 可用」，
    // 看见之后立刻只剩不到 0 —— **判定收紧的那一刻就是「权威不再是权威」被抓住的那一刻**
    const limit: UsageQuota = { bytes: 300, window: "day" };
    const a = harness("sqlite", limit);
    const b = harness("sqlite", limit);
    try {
      await a.source.open();
      await b.source.open();
      a.at(day12);
      b.at(day12);

      a.account.consume("alice", "up", 100);
      b.account.consume("alice", "up", 250);
      await b.source.sync();

      // A 还没回读：A 的镜像只有自己的 100，于是它判定「还能用 200」——
      // ⚠️ **这一条是本机制最重要的事实**：判定是每进程一份的，权威那一份此刻是 250 而 A 看不见。
      expect(a.account.usage("alice"), "回读之前 A 看不到 B 的字节").toBe(100);
      expect(a.account.consume("alice", "up", 200).allow, "A 此刻按自己那份放行（恰好等于上限）").toBe(
        true,
      );

      // A 的下一轮：先落盘（它自己那 300 进库），再回读（库里 = A 300 + B 250 = 550）
      await a.source.sync();
      expect(a.account.usage("alice"), "回读后 A 看到权威总量（两者之和）").toBe(550);
      expect(
        a.account.consume("alice", "up", 1).allow,
        "吸收别人的量之后，判定立刻按合计上限收紧",
      ).toBe(false);
    } finally {
      await a.source.close();
      await b.source.close();
    }
  });

  it("回读用 max 合并：本地未落盘的字节不会被回读抹掉（也不重复计账）", async () => {
    // 这条锁的是「合并语义」本身。写盘失败 → 库里比镜像少；重复回读 → 库里的值会被再次读到。
    // 两种情形下镜像都必须保持**单调不减**，否则「写盘失败一次」就等于把用户的用量清零。
    const h = harness("sqlite");
    await h.source.open();
    h.at(day12);
    for (let i = 0; i < 3; i++) {
      h.account.consume("alice", "up", 10);
      await h.source.sync();
    }
    expect(h.account.usage("alice"), "三轮同步后不回退").toBe(30);
    // 再回读一次（值不变）仍然不能变成 60
    await h.source.sync();
    expect(h.account.usage("alice"), "重复回读不重复计账").toBe(30);
    await h.source.close();
  });
});

describe("账本两个后端：各自的能力边界（不许被抹平）", () => {
  it("两个后端都会丢弃过期窗口，机制不同（json 靠压缩、sqlite 靠 DELETE）", async () => {
    // WARN 本条最初写成「json 档**不**做运行期清理」——**实测为假**：json 档在 open()
    // 的启动期压缩里就会把过期窗口丢掉。真实差别只是**时机与机制**：
    //   - json：压缩时丢（阈值 8MiB 或 open/close 触发），没有「每轮都清」这个节奏
    //   - sqlite：每轮扫描时 DELETE，没有独立的压缩步骤
    // 所以这里断言**两者都丢**（抽象成立），机制差异由下面那条源码级断言钉住。
    // 把「已知缺口」写成一条实测为假的断言比没有更坏：它会让下一个人以为 json 档会
    // 无限增长，从而做出错误的迁移决策。
    const jsonFile = path.join(dir, JSONL_USAGE_FILE_NAME);
    fs.writeFileSync(
      jsonFile,
      `${JSON.stringify({ ts: at(2026, 3, 1, 12), u: "alice", d: "up", b: 5000 })}\n`,
      "utf8",
    );
    const j = harness("json");
    await j.source.open();
    j.at(day12);
    expect(j.account.usage("alice"), "json 档：过期行不计入判定").toBe(0);
    await j.source.close();
    expect(
      fs.readFileSync(jsonFile, "utf8").split("\n").filter((l) => l.length > 0).length,
      "json 档：过期窗口在压缩时被丢弃",
    ).toBe(0);

    // sqlite 档：直接往库里塞一条过期窗口，再起一次进程
    const dbFile = path.join(dir, "usage.db");
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
    await s.source.open();
    s.at(day12);
    expect(s.account.usage("alice"), "sqlite 档：过期行不计入判定").toBe(0);
    await s.source.close();
    expect(readTotal("sqlite", "alice", "2026-03-01"), "sqlite 档：过期窗口被删掉").toBe(0);
  });

  it("json 档的写是「读-改-整文件重写」，故不承诺并发写安全（sqlite 档有事务）", () => {
    // 钉住两个后端**能力面不同**这件事本身：json 档的压缩走 `writeFile(tmp)` + `rename`，
    // sqlite 档走 UPSERT。若哪天 json 档也换成事务，两后端就更接近了——
    // 这条会提醒人重新审视「两档是否仍可互换」。
    const jsonl = codeOf("datasource", "quota", "jsonl-source.ts");
    expect(jsonl, "json 档是 append + 压缩").toContain("compactEntries");
    const sqlite = codeOf("datasource", "quota", "sqlite-source.ts");
    expect(sqlite, "sqlite 档是事务 + UPSERT").toContain("BEGIN IMMEDIATE");
    expect(sqlite, "sqlite 档是事务 + UPSERT").toContain("ON CONFLICT");
  });

  it("两档的**回读与清理同出一趟扫描**（同一个「什么算过期」的定义）", () => {
    // 这条锚的是「同一个 `SELECT` 同时产出回读结果与过期行名单」这个形状。分开成两个查询
    // 就会出现「读到的是清理之前、删的是清理之后」的时序缝，而那会吃掉「本进程启动时正好
    // 跨过窗口边界」的那部分用量——**静默少算**，不报错。
    const sqlite = codeOf("datasource", "quota", "sqlite-source.ts");
    expect((sqlite.match(/SELECT u, w, v FROM usage/g) ?? []).length, "全表扫描只有一处").toBe(1);
    expect(sqlite, "扫描结果同时喂回读与过期名单").toContain("deleteStale(stale)");
    const jsonl = codeOf("datasource", "quota", "jsonl-source.ts");
    // json 档的对应形状：**恢复（open）与回读（readBack）逐字共用同一条判据**。
    // 写成两套过滤就会出「恢复算进来的量比回读算进来的多」这类静默偏差。
    expect(blockAfter(jsonl, "public async open("), "启动期恢复走 summarizeCurrent").toContain(
      "summarizeCurrent(",
    );
    expect(blockAfter(jsonl, "private async readBack("), "周期回读走 summarizeCurrent").toContain(
      "summarizeCurrent(",
    );
  });
});
