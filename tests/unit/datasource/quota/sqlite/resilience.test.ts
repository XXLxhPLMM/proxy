/**
 * sqlite 档的两条韧性：**写库失败重试不重复计账**与**窗口过期清理（一条 DELETE 顶掉整套压缩）**
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`（本目录只放「这一档管哪一段 + 指向 `AGENTS.md`」）。
 * 注入口径：用 `openDriver` 注入位（`SqliteUsageSourceOptions.openDriver`）把驱动换成「第 N 次
 * 写就抛」的替身，**不 mock 模块**。理由是可移植性：本仓主战场是 Windows CI，造不出稳定的真实
 * `ENOSPC`；而这里被测的是**本模块的事务与回队逻辑**，不是 SQLite 本身。
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  SqliteUsageSource,
  type QuotaWindow,
  type UsageQuota,
  type UsageSourceError,
} from "@/datasource/quota/index.js";
import { UsageMirror } from "@/datasource/quota/mirror.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import type { SqliteDriver } from "@/utils/sqlite/index.js";
import {
  DAY_KEY,
  at,
  day12,
  dir,
  harness,
  rowCount,
  totalIn,
  windowKeyOf,
  withWindow,
  type DriverFactory,
  type HarnessOptions,
} from "./_usage-source.js";

describe("@/datasource/quota sqlite-source：写库失败韧性（重试不重复计账）", () => {
  it("写失败：内存计数继续、usage() 可读、事件上抛；**恢复后重试不双计**", async () => {
    // 落库走的是**幂等累加**（`ON CONFLICT DO UPDATE SET v = v + excluded.v`），而**整批包在
    // 一个事务里**。事务中途失败会整批回滚，所以「重试」面对的一定是「一条都没写进去」的库。
    // 一旦哪天有人把 `BEGIN/COMMIT` 去掉（看起来只是「少两次 exec」），这条断言立刻红——
    // 而那正是**用户被重复计费**的形态。
    //
    // 注入「第 2 条累加就抛」的驱动替身。
    // ⚠️ **必须造两个 delta**：失败发生在**事务内的第 2 条**上，第 1 条已经写进库了 ——
    // 这正是「事务回滚」要证明的场景（只造 1 条 delta 的话，失败点在事务边界之外，
    // 根本证明不了回滚，重试不双计也就成了恒绿）。
    const batch = 10;
    let runs = 0;
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
