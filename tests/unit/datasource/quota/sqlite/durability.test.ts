/**
 * sqlite 档这本权威账怎么**活过一次重启、怎么被多个进程共用、怎么在停机前排空**
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`（本目录只放「这一档管哪一段 + 指向 `AGENTS.md`」）。
 * 锁四组：两个实例写同一个库时量在**同一行**上相加（旧形态分槽做不到）、重启恢复只认**当前窗口**、
 * **落盘无条件**（在判定 ⇒ 一定在记账）、停机落盘与 `close` 幂等。
 * 断言 `usage()` 时驱动自己也在被测方：「恢复」与「回读」在本目录是**一个实现**，不是一个
 * 「只跑一次的特例」，所以用例要注意**回读会覆盖镜像**。
 * 写库失败韧性与窗口过期清理在 `resilience.test.ts`；布局与层边界在 `layout.test.ts`。
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { UsageSourceError } from "@/datasource/quota/index.js";
import {
  DAY_KEY,
  day12,
  dir,
  harness,
  rowCount,
  totalIn,
  windowKeyOf,
  withWindow,
  at,
  type HarnessOptions,
} from "./_usage-source.js";

describe("@/datasource/quota sqlite-source：多进程共享同一本权威账", () => {
  it("两个账本实例写同一个库 → 量在**同一行**上相加（分槽做不到这件事）", async () => {
    // 旧形态给每个 cluster worker 一本 `worker-<slot>.jsonl`，判定时也只恢复自己那本 ——
    // 判定语义写的是「账号级封禁」，实际跑出来是「**每进程一份**封禁」。根因不是写错，
    // 而是**真相源被切成了 N 份**。所以护栏不能只测「一个进程能恢复」，必须测「两个进程写同一个
    // 文件时量是**相加**的」——否则分槽复活了也没人知道。
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

describe("@/datasource/quota sqlite-source：落盘无条件", () => {
  /**
   * **不变量：在判定 ⇒ 一定在记账。**
   * @description 账本曾经有一道「有没有人配了非 0 的 `quota.bytes`」的门，而账号表是每 chunk
   * 现读的：运行中热加一个配额，**判定立刻封顶、落库永远不开始**，于是一切照常跑、账本文件
   * 压根不存在、日志一条不出，重启后配额从零重新开始（实测：内存累计 32768 字节被判超限，
   * 库是空的，`usage` 表 `[]`）。这档锁住「无配额也照样建库建表、照样记账」——
   * 拆掉 `open()` 里那道门（`SqliteUsageSource`）必须会红。
   */
  it("账号表里没人配 quota.bytes → 照样建目录建表并记账", async () => {
    // ⚠️ 账本目录取 `<dir>/ledger` **子目录**：`dir` 本身是 `mkdtemp` 出来的、必然已存在，
    // 断言它不存在永远是假的（这是「负向断言锚到已存在事实」的典型假绿）。这里反过来断言它
    // **存在**，但目录名同样必须是不存在的子目录，否则断言恒真。
    const ledgerDir = path.join(dir, "ledger");
    expect(fs.existsSync(ledgerDir), "前提：账本目录事先不存在").toBe(false);
    const h = harness(ledgerDir, { quotas: {} });
    await h.ledger.open();
    expect(h.ledger.enabled, "无配额也必须启用（否则判定与落盘脱钩）").toBe(true);
    expect(fs.existsSync(ledgerDir), "账本目录建出来了").toBe(true);
    expect(fs.existsSync(h.file), `库文件建出来了：${h.file}`).toBe(true);

    h.at(day12);
    h.account.consume("alice", "down", 1000);
    await h.ledger.sync();
    // 判据必须落在**真的写进了库**上，而不是「enabled 为 true」这种可以被恒真满足的形状：
    // 拆掉门之后 enabled 照样是 true，只有读库才能分辨。窗口键由 `windowKeyOf` 算（不硬编
    // 日期串：窗口口径变了这条会给出「查 0 行」而不是「查到别的行」这种更费解的失败）。
    expect(
      totalIn(h.file, "alice", windowKeyOf(day12, "month", 0)),
      "无配额的用量也落库了（「没有上限」≠「不计量」）",
    ).toBe(1000);
    await h.ledger.close();
  });

  it("落库失败不静默：`open()` 建不了目录时报错并走 onError（可见性而非假装成功）", async () => {
    // 目标是一个**已存在的普通文件**：mkdir 在它下面必然失败（ENOTDIR/EEXIST 类），
    // 于是 open() 走 catch → report(error)，而 enabled 留在 false。
    const notADir = path.join(dir, "blocker");
    fs.writeFileSync(notADir, "not a directory", "utf8");
    const errors: UsageSourceError[] = [];
    const h = harness(path.join(notADir, "usage"), { quotas: {}, onError: (e) => errors.push(e) });
    await h.ledger.open();
    expect(h.ledger.enabled, "建不了存储就不能自称启用").toBe(false);
    expect(errors.length, "失败必须上抛成可见事件（静默吞掉 = 运维以为在记账）").toBeGreaterThan(0);
    await h.ledger.close();
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
