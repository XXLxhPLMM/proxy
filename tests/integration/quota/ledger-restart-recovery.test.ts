/**
 * 账本的**跨进程存活**那一半：停机落盘 → 再起恢复，且恢复出来的量立刻参与判定；两个 runtime 共用同一个库。
 *
 * @description
 * 槽位机制为什么整体删除（分槽把「账号级封禁」退化成「每进程一份封禁」）、落盘为什么必须由停机驱动，
 * 归 `./AGENTS.md`；装配面（自带全部钉值的 `ConfigStore` 与真源站）见 `./ledger-fixture.js`。
 *
 * @module tests/integration/quota
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { accountLocatorFor } from "@/config/index.js";
import { readAuthUsers } from "@/datasource/users/index.js";
import {
  ALICE,
  ALICE_PW,
  accessor,
  ledgerBytes,
  ledgerDir,
  ledgerFile,
  ledgerUsers,
  originPort,
  proxyRequest,
  startRuntime,
  store,
  usersPath,
  writeUsers,
} from "./ledger-fixture.js";

describe("quota/ledger-restart（端到端重启恢复：真代理 + 真字节）", () => {
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

describe("quota/ledger-restart（所有 runtime 共用同一个库：多进程共享）", () => {
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
