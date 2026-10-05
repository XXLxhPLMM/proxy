/**
 * 账本写盘失败那一侧：一条 `usage.write-error` 事件、一条 CLI `[usage-write-error]` error 行，
 * 以及「停机落盘发生在与 `logger.flush()` 同一位置」这条接线事实。
 *
 * @description
 * 「造磁盘故障在 Windows CI 上不可复现，故 CLI 那条改成手工 publish」与「恢复读取的窗口口径必须与
 * 判定侧共用同一个 `resetHour` 闭包」归 `./AGENTS.md`；装配面见 `./ledger-fixture.js`。
 *
 * @module tests/integration/quota
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createConfigContext } from "@/config/index.js";
import { EventHub } from "@/core/events/index.js";
import type { EventEnvelope } from "@/core/events/index.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import { ProxyServer } from "@/server/index.js";
import { LoggerImpl } from "@/utils/logger/index.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import { getFreePort } from "../../helpers/net.js";
import {
  ALICE,
  dir,
  ledgerBytes,
  ledgerDir,
  ledgerFile,
  ledgerUsers,
  originPort,
  proxyRequest,
  startRuntime,
  store,
  subscriptions,
} from "./ledger-fixture.js";

describe("quota/ledger-write-error（写盘失败 → 事件 + CLI error 行）", () => {
  it("账本目录不可用 → 一条 usage.write-error，且 start() 不抛、判定不受影响", async () => {
    const events = new EventHub({ onListenerError: () => undefined });
    const seen: Array<EventEnvelope<"usage.write-error">> = [];
    subscriptions.push(events.subscribe("usage.write-error", (e) => seen.push(e)));

    const runtime = await startRuntime(events);
    expect(runtime.services.usageSource?.enabled).toBe(true);
    // 先干净地停一轮（`open()` 幂等：已启用时直接返回，所以必须先关）
    await runtime.stop();
    expect(runtime.services.usageSource?.enabled).toBe(false);
    // 让「下一次 open 拿不到目录」：把目录换成一个**同名普通文件**
    fs.rmSync(ledgerDir, { recursive: true, force: true });
    fs.writeFileSync(ledgerDir, "not a directory", "utf8");
    seen.length = 0;

    // start() 遇到不可用的账本目录：**不抛**，代理照常起
    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.services.usageSource?.enabled).toBe(false);
    // 一条可见事实（否则运维完全不知道「配额账本从这一刻起不落盘了」）
    expect(seen).toHaveLength(1);
    expect(seen[0].data.path).toBe(ledgerFile());
    // 判定完全不受影响：真实请求仍成功（配额远未耗尽）
    const r = await proxyRequest(store.get("port"), originPort, {
      method: "POST",
      body: Buffer.alloc(64, 0x49),
    });
    expect(r.status).toBe(200);
    expect(runtime.services.traffic.usage(ALICE)).toBeGreaterThan(0);
    await runtime.stop();
  });

  it("CLI 侧把 usage.write-error 落成一条 [usage-write-error] error 行", async () => {
    // 直接验事件 → 日志的**绑定**（不靠真的造磁盘故障，那在 Windows CI 上不可复现）：
    // 手工 publish 一次，断言 server 层的订阅把它落成了什么等级、什么文本。
    const context = createConfigContext({ store, configDir: dir });
    const records: Array<{ level: string; args: unknown[] }> = [];
    const logger = new LoggerImpl({ level: "silent" });
    logger.error = (...args: unknown[]): void => {
      records.push({ level: "error", args });
    };
    const port = await getFreePort();
    store.set("port", port);
    const server = new ProxyServer({ context, logger, noColor: true });
    await server.start();
    try {
      const hub = (server as unknown as { runtime: ProxyRuntime | null }).runtime;
      expect(hub).toBeDefined();
      hub?.events.publish("usage.write-error", {
        path: ledgerFile(),
        error: new Error("ENOSPC: no space left on device"),
      });
      // 事件总线是同步分发，故断言不需要 await
      const line = records.find((r) => String(r.args[0]).includes("[usage-write-error]"));
      expect(line, "必须落一条 [usage-write-error]").toBeDefined();
      expect(line?.level).toBe("error");
      const text = line?.args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ") ?? "";
      expect(text).toContain(ledgerFile());
      // 文案必须写明「服务没停」与「不要重启」——这是运维看到 error 后的正确处置
      expect(text).toContain("内存计数继续");
      expect(text).toContain("不要为此重启");
    } finally {
      await server.stop(2000);
    }
  });

  it("ProxyServer.stop() 在与 logger.flush() 同一位置把账本落盘（读真实文件内容）", async () => {
    const context = createConfigContext({ store, configDir: dir });
    const port = await getFreePort();
    store.set("port", port);
    const server = new ProxyServer({
      context,
      logger: new LoggerImpl({ level: "silent" }),
      noColor: true,
    });
    await server.start();
    const r = await proxyRequest(port, originPort, { method: "POST", body: Buffer.alloc(256, 0x4a) });
    expect(r.status).toBe(200);
    // 停机前库里**一条都没有**（间隔 1 小时，全靠停机 flush；表在 `open()` 的建表步骤里
    // 就建出来了，故判据是字节合计而不是「表不存在」）
    expect(ledgerBytes()).toBe(0);
    await server.stop(3000);
    // 停机后：库里真的有那批字节（另开连接真读）
    expect(ledgerBytes()).toBeGreaterThan(256);
    expect(ledgerUsers()).toEqual([ALICE]);
  });
});

describe("quota/ledger-write-error（配置文件本身：不用于行为断言，只防「示例/文档漂移」）", () => {
  it("恢复读取的窗口口径与判定侧同一份（同一个 resetHour 闭包）", async () => {
    // 判定与恢复**必须**用同一个 resetHour：若恢复按 0 点、判定按 3 点，
    // 同一批字节会被算进两个窗口。改 `quotaResetHour` 立刻改变两者的边界。
    store.set("quotaResetHour", 3);
    const runtime = await startRuntime();
    expect(runtime.services.usageSource?.file.endsWith("usage.db")).toBe(true);
    await runtime.stop();

    // 直接往库里塞一条**过期窗口**的用量（窗口键写成 2026-02-15，在 resetHour=3 下
    // 那属于早已过去的窗口）。⚠️ **不能靠 `consume` 造**：账本只往「当前窗口」写，
    // 过期行要靠手写库才造得出来——而那正是恢复路径必须扛住的形状（真实世界里
    // 它由上一个窗口期产生）。
    const db = openSqliteDriver()(ledgerFile());
    try {
      db.run("INSERT INTO usage (u, w, v) VALUES (?, ?, ?)", [ALICE, "2026-02-15", 4096]);
    } finally {
      db.close();
    }

    const second = await startRuntime();
    // 墙钟远在 3/15 之后，故 2026-02-15 那条属于**已过期**窗口 → 不参与当前判定
    expect(second.services.traffic.usage(ALICE)).toBe(0);
    await second.stop();
    // 过期行在启动期被清理掉（一条 DELETE 顶掉旧形态的整套压缩）
    expect(ledgerBytes(), "过期窗口的行不参与恢复").toBe(0);
  });
});
