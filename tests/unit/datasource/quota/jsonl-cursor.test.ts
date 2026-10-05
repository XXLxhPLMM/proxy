/**
 * jsonl 档的**按游标增量回读**：游标一旦指错就是重复计账（用户莫名其妙提前撞顶）
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`（本目录只放「这一档管哪一段 + 指向 `AGENTS.md`」）。
 * 本档锁的是这一类失效，以及它赖以成立的三条判据。这些坑**全部不在既有用例的覆盖范围内** ——
 * 既有用例都是「写→sync→读」的整齐序列，游标永远单调前进、文件从不被换；增量读引入的恰恰是
 * 「文件被换掉」与「读到半行」这两件事，所以必须逐条造出来。
 * 两档账本的等价性与驱动注册表在 `datasource/quota/drivers/` 那两档。
 *
 * ⚠️ 本档**自带**一份 `harness` / `dir` / `at` / `QUOTA`，而没有从 `./drivers/_usage-drivers.js`
 * 引入：那份模块归 `drivers/` 子目录（有它自己的 `AGENTS.md`），而本目录的档与它是**平级主题**
 * ——跨子目录共用一份装配面会让「哪个目录拥有这份 harness」变成要靠猜的问题。**可见的重复优于
 * 看不见的失效。**
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JSONL_USAGE_FILE_NAME,
  parseUsageEntries,
  quotaWindow,
  type QuotaWindow,
  type UsageQuota,
  type UsageSnapshot,
  type UsageSourceError,
} from "@/datasource/quota/index.js";
import { UsageMirror } from "@/datasource/quota/mirror.js";
import { JsonlUsageSource } from "@/datasource/quota/jsonl-source.js";

const at = (y: number, m: number, d: number, h = 0): number =>
  new Date(y, m - 1, d, h, 0, 0, 0).getTime();

const QUOTA: UsageQuota = { bytes: 10_000_000, window: "day" };
const day12 = at(2026, 3, 15, 12);

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-jsonl-"));
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

/** 组一套「用量镜像 + jsonl 档数据源」，形状与 `buildDefaultServices` 逐字同构 */
function harness(quota: UsageQuota = QUOTA) {
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
  const source = new JsonlUsageSource(shared);
  account.bindSink(source);
  return { account, source, errors, at: (t: number) => (clock.now = t) };
}

