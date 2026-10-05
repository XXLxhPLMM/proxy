/**
 * `runtime/bridge.ts`：**边界、隔离与接线** —— 哪些 core 事实**不派生**公共事件
 * （`forward.error`/`server.error`/`server.client-error` 原样到达、10 个 `pipe` 变体一条派生都没有）、
 * 桥接是**旁路**（观察者抛错不打断 core 回调 / `dispose()` 幂等 / `attach` 只多挂一个观察者）、
 * runtime 的启停接线（bridge 只在 `start` 轮次建立，`stop()` 解绑但不清外部 hub）。
 * ⚠️ 「公共事件面全集」与「core 直发 vs bridge 桥接」的划界理由在 `./AGENTS.md`；
 * 载荷与 context 的逐字形状在 `deny-events` / `forward-events`。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "@/core/events/index.js";
import type { EventName } from "@/core/events/index.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { CoreEventBridge } from "@/runtime/bridge.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import { getFreePort } from "../../../helpers/net.js";
import { PROTOCOL, contextFor, newHub, recordAll } from "./_core-event-bridge.js";

/** `AppEventMap` 全集：用于断言「core 事实没有溢出成本波边界」。 */
const ALL_EVENT_NAMES: readonly EventName[] = [
  "runtime.starting",
  "runtime.started",
  "runtime.stopping",
  "runtime.stopped",
  "runtime.error",
  "runtime.dependencies-changed",
  "lifecycle.changed",
  "config.loaded",
  "config.changed",
  "config.restart-required",
  "config.file-error",
  "config.file-recovered",
  "config.file-reloaded",
  "auth.decided",
  "access.client-denied",
  "access.target-denied",
  "route.selected",
  "request.started",
  "request.completed",
  "request.rejected",
  "request.failed",
  "forward.error",
  "server.error",
  "server.client-error",
  "server.listening",
  "server.closed",
  "pipe",
];

/** 拆成「core 直发的事实」：它们进公共面，但不会被任何桥接映射再翻译一次。 */
const CORE_FACTS: ReadonlySet<EventName> = new Set<EventName>([
  "forward.error",
  "server.error",
  "server.client-error",
  "server.listening",
  "server.closed",
]);

// 库模式不经 `loadConfig`，setup-env 钉的 `QUOTA_USAGE_DIR` 与 `set("quotaUsageDir", …)`
// 两侧都落空（内联 config 走 `new ConfigStore(内联)`）；而 `configDir` 缺省是 `process.cwd()`、
// `quotaUsageDir` 的 FIELDS 缺省是相对路径 `cfg/usage` —— `start()` 里的账本 `open()` 照建。
const LEDGER_DIR = path.join(os.tmpdir(), "proxy-runtime-bridge-lifecycle-usage");

const activeRuntimes: ProxyRuntime[] = [];

afterEach(async () => {
  const runtimes = activeRuntimes.splice(0);
  for (const runtime of runtimes) {
    await runtime.stop().catch(() => undefined);
  }
});

