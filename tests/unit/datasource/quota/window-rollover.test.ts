/**
 * 窗口滚动清账（惰性，不继承旧用量）+ 账本槽位规模有界
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`（本目录只放「这一档管哪一段 + 指向 `AGENTS.md`」）。
 * 本档答「**跨窗口时账本怎么办**」：`now` 推过边界后同一用户 `usage` 归零、消耗重新从 0 计、
 * **旧用量绝不继承**；窗口类型按用户独立生效（缺省 `month`）；`resetHour` 现读因而热改即时生效。
 * 「键本身怎么算」在 `window-key.test.ts`。
 */

import { describe, expect, it } from "vitest";
import {
  UsageMirror,
  createUsageMirror,
  type UsageAccount,
  type UsageQuota,
} from "@/datasource/quota/index.js";
import { codeOf, sourceOf } from "../../../helpers/source-scan.js";

/** 造一个「时刻可推进」的账本：`at(t)` 把时钟拨到 t，返回该账本。 */
function accountAt(
  start: number,
  quotas: Record<string, UsageQuota> = {},
  resetHour = 0,
): { account: UsageMirror; at: (t: number) => UsageMirror } {
  let now = start;
  const account = createUsageMirror(
    (user: string) => quotas[user],
    { resetHour: () => resetHour, now: () => now },
  ) as UsageMirror;
  return { account, at: (t: number) => ((now = t), account) };
}

describe("@/datasource/quota 窗口滚动清账（惰性，不继承旧用量）", () => {
  const day = (y: number, m: number, d: number, h: number, mi = 0): number =>
    new Date(y, m - 1, d, h, mi, 0, 0).getTime();

  /** 显式写死 window 的配额替身（默认 month，所以要滚 day 窗口的用例必须显式写 day） */
  const withWindow = (
    window: "day" | "month",
    rest: Partial<UsageQuota> = {},
  ): UsageQuota => ({ bytes: 0, window, ...rest });

  it("day 窗口：把 now 推过边界 → usage 归零、consume 重新从 0 计数，旧用量不继承", () => {
    const { account, at } = accountAt(
      day(2026, 3, 15, 1),
      { alice: withWindow("day", { bytes: 10 }) },
      3,
    );
    at(day(2026, 3, 15, 1));
    account.consume("alice", "up", 7);
    account.consume("alice", "down", 3);
    expect(account.usage("alice")).toBe(7 + 3);
    // 撞顶：10 字节上限已用满（累计值照实不截断，故此刻 up 已是 8）
    expect(account.consume("alice", "up", 1).allow).toBe(false);
    expect(account.usage("alice")).toBe(8 + 3);

    // 推过 03:00 → 新窗口。**旧用量绝不继承**：归零而不是把 8+3 搬到新账上
    at(day(2026, 3, 15, 3));
    expect(account.usage("alice")).toBe(0);
    // 上一窗口的耗尽状态也一并解除（新窗口给了完整额度）
    expect(account.consume("alice", "up", 10).allow).toBe(true);
    expect(account.usage("alice")).toBe(10);
    expect(account.consume("alice", "up", 1).allow).toBe(false);
  });

  it("usage 自身也会滚动：不调 consume、只读一次用量就已归零", () => {
    // 「滚动即清账」的实现点是**每次访问槽位**（consume 与 usage 共用 slotFor），
    // 所以只读不写也必须清 —— 否则「只查不用」的调用方会读到上一窗口的旧账。
    const { account, at } = accountAt(day(2026, 3, 15, 10), { alice: withWindow("day") }, 0);
    at(day(2026, 3, 15, 10));
    account.consume("alice", "down", 500);
    expect(account.usage("alice")).toBe(500);
    at(day(2026, 3, 16, 0, 1));
    expect(account.usage("alice")).toBe(0);
    // 槽位仍在（清账 ≠ 除名）：用户还是「计量过」的
    expect(account.size).toBe(1);
  });

  it("month 窗口：跨月才归零，resetHour=3 时 4/1 凌晨 03:00 之前仍属 3 月", () => {
    const quotas: Record<string, UsageQuota> = { alice: withWindow("month") };
    const { account, at } = accountAt(day(2026, 3, 20, 12), quotas, 3);
    at(day(2026, 3, 20, 12));
    account.consume("alice", "up", 111);
    at(day(2026, 3, 31, 23, 59));
    expect(account.usage("alice")).toBe(111);
    at(day(2026, 4, 1, 2, 59));
    expect(account.usage("alice")).toBe(111);
    at(day(2026, 4, 1, 3));
    expect(account.usage("alice")).toBe(0);
  });

  it("窗口类型按用户独立生效：同一时刻 alice(day) 翻页而 bob(month) 不翻", () => {
    const quotas: Record<string, UsageQuota> = {
      alice: withWindow("day"),
      bob: withWindow("month"),
    };
    const { account, at } = accountAt(day(2026, 3, 15, 23), quotas, 0);
    at(day(2026, 3, 15, 23));
    account.consume("alice", "up", 10);
    account.consume("bob", "up", 10);
    at(day(2026, 3, 16, 0, 1));
    expect(account.usage("alice")).toBe(0);
    expect(account.usage("bob")).toBe(10);
    // 时钟回拨也不「复活」旧账：窗口键是「时刻 → 窗口」的纯映射，键一变就是新账
    at(day(2026, 3, 15, 23));
    expect(account.usage("alice")).toBe(0);
    expect(account.usage("bob")).toBe(10);
  });

  it("未配 quota 的用户同样按缺省 month 记窗口（没有上限 ≠ 不计量）", () => {
    const { account, at } = accountAt(day(2026, 3, 31, 23), {}, 0);
    at(day(2026, 3, 31, 23));
    account.consume("ghost", "down", 42);
    at(day(2026, 3, 31, 23, 30));
    expect(account.usage("ghost")).toBe(42);
    at(day(2026, 4, 1, 0, 1));
    expect(account.usage("ghost")).toBe(0);
  });

  it("热改 resetHour 即时改变窗口边界（现读，不必重建账本）", () => {
    let resetHour = 0;
    let now = day(2026, 3, 15, 1);
    const account = new UsageMirror(
      (user: string) => (user === "alice" ? withWindow("day") : undefined),
      { resetHour: () => resetHour, now: () => now },
    );
    account.consume("alice", "up", 5);
    expect(account.usage("alice")).toBe(5);
    // 把重置点从 0 点挪到 3 点：此刻（15 日 01:00）已属于 14 日那本账 → 归零
    resetHour = 3;
    now = day(2026, 3, 15, 1);
    expect(account.usage("alice")).toBe(0);
    // 再挪回去 → 回到 15 日那本账（仍是 0，因为上一次滚动已清零）
    resetHour = 0;
    expect(account.usage("alice")).toBe(0);
  });
});

