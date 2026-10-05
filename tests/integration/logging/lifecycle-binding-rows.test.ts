/**
 * `[lifecycle] state …` 那一族的**落盘行文本**四档：① 文本 / 等级 / 字段逐字（含退订幂等）、
 * ③ CLI 与库逐字段相等、④ `start → stop → start` 不叠加、⑤ `isWorker: true` → 零行。
 *
 * @module tests/integration/logging
 *
 * 主题级不变量（两族同层、三条装配裁决、零落盘与行序纪律、防假绿的位置）见 `./AGENTS.md`；
 * 共用的临时目录 / 真 logger / 跃迁逐字契约见 `./lifecycle-fixture.ts`。
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { ConfigStore, createConfigContext } from "@/config/index.js";
import { EventHub } from "@/core/events/index.js";
import { bindLifecycleLog } from "@/runtime/event-log.js";
import { createProxyRuntime } from "@/runtime/index.js";
import { ProxyServer } from "@/server/index.js";
import type { Logger } from "@/utils/logger/index.js";
import {
  TRANSITIONS,
  TRANSITIONS_ROUND2,
  baseConfig,
  dir,
  libraryLogger,
  lifecycleLines,
  logDir,
  readRecords,
} from "./lifecycle-fixture.js";

describe("logging · lifecycle-binding-rows", () => {
  describe("① 文本 / 等级 / 字段逐字（这一行搬走之后一个字都不许变）", () => {
    it("恰好一次 debug、msg 逐字、末位不是 plain object（无结构化字段）", () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;

      const release = bindLifecycleLog(events, logger, "http");
      events.publish("lifecycle.changed", { next: "starting", prev: "idle" });

      // 恰好一次、恰好 debug（不是 info/warn/error）
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      // 文本逐字
      expect(logger.debug.mock.calls[0]![0]).toBe("[lifecycle] state idle -> starting protocol=http");
      // 末位不是 plain object ⇒ 这一行**无结构化字段**（三条身份维度一个都不带）
      expect(logger.debug.mock.calls[0]).toHaveLength(1);
      // info / warn / error 档一条都不许有
      expect(logger.debug.mock.calls[0]![0]).not.toMatch(/\[(proxy|config|shutdown)\]/);

      // 退订后一个字都不许再落
      release();
      logger.debug.mockClear();
      events.publish("lifecycle.changed", { next: "running", prev: "starting" });
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it("退订函数幂等：调两次不炸、第二次是空转，且只摘自己那一条订阅", () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
      // 宿主自己的一条订阅（模拟「库调用方把自己的遥测挂在同一条总线上」）
      const hostCalls: string[] = [];
      const hostSub = events.subscribe("lifecycle.changed", () => {
        hostCalls.push("host");
      });

      const release = bindLifecycleLog(events, logger, "socks5");
      expect(events.listenerCount("lifecycle.changed")).toBe(2);
      release();
      // ⚠️ **不许图省事改用 `hub.removeAll()`**：总线可能属于宿主，连带清掉别人的订阅就是越权
      expect(events.listenerCount("lifecycle.changed")).toBe(1);
      events.publish("lifecycle.changed", { next: "starting", prev: "idle" });
      expect(hostCalls, "宿主自己的订阅必须仍生效").toEqual(["host"]);

      // 幂等：两次都不炸、不改状态
      expect(() => release()).not.toThrow();
      expect(() => release()).not.toThrow();
      expect(events.listenerCount("lifecycle.changed")).toBe(1);
      hostSub.dispose();
    });
  });

  describe("③ CLI 与库逐字段相等（同一份绑定，不是「一条多一条少」）", () => {
    it("同一份 start/stop：真 ProxyServer 侧与纯库 runtime 侧的 [lifecycle] 行 toEqual", async () => {
      // —— 库路径 ——
      const libLogger = libraryLogger();
      const libRuntime = createProxyRuntime({
        config: baseConfig(),
        configDir: dir,
        events: new EventHub({ onListenerError: () => undefined }),
        logger: libLogger,
      });
      await libRuntime.start();
      await libRuntime.stop();
      const libLines = lifecycleLines(await readRecords(libLogger));

      // —— CLI 路径（真 ProxyServer；worker=false 以便真落盘）——
      fs.rmSync(logDir, { recursive: true, force: true });
      const store = new ConfigStore(baseConfig());
      const cliLogger = libraryLogger();
      const server = new ProxyServer({
        context: createConfigContext({ store, configDir: dir }),
        logger: cliLogger,
        noColor: true,
        isWorker: false,
      });
      await server.start();
      await server.stop(3000);
      const cliLines = lifecycleLines(await readRecords(cliLogger));

      // 两侧都真的落了东西（**防「两边都空 → 逐字相等」这种假绿**）
      expect(libLines).toHaveLength(4);
      expect(cliLines).toHaveLength(4);
      // 逐字段相等
      expect(cliLines).toEqual(libLines);
      // 文本逐字（顺带钉住 CLI 那一行一个字没变）
      expect(cliLines.map((l) => l.msg).slice().sort()).toEqual(TRANSITIONS.slice().sort());
    });
  });

  describe("④ start → stop → start 不叠加（防订阅叠加）", () => {
    it("两轮各 4 行（共 8），lifecycle.changed 的 listenerCount 轮次 0→2→0→2→0", async () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = libraryLogger();
      const runtime = createProxyRuntime({ config: baseConfig(), configDir: dir, events, logger });

      // 停机后订阅必须全部退掉（否则下一轮 start 会叠加）
      expect(events.listenerCount("lifecycle.changed")).toBe(0);

      await runtime.start();
      // **2** = runtime 自己的 `runtime.*` 派生订阅 + 本落盘绑定。叠加的话这里是 3。
      expect(events.listenerCount("lifecycle.changed")).toBe(2);
      await runtime.stop();
      expect(events.listenerCount("lifecycle.changed")).toBe(0);

      await runtime.start();
      expect(events.listenerCount("lifecycle.changed")).toBe(2);
      await runtime.stop();
      expect(events.listenerCount("lifecycle.changed")).toBe(0);

      const mine = (await readRecords(logger)).filter((l) => String(l.msg).startsWith("[lifecycle]"));
      // 叠加的话这里是 12（第 2 轮的四次跃迁被落两遍）
      expect(mine).toHaveLength(8);
      // 逐条数次数（**多重集合**口径，理由见 `./AGENTS.md`「零落盘纪律」的 JSONL 行序一条）：
      // 两轮**各四条**。`starting->running` / `running->stopping` / `stopping->stopped`
      // 各 2 次；`idle->starting` 与 `stopped->starting` 各 1 次 —— 后者正是「第二轮从
      // `stopped` 重入、且 `prev` 取自信封而不是自己记一份状态」的直接证据。
      const counts = new Map<string, number>();
      for (const l of mine) {
        counts.set(String(l.msg), (counts.get(String(l.msg)) ?? 0) + 1);
      }
      expect(Object.fromEntries(counts)).toEqual({
        [TRANSITIONS[0]!]: 1,
        [TRANSITIONS_ROUND2[0]!]: 1,
        [TRANSITIONS[1]!]: 2,
        [TRANSITIONS[2]!]: 2,
        [TRANSITIONS[3]!]: 2,
      });
    });
  });

  describe("⑤ isWorker: true → 零行（那一族是 cluster master 独有的）", () => {
    it("零 [lifecycle] 行，但其余代理事件照旧落盘（证明关掉的只是这一族）", async () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = libraryLogger();
      const runtime = createProxyRuntime({
        config: baseConfig(),
        configDir: dir,
        events,
        logger,
        isWorker: true,
      });

      await runtime.start();
      // 运行期订阅数 = 1：**只剩 runtime 自己派生 `runtime.*` 那条**，落盘绑定**没有**装上。
      // （stop 之后两条都被释放、回到 0，所以这条必须**在 stop 之前**取样。）
      expect(events.listenerCount("lifecycle.changed")).toBe(1);
      await runtime.stop();
      expect(events.listenerCount("lifecycle.changed")).toBe(0);

      const lines = await readRecords(logger);
      expect(lines.filter((l) => String(l.msg).startsWith("[lifecycle]")), "worker 档必须零行").toEqual([]);
      // 正向对照：落盘面**整体**仍然在（`server.listening` 是 `bindProxyEventLogs` 那族，不看 isWorker）
      expect(lines.some((l) => String(l.msg).startsWith("listening on ")), "其余代理事件照旧落盘").toBe(true);
    });

    it("ProxyServer 真的把它判出来的 isWorker 传下去了（否则这一档在库路径测了也白测）", async () => {
      const store = new ConfigStore(baseConfig());
      const logger = libraryLogger();
      const server = new ProxyServer({
        context: createConfigContext({ store, configDir: dir }),
        logger,
        noColor: true,
        isWorker: true,
      });
      await server.start();
      await server.stop(3000);

      const lines = await readRecords(logger);
      expect(lines.filter((l) => String(l.msg).startsWith("[lifecycle]")), "worker 档必须零行").toEqual([]);
      expect(lines.some((l) => String(l.msg).startsWith("listening on "))).toBe(true);
    });
  });
});