describe("runtime/bridge 本波边界", () => {
  it("core 直发 forward.error / server.error / server.client-error，其余 pipe 变体一律不发公共事件", () => {
    // 保护：这三类低层错误事实由 core **直接**发布到公共面（它们本身不是请求级终态），
    // 但桥接器不得把它们再翻成 request.rejected/failed——那会造出第二条终态。
    // 错误类的请求级 rejected/failed 只由协议 guard 经终态 publisher 经 ErrorBoundary 发布。
    // `pipe` 的 10 个未映射变体则一条公共事件都不许有。
    const hub = newHub();
    // 刻意不订阅 `pipe` 本身：本用例断言的是「这 10 个变体在公共面上**一条派生事件都没有**」，
    // 它们自己是被发布的事实，不该混进「派生」计数里。
    const events = recordAll(hub, ALL_EVENT_NAMES.filter((name) => name !== "pipe"));
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(contextFor(hub));

    const forwardError = { kind: "http", error: new Error("boom") } as const;
    const serverError = { error: new Error("listen failed"), host: "127.0.0.1", port: 1080 };
    const clientError = { error: new Error("bad request") };

    hub.publish("forward.error", forwardError, { protocol: PROTOCOL });
    hub.publish("server.error", serverError, { protocol: PROTOCOL });
    hub.publish("server.client-error", clientError, { protocol: PROTOCOL });
    for (const event of [
      { type: "socks", message: "socks5 connect ok" },
      { type: "dial", target: "example.com:443" },
      { type: "established", target: "example.com:443" },
      { type: "upstream-error", target: "example.com:443", err: new Error("ECONNREFUSED") },
      { type: "upstream-timeout", target: "example.com:443" },
      { type: "upstream-refused", target: "example.com:443", statusLine: "HTTP/1.1 403" },
      { type: "loop-detected", target: "127.0.0.1:1080" },
      { type: "bad-request", message: "malformed" },
      { type: "client-error", err: new Error("reset") },
      { type: "debug", message: "trace" },
    ] satisfies PipeEvent[]) {
      hub.publish("pipe", event, { protocol: PROTOCOL });
    }

    // 三条 core 事实原样到达公共面（身份/载荷一字不加工）
    expect(events.map((event) => event.name)).toEqual([
      "forward.error",
      "server.error",
      "server.client-error",
    ]);
    expect(events[0].data).toEqual(forwardError);
    expect(events[1].data).toEqual(serverError);
    expect(events[2].data).toEqual(clientError);
    // 边界是「不派生」而不是「不观察」：这 10 个 pipe 变体与三类错误事实
    // 一条派生事件都不许有（尤其 request.rejected/failed —— 终态唯一来源是 RequestTerminal）
    expect(events.filter((event) => !CORE_FACTS.has(event.name))).toEqual([]);
  });
});

describe("runtime/bridge 隔离与清理", () => {
  it("公共事件观察者抛错不打断 core 事件回调，其它桥接事件照常发布", () => {
    // 保护：桥接是旁路。观察者异常绝不能顺着 core 的发布反向打断鉴权/转发主流程。
    const onListenerError = vi.fn();
    const hub = new EventHub({ runtimeId: "runtime-bridge", onListenerError });
    hub.subscribe("access.client-denied", () => {
      throw new Error("observer failed");
    });
    const routes: string[] = [];
    hub.subscribe("route.selected", (event) => {
      routes.push(event.data.route);
    });
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(contextFor(hub));

    expect(() =>
      hub.publish(
        "pipe",
        { type: "ip-denied", client: "10.0.0.9", reason: "blacklist" } satisfies PipeEvent,
      ),
    ).not.toThrow();
    expect(onListenerError).toHaveBeenCalledWith(expect.any(Error), "access.client-denied");
    expect(() =>
      hub.publish(
        "pipe",
        {
          type: "route",
          target: "example.com:80",
          mode: "client",
          route: "upstream",
        } satisfies PipeEvent,
      ),
    ).not.toThrow();
    expect(routes).toEqual(["upstream"]);
  });

  it("subscription.dispose() 幂等：解绑 pipe 订阅后不再发布，attach 也不再复活", () => {
    // 保护：runtime.stop() 之后既没有悬挂的 core 订阅，也没有「dispose 后又被 attach 挂回去」的漏洞。
    const hub = newHub();
    const events = recordAll(hub);
    const bridge = new CoreEventBridge({ hub, protocol: PROTOCOL });
    bridge.attach(contextFor(hub));

    expect(hub.listenerCount("pipe")).toBe(1);
    expect(bridge.subscription.disposed).toBe(false);

    hub.publish(
      "pipe",
      { type: "ip-denied", client: "10.0.0.9", reason: "blacklist" } satisfies PipeEvent,
    );
    expect(events).toHaveLength(1);

    bridge.subscription.dispose();
    expect(bridge.subscription.disposed).toBe(true);
    expect(hub.listenerCount("pipe")).toBe(0);

    hub.publish(
      "pipe",
      { type: "ip-denied", client: "10.0.0.9", reason: "blacklist" } satisfies PipeEvent,
    );
    expect(events).toHaveLength(1);

    expect(() => {
      bridge.attach(contextFor(hub));
      bridge.subscription.dispose();
    }).not.toThrow();
    expect(hub.listenerCount("pipe")).toBe(0);
    hub.publish(
      "pipe",
      { type: "ip-denied", client: "10.0.0.9", reason: "blacklist" } satisfies PipeEvent,
    );
    expect(events).toHaveLength(1);
  });

  it("attach 只多挂一个观察者：既有 listener 顺序与次数不变，publish 逐个送达", () => {
    // 保护：桥接只加观察者，不改事件投递语义（顺序、次数）——core 的发布行为与
    // 其它观察者是共同的契约，桥接不得插队或吞事件。
    const hub = newHub();
    const events = recordAll(hub);
    const order: string[] = [];
    hub.subscribe("pipe", () => {
      order.push("before-attach");
    });

    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(contextFor(hub));
    hub.subscribe("pipe", () => {
      order.push("after-attach");
    });

    hub.publish(
      "pipe",
      {
        type: "route",
        target: "example.com:80",
        mode: "client",
        route: "upstream",
      } satisfies PipeEvent,
    );
    expect(order).toEqual(["before-attach", "after-attach"]);
    // 桥接只**多挂一个**观察者：总线自己的 2 个 listener 一个不少、顺序不变
    expect(hub.listenerCount("pipe")).toBe(3);
    expect(events).toHaveLength(1);
  });
});

