/**
 * 账本两个内置后端（json / sqlite）的**等价性**与**各自的能力边界**
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`（本目录只放「这一档管哪一段 + 指向 `AGENTS.md`」）。
 * 本档答「换一个后端，判定语义不变、装配真的换掉」：锚点是**读回来的数字**与**文件名形态**，
 * 而不是「文件存在」（后者在「写了个空文件」时也成立）。
 * 驱动注册表（未注册即抛错 / 自定义驱动真的被装配用上）与镜像的误差上界在 `registry.test.ts`；
 * jsonl 档的按游标增量回读在 `../jsonl-cursor.test.ts`。
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ConfigStore, createConfigContext } from "@/config/index.js";
import {
  JSONL_USAGE_FILE_NAME,
  parseUsageEntries,
} from "@/datasource/quota/index.js";
import { buildDefaultServices } from "@/runtime/services.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import { testContextFor } from "../../../../helpers/config.js";
import { blockAfter, codeOf } from "../../../../helpers/source-scan.js";
// `dir` 是活绑定、只读；临时目录的建立与回收在模块自己的 `beforeEach` / `afterEach` 里。
import { at, day12, dir, harness } from "./_usage-drivers.js";

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
    // json 档的对应形状：**恢复（open）与周期回读（readBack）逐字共用同一条判据**。
    // 写成两套过滤就会出「恢复算进来的量比回读算进来的多」这类静默偏差。
    // 判据锚的是**两者调的是同一个函数**这个形状（`foldText`：窗口键比较与跨窗清零都在它
    // 体内），不是某个具体名字——回读从「全量求和」改成「按游标增量读」之后，恢复那一轮正是
    // 靠「游标归零 + 同一条 fold」达成一致，所以字面同函数比「两处都调 summarizeCurrent」
    // 更能锁住这条不变量。
    expect(blockAfter(jsonl, "public async open("), "启动期恢复走同一条 fold 判据").toContain(
      "this.foldText(",
    );
    expect(blockAfter(jsonl, "private async readBack("), "周期回读走同一条 fold 判据").toContain(
      "this.consumeFromCursor(",
    );
    expect(jsonl, "foldText 是唯一做窗口键比较的地方").toMatch(
      /private foldText\(text: string\): void \{[\s\S]*windowKey\(entry\.ts, window, resetHour\) !== key[\s\S]*?this\.authoritative\.set/,
    );
  });
});
