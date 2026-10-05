/**
 * `bindProxyEventLogs` 的**行为面**五档：纯库路径真落盘 / `context` 模式 / `eventLogs: false` /
 * `start → stop → start` 不叠加 / 退订幂等。
 *
 * @module tests/integration/logging
 *
 * 主题级不变量（两族同层、三条装配裁决、零落盘与行序纪律、防假绿的位置）见 `./AGENTS.md`；
 * 共用的临时目录 / 账号表 / 真 logger / 往返采集见 `./event-binding-fixture.ts`。
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { ConfigStore, createConfigContext } from "@/config/index.js";
import { EventHub } from "@/core/events/index.js";
import { bindProxyEventLogs } from "@/runtime/event-log.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import type { Logger } from "@/utils/logger/index.js";
import {
  ALICE_PW,
  TARGET_IP,
  basic,
  baseConfig,
  dir,
  driveTraffic,
  libraryLogger,
  logDir,
  originPort,
  port,
  rawRequest,
  readRecords,
} from "./event-binding-fixture.js";

describe("logging · event-binding-runtime", () => {
  describe("① 纯库路径真落盘（config 模式）", () => {
    it("createProxyRuntime({ config, configDir }) 跑一次真请求 → JSONL 真存在且含 [forward] / [auth] deny / [route]", async () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = libraryLogger();
      // ⚠️ 全程**不经过 `ProxyServer`**：本档验的正是纯库路径自己就能落盘
      const runtime: ProxyRuntime = createProxyRuntime({
        config: baseConfig(),
        configDir: dir,
        events,
        logger,
      });

      await runtime.start();
      try {
        await driveTraffic(port);
      } finally {
        await runtime.stop();
      }

      // ① 文件真实存在
      const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl")) : [];
      expect(files.length, "落盘目录里必须有按小时的 .jsonl").toBeGreaterThanOrEqual(1);

      const lines = await readRecords(logger);

      // ② `[forward]` info 行：带身份维度（user/client/target/kind/method）
      const forward = lines.find((l) => l.msg === "[forward]");
      expect(forward, "必须有 [forward] 行").toBeTruthy();
      expect(forward?.level).toBe("info");
      expect(forward?.prefix).toBe("[proxy]");
      expect(forward?.user).toBe("alice");
      expect(forward?.client).toBe(TARGET_IP);
      expect(forward?.kind).toBe("http");
      expect(forward?.method).toBe("GET");
      expect(String(forward?.target)).toContain(String(originPort));

      // ③ `[auth] deny` info 行：带 attempted / reason
      const deny = lines.find((l) => l.msg === "[auth] deny");
      expect(deny, "必须有 [auth] deny 行").toBeTruthy();
      expect(deny?.level).toBe("info");
      expect(deny?.attempted).toBe("mallory");
      expect(deny?.client).toBe(TARGET_IP);

      // ④ `[route]` info 行：与 route 事件 1:1（target/route/reason 是 jq 契约）
      const route = lines.find((l) => l.msg === "[route]");
      expect(route, "必须有 [route] 行").toBeTruthy();
      expect(route?.level).toBe("info");
      expect(route?.route).toBe("direct");
      expect(route?.reason).toBe("blacklist");
      expect(String(route?.target)).toBe(`${TARGET_IP}:${originPort}`);

      // ⑤ `[{kind}] headers` debug 行也在（fileLevel=debug 才看得到）
      const dump = lines.find((l) => l.msg === "[http] headers");
      expect(dump, "必须有 [http] headers 行").toBeTruthy();
      expect(dump?.level).toBe("debug");
      expect(dump?.user).toBe("alice");
    });
  });

  describe("② 纯库路径（context 模式）同样落盘", () => {
    it("共享 live store 的 context 模式下落盘行逐字相同（绑定长在 runtime 上、不是长在某条装配路径上）", async () => {
      const store = new ConfigStore(baseConfig());
      const context = createConfigContext({ store, configDir: dir });
      const logger = libraryLogger();
      const runtime = createProxyRuntime({
        context,
        events: new EventHub({ onListenerError: () => undefined }),
        logger,
      });

      await runtime.start();
      try {
        await driveTraffic(port);
      } finally {
        await runtime.stop();
      }

      const lines = await readRecords(logger);
      expect(lines.find((l) => l.msg === "[forward]")?.user).toBe("alice");
      expect(lines.find((l) => l.msg === "[auth] deny")?.attempted).toBe("mallory");
      expect(lines.find((l) => l.msg === "[route]")?.route).toBe("direct");
    });
  });

  describe("③ eventLogs: false —— 关掉的只是「事件 → 这一个 logger」这一跳", () => {
    it("显式 false：零落盘行，但公共事件面一条不少", async () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const seen: string[] = [];
      // 宿主自己接事件桥（这正是 `eventLogs: false` 的正当场景）
      for (const name of ["request.started", "auth.decided", "route.selected"] as const) {
        events.subscribe(name, () => {
          seen.push(name);
        });
      }
      const logger = libraryLogger();
      const runtime = createProxyRuntime({
        config: baseConfig(),
        configDir: dir,
        events,
        logger,
        eventLogs: false,
      });

      await runtime.start();
      try {
        await driveTraffic(port);
      } finally {
        await runtime.stop();
      }

      const lines = await readRecords(logger);
      // ⚠️ 零落盘行：logger 一行都没写（不只是「没有代理事件那几行」）
      expect(lines, `不该有任何落盘行，实际：${JSON.stringify(lines.map((l) => l.msg))}`).toEqual([]);
      // 目录压根没被建出来（落盘 IO 在 logger 那一侧，它一次都没被叫到）
      expect(fs.existsSync(logDir) ? fs.readdirSync(logDir).length : 0).toBe(0);
      // 但事件面照常：宿主自己拿得到三条事实
      expect(seen).toContain("request.started");
      expect(seen).toContain("auth.decided");
      expect(seen).toContain("route.selected");
    });
  });

  describe("④ start → stop → start 落盘行数不翻倍（防订阅叠加）", () => {
    it("两轮各一个请求：[forward] 恰好 2 条，且 start 之后 request.started 恰好 1 个订阅者", async () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = libraryLogger();
      const runtime = createProxyRuntime({
        config: baseConfig(),
        configDir: dir,
        events,
        logger,
      });

      // 停机后订阅必须全部退掉（否则下一轮 start 会叠加）
      expect(events.listenerCount("request.started")).toBe(0);

      await runtime.start();
      try {
        // 一个订阅者就是事件落盘绑定本身（bridge 订阅的是 pipe、lifecycle 订阅的是 lifecycle.changed）
        expect(events.listenerCount("request.started")).toBe(1);
        const r = await rawRequest(
          port,
          `GET http://${TARGET_IP}:${originPort}/r1 HTTP/1.1`,
          [`Host: ${TARGET_IP}:${originPort}`, `Proxy-Authorization: ${basic("alice", ALICE_PW)}`],
        );
        expect(r.status.startsWith("HTTP/1.1 200")).toBe(true);
      } finally {
        await runtime.stop();
      }
      expect(events.listenerCount("request.started")).toBe(0);

      await runtime.start();
      try {
        expect(events.listenerCount("request.started")).toBe(1);
        const r = await rawRequest(
          port,
          `GET http://${TARGET_IP}:${originPort}/r2 HTTP/1.1`,
          [`Host: ${TARGET_IP}:${originPort}`, `Proxy-Authorization: ${basic("alice", ALICE_PW)}`],
        );
        expect(r.status.startsWith("HTTP/1.1 200")).toBe(true);
      } finally {
        await runtime.stop();
      }
      expect(events.listenerCount("request.started")).toBe(0);

      const lines = await readRecords(logger);
      const forwards = lines.filter((l) => l.msg === "[forward]");
      // 叠加的话这里会是 3 条（第 2 轮的请求被落两遍）
      expect(forwards).toHaveLength(2);
      expect(forwards.every((l) => l.user === "alice")).toBe(true);
    });
  });

  describe("⑤ 退订函数幂等", () => {
    it("调两次不炸、第二次是空转；且只摘自己挂的订阅（宿主自己的订阅必须原样存活）", () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;

      // 宿主自己的一条订阅（模拟「库调用方把自己的遥测挂在同一条总线上」）
      const hostCalls: string[] = [];
      const hostSub = events.subscribe("runtime.started", () => {
        hostCalls.push("started");
      });

      const release = bindProxyEventLogs(events, logger);
      // 正向证据：绑定确实落了 11 类订阅（不数具体条数，只要求「远大于 0」且退订后归零）
      expect(events.listenerCount()).toBeGreaterThan(1);

      release();
      // 只剩宿主那一条
      expect(events.listenerCount(), "退订后必须只剩宿主自己那一条").toBe(1);
      // ⚠️ **不许图省事改用 `hub.removeAll()`**：总线可能属于宿主，连带清掉别人的订阅就是越权
      events.publish("runtime.started", { host: "127.0.0.1", port: 1, protocol: "http" });
      expect(hostCalls, "宿主自己的订阅必须仍生效").toEqual(["started"]);

      // 第二次必须是空转：既不抛，也不改变任何状态
      expect(() => release()).not.toThrow();
      expect(() => release()).not.toThrow();
      expect(events.listenerCount()).toBe(1);

      // 退订之后再发事件：一个字段都不许落到 logger 上
      logger.debug.mockClear();
      logger.info.mockClear();
      logger.warn.mockClear();
      logger.error.mockClear();
      events.publish("request.started", { kind: "http" }, { client: "client-a" });
      events.publish("server.listening", { host: "127.0.0.1", port: 1 }, { runtimeId: events.runtimeId, protocol: "http" });
      expect(logger.debug).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();

      // 「退订干净」而不是「把总线搞坏」的正向证据：重新绑一次仍然能收，宿主那条也还在
      const release2 = bindProxyEventLogs(events, logger);
      expect(events.listenerCount()).toBeGreaterThan(1);
      events.publish("server.listening", { host: "127.0.0.1", port: 1 }, { runtimeId: events.runtimeId, protocol: "http" });
      expect(logger.debug).toHaveBeenCalledTimes(1);
      release2();
      expect(events.listenerCount()).toBe(1);
      hostSub.dispose();
    });
  });
});