describe("jsonl 档：按游标增量回读（而不是每轮全量）", () => {
  const ledgerFile = (): string => path.join(dir, JSONL_USAGE_FILE_NAME);

  /** 造一行与实现器逐字同形的 entry（键序 ts/u/d/b） */
  const line = (ts: number, u: string, d: "up" | "down", b: number): string =>
    `${JSON.stringify({ ts, u, d, b })}\n`;

  it("只读新增的那一段（游标单调前进，回读代价不随文件长度增长）", async () => {
    const h = harness();
    await h.source.open();
    h.at(day12);

    for (let round = 1; round <= 3; round++) {
      for (let i = 0; i < 5; i++) {
        h.account.consume("alice", "up", 100);
      }
      await h.source.sync();
      expect(h.account.usage("alice"), `第 ${round} 轮回读后`).toBe(round * 5 * 100);
    }
    // 文件里确有全部 15 条，而镜像的数与之逐字相等（增量没有漏、没有重）
    expect(fs.readFileSync(ledgerFile(), "utf8").trim().split("\n")).toHaveLength(15);
    await h.source.close();
  });

  it("尾行残缺时不消费、不前移游标（下一轮补齐，绝不丢那条增量）", async () => {
    const h = harness();
    await h.source.open();
    h.at(day12);

    // 直接往账本里写一条**没有行尾**的残缺行（模拟别人正写、我们读到一半）
    fs.appendFileSync(ledgerFile(), line(day12, "alice", "up", 777).trimEnd());
    await h.source.sync();
    expect(h.account.usage("alice"), "残缺行不计入").toBe(0);

    // 补上换行（那一行「写完」了）→ 下一轮必须把它读出来，且**只算一次**
    fs.appendFileSync(ledgerFile(), "\n");
    await h.source.sync();
    expect(h.account.usage("alice"), "补齐后计入一次").toBe(777);
    await h.source.sync();
    expect(h.account.usage("alice"), "重复回读不重复计账").toBe(777);
    await h.source.close();
  });

  it("**另一个进程压缩过**之后：靠内容哨兵认出文件被换掉并重建（否则游标错位 = 重复计账）", async () => {
    const h = harness();
    await h.source.open();
    h.at(day12);
    h.account.consume("alice", "up", 500);
    await h.source.sync();
    expect(h.account.usage("alice")).toBe(500);

    // 模拟另一个进程压缩：等价效果是「文件被换成了一份不同布局的内容」。
    // 刻意用 `day` 窗口的三条合并成一条 —— 文件**变短**，而变短是靠 `st_size < 游标` 认出的。
    fs.writeFileSync(ledgerFile(), line(day12, "alice", "up", 1500));

    await h.source.sync();
    expect(h.account.usage("alice"), "重建后读到的是压缩后的基线，不是重复累加").toBe(1500);
    await h.source.close();
  });

  it("压缩让文件**变大**时也必须重建（只比大小会漏认，游标会落进新内容中段）", async () => {
    const h = harness();
    await h.source.open();
    h.at(day12);
    h.account.consume("alice", "up", 400);
    await h.source.sync();

    // 每用户原本一条 → 压缩给 up/down **各一条**，于是文件变大。
    // 而本进程游标是 `oldSize`，新文件更大 ⇒ `st_size < readCursor` 认不出。
    // 只有内容哨兵认得出 —— 这条正是哨兵存在的理由（实测：没有哨兵时这里会读到重复计账）。
    const bigger =
      line(day12, "alice", "up", 400) +
      line(day12, "alice", "down", 100) +
      line(day12, "bob", "up", 250) +
      line(day12, "bob", "down", 250);
    fs.writeFileSync(ledgerFile(), bigger);

    await h.source.sync();
    expect(h.account.usage("alice"), "alice 应为 500（不能是 400+400+400）").toBe(500);
    expect(h.account.usage("bob"), "bob 应为 500").toBe(500);
    await h.source.close();
  });

  it("本进程压缩之后：游标与累积值双双作废并重建（否则压缩保留的量会被算两遍）", async () => {
    // 阈值给 1 字节 ⇒ 落盘后立刻压缩。走的是既有压缩路径，不是新增能力。
    const errors: UsageSourceError[] = [];
    const clock = { now: day12 };
    const account = new UsageMirror(() => ({ bytes: 10_000_000, window: "day" }), {
      resetHour: () => 0,
      now: () => clock.now,
    });
    const source = new JsonlUsageSource({
      dir: (): string => dir,
      flushMs: (): number => 3_600_000,
      resetHour: (): number => 0,
      compactBytes: (): number => 1,
      windowFor: (): QuotaWindow => quotaWindow("day"),
      now: (): number => clock.now,
      onSnapshot: (r: UsageSnapshot): void => {
        account.absorb(r);
      },
      onError: (e: UsageSourceError): void => {
        errors.push(e);
      },
    });
    account.bindSink(source);
    await source.open();
    clock.now = day12;
    account.consume("alice", "up", 100);
    account.consume("alice", "down", 50);
    // 第一轮：落盘 → 触发压缩 → 游标记为失效 → 重建
    await source.sync();
    // 第二轮：压缩不重复触发（compactedAt 拦住），游标已对齐
    await source.sync();
    expect(errors, "压缩与重建都不该报错").toEqual([]);
    expect(account.usage("alice"), "压缩后重建不重复计账").toBe(150);
    // 压缩后 alice 至多两条（up/down 各一）
    expect(parseUsageEntries(fs.readFileSync(ledgerFile(), "utf8")).length).toBeLessThanOrEqual(2);
    await source.close();
  });

  it("账本文件被别人整个换掉（删了重写）之后：游标作废并按新文件重建", async () => {
    const h = harness();
    await h.source.open();
    h.at(day12);
    h.account.consume("alice", "up", 900);
    await h.source.sync();
    expect(h.account.usage("alice")).toBe(900);

    // 删掉整本账，再放一份**布局完全不同**的（等价于「文件从游标之前就被换掉了」）。
    // 游标若被沿用，读到的将是新文件里那个偏移之后的一截 —— 内容错乱或凭空重复。
    fs.writeFileSync(ledgerFile(), line(day12, "alice", "down", 1200) + line(day12, "bob", "up", 7));
    await h.source.sync();
    // 镜像是 `max(本地, 权威)`：本地有 900，权威换成 1200 → 取 1200（不是 2100）
    expect(h.account.usage("alice"), "重建后不与旧偏移叠算").toBe(1200);
    expect(h.account.usage("bob"), "新文件里的其他用户也要被看到").toBe(7);
    await h.source.close();
  });

  it("发布的是每轮一份独立快照（累积值内层对象不被原地改，否则调用方手里的数会自己变）", async () => {
    const seen: UsageSnapshot[] = [];
    const clock = { now: day12 };
    const account = new UsageMirror(() => QUOTA, { resetHour: () => 0, now: () => clock.now });
    const source = new JsonlUsageSource({
      dir: (): string => dir,
      flushMs: (): number => 3_600_000,
      resetHour: (): number => 0,
      windowFor: (): QuotaWindow => quotaWindow(QUOTA.window),
      now: (): number => clock.now,
      onSnapshot: (r: UsageSnapshot): void => {
        seen.push(r);
        account.absorb(r);
      },
    });
    account.bindSink(source);
    await source.open();
    clock.now = day12;
    account.consume("alice", "up", 100);
    await source.sync();
    const first = seen[seen.length - 1];
    account.consume("alice", "up", 250);
    await source.sync();
    const second = seen[seen.length - 1];

    expect(second).not.toBe(first);
    expect(first.get("alice")?.total, "上一轮快照不被这一轮改写").toBe(100);
    expect(second.get("alice")?.total).toBe(350);
    await source.close();
  });
});