describe("runtime 桥接接线", () => {
  it("createProxyRuntime 桥接 pipe 事实；stop() 解绑但保留外部 EventHub", async () => {
    // 保护：库用户只通过 runtime.events 观察——桥接必须真的接线到 runtime，
    // 且 stop() 的解绑顺序是「先摘 core 订阅、后清 hub」，不留悬挂订阅。
    const events = new EventHub({ onListenerError: () => undefined });
    const seen: string[] = [];
    const port = await getFreePort();
    const runtime = createProxyRuntime({
      config: { host: "127.0.0.1", port, quotaUsageDir: LEDGER_DIR },
      events,
    });
    activeRuntimes.push(runtime);

    const subscription = events.subscribe("access.client-denied", (event) => {
      seen.push(`${event.context.protocol ?? "?"}:${event.data.reason}`);
    });

    // bridge 只在 start 轮次建立，构造期不能提前观察 core 事实。
    expect(events.listenerCount("pipe")).toBe(0);
    await runtime.start();
    expect(events.listenerCount("pipe")).toBeGreaterThan(0);
    events.publish(
      "pipe",
      { type: "ip-denied", client: "10.0.0.9", reason: "blacklist" } satisfies PipeEvent,
      { protocol: PROTOCOL },
    );
    expect(seen).toEqual(["http:blacklist"]);

    await runtime.stop();

    // stop() 之后总线上不再有桥接订阅；外部 hub 归调用方，订阅不能被 runtime 清空。
    expect(events.listenerCount("pipe")).toBe(0);
    expect(subscription.disposed).toBe(false);
    expect(events.listenerCount()).toBe(1);

    const afterStop: string[] = [];
    const afterStopSubscription = events.subscribe("access.client-denied", (event) => {
      afterStop.push(event.data.reason);
    });
    events.publish(
      "pipe",
      { type: "ip-denied", client: "10.0.0.9", reason: "blacklist" } satisfies PipeEvent,
      { protocol: PROTOCOL },
    );
    expect(afterStop).toEqual([]);
    subscription.dispose();
    afterStopSubscription.dispose();
  });
});