describe("@/datasource/quota 账本规模有界，且不靠猜测性淘汰", () => {
  const day = (y: number, m: number, d: number, h: number, mi = 0): number =>
    new Date(y, m - 1, d, h, mi, 0, 0).getTime();
  const withWindow = (window: "day" | "month"): UsageQuota => ({
    bytes: 0,
    window,
  });

  it("同一用户在窗口内重复读/写不产生新槽位（滚动不新增、只替换）", () => {
    const { account, at } = accountAt(
      day(2026, 3, 15, 0),
      { alice: withWindow("day") },
      0,
    );
    at(day(2026, 3, 15, 0));
    account.consume("alice", "up", 1);
    expect(account.size).toBe(1);
    for (let i = 0; i < 500; i++) {
      account.consume("alice", "down", 1);
      account.usage("alice");
    }
    expect(account.size).toBe(1);
    // 跨窗：槽位被**替换**而不是新增
    at(day(2026, 3, 16, 0, 1));
    account.consume("alice", "up", 1);
    expect(account.size).toBe(1);
    expect(account.usage("alice")).toBe(1);
  });

  it("查询一个从未计量过的用户不建槽（读一次不该凭空长出槽位）", () => {
    const { account } = accountAt(day(2026, 3, 15, 0), {}, 0);
    expect(account.usage("nobody")).toBe(0);
    expect(account.usage("")).toBe(0);
    expect(account.size).toBe(0);
  });

  it("本文件不删槽位、不引入 LRU/容量上限（淘汰必须与配额窗口一起设计）", () => {
    // 源码级：窗口滚动只**替换**槽位（滚动即清账），从不删除。
    // 谁想加 LRU，必须先改这条护栏并说明淘汰语义 —— 因为被淘汰的用户会拿到一份清零的账，
    // 那等于凭空多出一份额度，比不淘汰更糟。
    const code = codeOf("datasource", "quota", "mirror.ts");
    expect(code).not.toMatch(/\.delete\(/);
    expect(code).not.toMatch(/\bLRU\b|\blru\b|maxEntries|evict/i);
  });

  it("已知限制如实记录在文件头：jwt 的 sub 可无限增长，压缩按窗口键丢弃过期条目", () => {
    // 限制**没有被完全解决**（落盘压缩只解决「持久」那一半，进程内的 Map 仍不淘汰），
    // 但必须留在文件头免得被当成「没想过」。
    // 注意这条断言读的是**原文**（含注释）：文档本身也是契约的一部分。
    // 锚点锁的是**当前机制名**（`compactEntries` 丢弃过期窗口的条目），
    // 不是任何时间坐标——文档改写时这条断言要跟着改锚，不该反过来让文档迁就它。
    const header = sourceOf("datasource", "quota", "mirror.ts");
    expect(header).toContain("jwt");
    expect(header).toContain("compactEntries");
    // 行为侧对应：槽位数只随「计量过的用户数」增长，不随窗口数增长
    const { account, at } = accountAt(day(2026, 3, 1, 0), {}, 0);
    for (let d = 1; d <= 28; d++) {
      at(day(2026, 3, d, 0, 1));
      account.consume(`sub-${d}`, "up", 1);
    }
    expect(account.size).toBe(28);
  });
});

describe("@/datasource/quota 计量口径在窗口下依然逐字节精确", () => {
  it("窗口内 usage 逐块累加精确（滚动不引入误差）", () => {
    let now = new Date(2026, 2, 15, 0, 0, 0).getTime();
    const account: UsageAccount = createUsageMirror(
      () => ({ bytes: 0, window: "day" }),
      { resetHour: () => 0, now: () => now },
    );
    for (let i = 1; i <= 100; i++) {
      account.consume("alice", "up", 16 * 1024);
      expect(account.usage("alice")).toBe(i * 16 * 1024);
    }
    // 跳到下一天：清零后重新精确计数
    now = new Date(2026, 2, 16, 0, 0, 1).getTime();
    account.consume("alice", "up", 7);
    expect(account.usage("alice")).toBe(7);
  });
});
