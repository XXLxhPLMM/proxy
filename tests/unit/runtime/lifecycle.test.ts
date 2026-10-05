/**
 * `createProxyRuntime`：**启停与生命周期**（启停幂等与派生事件的唯一来源 / 启动失败只上报 /
 * 服务注入优先于缺省装配 / 观察者抛错不穿透 / 每轮 `start` 重建、每轮 `stop` 释放订阅）。
 * 构造期→`create`、live store 与热改→`context`、启动 URL 与 configDir→`upstream-url`、
 * `assembly` 优先级链→`assembly`、桥接那一半→`bridge/lifecycle`。
 * ⚠️ 主题级不变量（生命周期事件唯一来源与派生顺序、订阅组归属、账本目录纪律）在 `./AGENTS.md`。
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "@/core/events/index.js";
import type { IdentityProvider, PipeEvent } from "@/core/types/proxy.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { RuntimeWarning } from "@/runtime/index.js";
import { getFreePort } from "../../helpers/net.js";
import { own, stopOwnedRuntimes } from "./_proxy-runtime.js";

// 库模式不经 `loadConfig`，setup-env 钉的 `QUOTA_USAGE_DIR` 与 `set("quotaUsageDir", …)`
// 两侧都落空（内联 config 走 `new ConfigStore(内联)`）；而 `configDir` 缺省是 `process.cwd()`、
// `quotaUsageDir` 的 FIELDS 缺省是相对路径 `cfg/usage` —— `start()` 里的账本 `open()` 照建。
const LEDGER_DIR = path.join(os.tmpdir(), "proxy-runtime-lifecycle-usage");

async function listen(server: net.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await stopOwnedRuntimes();
  vi.restoreAllMocks();
});

describe("runtime/createProxyRuntime：启停幂等、派生事件与订阅归属", () => {
  it("start/stop 幂等，停止释放端口与事件订阅，并发布生命周期事实", async () => {
    const port = await getFreePort();
    const events = new EventHub();
    const names: string[] = [];
    const subscriptions = [
      events.subscribe("runtime.starting", () => names.push("runtime.starting")),
      events.subscribe("runtime.started", () => names.push("runtime.started")),
      events.subscribe("runtime.stopping", () => names.push("runtime.stopping")),
      events.subscribe("runtime.stopped", () => names.push("runtime.stopped")),
      events.subscribe("lifecycle.changed", (event) => {
        names.push(`lifecycle:${event.data.next}`);
      }),
    ];
    expect(subscriptions).toHaveLength(5);

    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port, quotaUsageDir: LEDGER_DIR },
        events,
      }),
    );
    const proxy = runtime.getProxy();

    await runtime.start();
    await runtime.start();
    expect(runtime.isRunning()).toBe(true);
    expect(runtime.getStats().running).toBe(true);

    const client = net.connect({ host: "127.0.0.1", port });
    client.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });

    await runtime.stop();
    client.destroy();
    await runtime.stop();

    expect(runtime.isRunning()).toBe(false);
    expect(runtime.getStats().running).toBe(false);
    expect(runtime.getProxy()).toBe(proxy);
    // 外部 EventHub 归调用方所有；runtime.stop 不得清掉宿主订阅。
    // 这条断言同时锁住「runtime 自己在 start 轮次里加的 `lifecycle.changed`
    // 订阅已随 stop 释放」——否则这里会是 6（5 宿主 + 1 残留）。
    expect(events.listenerCount()).toBe(5);
    // `lifecycle.changed` 由 core 直接发布（唯一来源），runtime 只派生 `runtime.*`：
    // 每个跃迁恰好一条，且**先于**它派生出的 `runtime.*`（core 是发布方，runtime 是观察方）。
    expect(names).toEqual([
      "lifecycle:starting",
      "runtime.starting",
      "lifecycle:running",
      "runtime.started",
      "lifecycle:stopping",
      "runtime.stopping",
      "lifecycle:stopped",
      "runtime.stopped",
    ]);
    // 计数护栏：4 次跃迁 → 4 条 lifecycle.changed + 4 条 runtime.*，没有重复发布。
    expect(names.filter((name) => name === "lifecycle:starting")).toHaveLength(1);
    expect(names.filter((name) => name.startsWith("lifecycle:"))).toHaveLength(4);
    expect(names.filter((name) => name.startsWith("runtime."))).toHaveLength(4);

    // stop 之后 runtime 的订阅已摘：再人为发一条 `lifecycle.changed` 不得派生任何 `runtime.*`
    // （宿主自己的 `lifecycle.changed` 订阅照旧收得到，故只断言 `runtime.*` 这一侧归零）。
    events.publish("lifecycle.changed", { next: "starting", prev: "stopped" });
    expect(names.filter((name) => name.startsWith("runtime."))).toHaveLength(4);

    const probe = net.createServer();
    await listen(probe, port);
    await close(probe);
  });

  it("启动失败通过 runtime.error 与 onWarning 上报，不退出宿主进程", async () => {
    const port = await getFreePort();
    const blocker = net.createServer();
    await listen(blocker, port);
    const warning = vi.fn<(w: RuntimeWarning) => void>();
    const events = new EventHub();
    const errors: unknown[] = [];
    const changed = vi.fn();
    events.subscribe("runtime.error", (event) => errors.push(event.data.error));
    events.subscribe("config.changed", ({ data }) => changed(data.keys));
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port },
        // ⚠️ **必须显式给 `configDir`**。这条走的是纯内存模式（`options.config` + 无 `context`），
        // 而那条路**根本不调 `loadConfig`** —— 于是 `setup-env.ts` 把 `AUTH_USERS_FILE` 指到临时
        // 文件这件事被完全忽略，`configDir` 回落到 `process.cwd()`，账号表缺省成
        // `<仓库根>/cfg/users.json`。
        //
        // 后果不是「读错了文件」这么轻：**`start()` 的启动期告警会读那份真表**，于是本地
        // `cfg/users.json`（`.gitignore` 掉的开发者状态）里只要有一个账号配了非 0 配额，
        // 本条就会多收一条 `quota-inert`，而 `toHaveBeenCalledOnce()` 直接红。实测踩中过：
        // 有人往真表里加了个 `quota-demo`（10 GiB/day），整档就红了，而真因离报错信息十万八千里。
        //
        // 这与「`pnpm test` 在别人机器上也红」是同一件事：**断言依赖了未跟踪的本地状态**。
        configDir: fs.mkdtempSync(path.join(os.tmpdir(), "rt-configdir-")),
        events,
        onWarning: warning,
      }),
    );

    try {
      await expect(runtime.start()).rejects.toThrow();
      expect(warning).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith({
        code: "start-failed",
        message: expect.any(String),
      });
      expect(errors).toHaveLength(1);

      // 启动失败不能提前清理订阅，随后仍应收到 live store 的热改事件。
      runtime.context.store.set("authLogging", false);
      expect(changed).toHaveBeenCalledWith(["authLogging"]);
    } finally {
      await runtime.stop();
      await close(blocker);
    }
  });

  it("服务注入优先于默认 identity 装配（原样透传到 core）", () => {
    const identity: IdentityProvider = {
      kind: "stub",
      isEnabled: true,
      isOwnCredential: () => false,
      identify: async () => ({ passed: true, username: "injected" }),
    };
    const runtime = own(createProxyRuntime({ services: { identity } }));

    expect(runtime.services.identity).toBe(identity);
    expect(runtime.options.identity).toBe(identity);
  });

  it("服务注入优先于默认 access 装配（原样透传到 core）", () => {
    // 访问控制端口与身份服务同构：显式注入的替身**原样生效**，`services.ts:buildDefaultServices`
    // 里的 `?? createFileAccessControl(ctx.config)` 因此永不触发（装配期缺省解析只做一次）。
    const access = {
      checkClient: () => ({ allowed: true }),
      checkTarget: () => ({ allowed: true }),
      checkRoute: () => ({ direct: false }),
    };
    const runtime = own(createProxyRuntime({ services: { access } }));

    expect(runtime.services.access).toBe(access);
    expect(runtime.options.access).toBe(access);
  });

  it("事件 listener 抛错不会穿透 runtime 生命周期", async () => {
    const port = await getFreePort();
    const events = new EventHub({ onListenerError: () => undefined });
    events.subscribe("runtime.starting", () => {
      throw new Error("observer failed");
    });
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port, quotaUsageDir: LEDGER_DIR },
        events,
      }),
    );

    await expect(runtime.start()).resolves.toBeUndefined();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it("start→stop→start 重建 bridge/store 订阅，外部 hub 订阅跨 stop 保留", async () => {
    const port = await getFreePort();
    const events = new EventHub({ onListenerError: () => undefined });
    const hostStarted: string[] = [];
    const hostSubscription = events.subscribe("runtime.started", (event) => {
      hostStarted.push(event.context.runtimeId);
    });
    const loaded = vi.fn();
    const changed = vi.fn();
    const restartRequired = vi.fn();
    events.subscribe("config.loaded", ({ data }) => loaded(data.source));
    events.subscribe("config.changed", ({ data }) => changed(data.keys));
    events.subscribe("config.restart-required", ({ data }) => restartRequired(data.keys));
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port, quotaUsageDir: LEDGER_DIR },
        events,
      }),
    );
    // core 不经自带 EventEmitter 抛 `auth`/`pipe` 事实，直接发布到
    // `ctx.events`（本 runtime 的 events）。故「bridge 订阅随 start 建立、随 stop 解除」这条
    // 不变式由它**唯一还在桥接的 `pipe` 事实**验证：hub 上 `pipe` 的 listenerCount 即 core 订阅数。
    // `lifecycle.changed` 订阅同样进 start/stop 循环，故一起断言。
    // ⚠️ `lifecycle.changed` 上 runtime 自己的订阅是**两条**：① `runtime.*` 派生；②
    // `[lifecycle] state …` 落盘（`bindLifecycleLog`，随 `eventLogs` 缺省 `true` 一起装上）。
    // 本用例没传 `logger`，走的是 `createNoopLogger()` 缺省档，**绑定照样装** ——
    // 「logger 是 noop」关的是 IO，不是订阅。这条断言因此同时证明两条订阅都被 start 建立、
    // 被 stop 摘掉、幂等 start 不叠加。
    const ipDenied: PipeEvent = {
      type: "ip-denied",
      client: "10.0.0.9",
      reason: "blacklist",
      protocol: "http",
    };
    const denied: string[] = [];
    const startedStates: string[] = [];
    events.subscribe("lifecycle.changed", ({ data }) => startedStates.push(data.next));
    // 宿主自己那条 `lifecycle.changed` 订阅是基线；runtime 的订阅必须是「基线 + 2」。
    const lifecycleBase = events.listenerCount("lifecycle.changed");
    const RUNTIME_LIFECYCLE_SUBSCRIPTIONS = 2;

    expect(events.listenerCount("pipe")).toBe(0);
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase);
    await runtime.start();
    await runtime.start();
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase + RUNTIME_LIFECYCLE_SUBSCRIPTIONS);
    expect(loaded).toHaveBeenCalledTimes(2);
    events.publish("pipe", ipDenied, { protocol: "http" });
    events.subscribe("access.client-denied", ({ data }) => denied.push(data.client));
    events.publish("pipe", ipDenied, { protocol: "http" });
    expect(denied).toEqual(["10.0.0.9"]);

    runtime.context.store.set("authEnabled", true);
    runtime.context.store.set("port", port + 1);
    expect(changed).toHaveBeenCalledWith(["authEnabled"]);
    expect(restartRequired).toHaveBeenCalledWith(["port"]);
    await runtime.stop();

    expect(events.listenerCount("pipe")).toBe(0);
    // 生命周期订阅随 stop 释放（否则就是停机后监听残留）
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase);
    expect(hostSubscription.disposed).toBe(false);
    const countAfterStop = events.listenerCount();
    runtime.context.store.set("authLogging", false);
    expect(changed).toHaveBeenCalledTimes(1);

    await runtime.start();
    expect(events.listenerCount("pipe")).toBeGreaterThan(0);
    // 重新 start 后这条订阅必须恢复（否则 runtime.started 之类的派生事实会静默断供）
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase + RUNTIME_LIFECYCLE_SUBSCRIPTIONS);
    events.publish("pipe", ipDenied, { protocol: "http" });
    expect(denied).toEqual(["10.0.0.9", "10.0.0.9"]);
    runtime.context.store.set("authLogging", true);
    expect(changed).toHaveBeenCalledWith(["authLogging"]);
    await runtime.stop();

    expect(events.listenerCount()).toBe(countAfterStop);
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase);
    expect(hostStarted).toHaveLength(2);
    // 两轮 start→stop：每轮恰好 4 条跃迁（幂等的第二次 start 不发），共 8 条、无重复。
    expect(startedStates).toEqual([
      "starting",
      "running",
      "stopping",
      "stopped",
      "starting",
      "running",
      "stopping",
      "stopped",
    ]);
  });

  it("stop-before-start 后首次 start 仍恢复 bridge、lifecycle 与 store 事件订阅", async () => {
    const port = await getFreePort();
    const events = new EventHub({ onListenerError: () => undefined });
    const changed = vi.fn();
    events.subscribe("config.changed", ({ data }) => changed(data.keys));
    const startedStates: string[] = [];
    events.subscribe("lifecycle.changed", ({ data }) => startedStates.push(data.next));
    // 同上：runtime 自己两条（`runtime.*` 派生 + `[lifecycle] state …` 落盘），见上一条用例的注释
    const lifecycleBase = events.listenerCount("lifecycle.changed");
    const RUNTIME_LIFECYCLE_SUBSCRIPTIONS = 2;
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port, quotaUsageDir: LEDGER_DIR },
        events,
      }),
    );

    await runtime.stop();
    expect(events.listenerCount("pipe")).toBe(0);
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase);
    await runtime.start();
    expect(events.listenerCount("pipe")).toBeGreaterThan(0);
    // stop-before-start 之后这条订阅也必须恢复
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase + RUNTIME_LIFECYCLE_SUBSCRIPTIONS);
    runtime.context.store.set("authLogging", false);
    expect(changed).toHaveBeenCalledWith(["authLogging"]);
    expect(startedStates).toEqual(["starting", "running"]);
    await runtime.stop();
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase);
  });
});