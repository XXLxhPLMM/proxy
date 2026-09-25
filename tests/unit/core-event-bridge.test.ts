import { EventEmitter } from "node:events";
import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "@/core/events/index.js";
import type { EventContext, EventName } from "@/core/events/index.js";
import type {
  PipeEvent,
  ProxyAuthEvent,
  ProxyClientErrorEvent,
  ProxyEventMap,
  ProxyForwardErrorEvent,
  ProxyForwardEvent,
  ProxyServerErrorEvent,
} from "@/core/types/proxy.js";
import { CoreEventBridge } from "@/runtime/bridge.js";
import type { NodeEventEmitterWithProxyEvents } from "@/runtime/bridge.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import { getFreePort } from "../helpers/net.js";

/** 假 core 事件源：与 `BaseProxy` 同为 `EventEmitter<ProxyEventMap>`，payload 手工构造，不起真代理。 */
class FakeCore extends EventEmitter<ProxyEventMap> {}

/**
 * 与 `runtime.ts` 相同的窄化：`ProxyCore` 的公共接口刻意不暴露 EventEmitter，
 * 观察 core 事件必须显式过这道桥接端口（事件名与 payload 仍由 `ProxyEventMap` 派生，无 `any`）。
 */
function asCore(core: FakeCore): NodeEventEmitterWithProxyEvents {
  return core as unknown as NodeEventEmitterWithProxyEvents;
}

const PROTOCOL = "http";

/** 本波桥接器应当发布的公共事件（测试 5 会另用全集断言「不该发的没发」）。 */
const BRIDGED: readonly EventName[] = [
  "auth.decided",
  "access.client-denied",
  "access.target-denied",
  "route.selected",
  "request.rejected",
];

/** `AppEventMap` 全集：用于断言「core 事件没有溢出成本波边界」。 */
const ALL_EVENT_NAMES: readonly EventName[] = [
  "runtime.starting",
  "runtime.started",
  "runtime.stopping",
  "runtime.stopped",
  "runtime.error",
  "lifecycle.changed",
  "config.loaded",
  "config.changed",
  "config.restart-required",
  "config.file-error",
  "config.file-recovered",
  "auth.decided",
  "access.client-denied",
  "access.target-denied",
  "route.selected",
  "request.completed",
  "request.rejected",
  "request.failed",
];

interface Recorded {
  name: EventName;
  data: unknown;
  context: EventContext;
}

function recordAll(hub: EventHub, names: readonly EventName[] = BRIDGED): Recorded[] {
  const events: Recorded[] = [];
  for (const name of names) {
    hub.subscribe(name, (event) => {
      events.push({ name: event.name, data: event.data, context: event.context });
    });
  }
  return events;
}

function fakeReq(init: {
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
  method?: string;
  remoteAddress?: string;
}): http.IncomingMessage {
  const req = {
    headers: init.headers ?? {},
    url: init.url,
    method: init.method,
    socket: { remoteAddress: init.remoteAddress },
  };
  return req as unknown as http.IncomingMessage;
}

const authAllow: ProxyAuthEvent = {
  passed: true,
  tag: "tunnel",
  client: "1.2.3.4",
  target: "example.com:443",
  user: "alice",
};

const authDeny: ProxyAuthEvent = {
  passed: false,
  tag: "tunnel",
  client: "1.2.3.4",
  target: "example.com:443",
  attempted: "bob",
  reason: "no-token",
};

const activeRuntimes: ProxyRuntime[] = [];

afterEach(async () => {
  const runtimes = activeRuntimes.splice(0);
  for (const runtime of runtimes) {
    await runtime.stop().catch(() => undefined);
  }
});

describe("runtime/bridge auth 事件", () => {
  it("auth 事件桥成 auth.decided：payload 与 context（client/target/user）齐全", () => {
    // 保护：库用户订阅 auth.decided 能拿到「谁、从哪、访问哪、判过没有」四项事实，
    // 且身份维度进 context（供跨事件的请求串联），不是只在 data 里留一个 passed。
    const hub = new EventHub({ runtimeId: "runtime-bridge", onListenerError: () => undefined });
    const events = recordAll(hub);
    const core = new FakeCore();
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(asCore(core));

    core.emit("auth", authAllow);
    core.emit("auth", authDeny);

    expect(events).toHaveLength(2);
    expect(events[0].name).toBe("auth.decided");
    expect(events[0].data).toEqual({
      passed: true,
      user: "alice",
      attempted: undefined,
      reason: undefined,
    });
    expect(events[0].context).toEqual({
      runtimeId: "runtime-bridge",
      protocol: "http",
      client: "1.2.3.4",
      target: "example.com:443",
      user: "alice",
    });

    // 拒绝分支：attempted/reason 必带，未通过的请求 context 不该凭空出现 user
    expect(events[1].data).toEqual({
      passed: false,
      user: undefined,
      attempted: "bob",
      reason: "no-token",
    });
    expect(events[1].context).toEqual({
      runtimeId: "runtime-bridge",
      protocol: "http",
      client: "1.2.3.4",
      target: "example.com:443",
    });
  });
});

describe("runtime/bridge 名单拒绝事件", () => {
  it("ip-denied / target-denied 桥成 access.client-denied / access.target-denied", () => {
    // 保护：ACL 拒绝是安全事实，必须原样可见；reason 只认 acl 的 whitelist/blacklist 闭合集合。
    const hub = new EventHub({ runtimeId: "runtime-bridge", onListenerError: () => undefined });
    const events = recordAll(hub);
    const core = new FakeCore();
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(asCore(core));

    core.emit("pipe", {
      type: "ip-denied",
      client: "10.0.0.9",
      reason: "blacklist",
      protocol: "socks5",
    } satisfies PipeEvent);
    core.emit("pipe", {
      type: "target-denied",
      host: "blocked.example",
      target: "blocked.example:443",
      reason: "whitelist",
      user: "alice",
    } satisfies PipeEvent);

    expect(events.map((event) => event.name)).toEqual([
      "access.client-denied",
      "access.target-denied",
    ]);
    expect(events[0].data).toEqual({ client: "10.0.0.9", reason: "blacklist" });
    expect(events[0].context).toEqual({
      runtimeId: "runtime-bridge",
      protocol: "http",
      client: "10.0.0.9",
    });
    expect(events[1].data).toEqual({
      host: "blocked.example",
      target: "blocked.example:443",
      reason: "whitelist",
    });
    expect(events[1].context).toEqual({
      runtimeId: "runtime-bridge",
      protocol: "http",
      target: "blocked.example:443",
      user: "alice",
    });
  });

  it("reason 缺失或不是名单语义时跳过发布：拒绝事实宁缺毋造", () => {
    // 保护：缺失 reason 时**不允许**默认成 blacklist——那会把「未知原因」伪装成确定的名单命中。
    const hub = new EventHub({ runtimeId: "runtime-bridge", onListenerError: () => undefined });
    const events = recordAll(hub);
    const core = new FakeCore();
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(asCore(core));

    core.emit("pipe", { type: "ip-denied", client: "10.0.0.9" } satisfies PipeEvent);
    core.emit("pipe", { type: "ip-denied", client: "10.0.0.9", reason: "" } satisfies PipeEvent);
    core.emit("pipe", {
      type: "ip-denied",
      client: "10.0.0.9",
      reason: "whatever",
    } satisfies PipeEvent);
    core.emit("pipe", { type: "target-denied", target: "a.example:443" } satisfies PipeEvent);
    core.emit("pipe", {
      type: "target-denied",
      target: "a.example:443",
      reason: "blacklist",
    } satisfies PipeEvent);

    expect(events).toEqual([]);
  });
});

describe("runtime/bridge 路由与解析失败事件", () => {
  it("route 桥成 route.selected，保留 mode/route/reason", () => {
    // 保护：路由判定是「走直连还是走上游」的权威事实，必须与 core 的 route 事件 1:1 可见。
    const hub = new EventHub({ runtimeId: "runtime-bridge", onListenerError: () => undefined });
    const events = recordAll(hub);
    const core = new FakeCore();
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(asCore(core));

    core.emit("pipe", {
      type: "route",
      target: "example.com:80",
      mode: "client",
      route: "direct",
      reason: "blacklist",
    } satisfies PipeEvent);
    core.emit("pipe", {
      type: "route",
      target: "example.com:80",
      mode: "client",
      route: "upstream",
    } satisfies PipeEvent);

    expect(events.map((event) => event.name)).toEqual(["route.selected", "route.selected"]);
    expect(events[0].data).toEqual({ mode: "client", route: "direct", reason: "blacklist" });
    expect(events[0].context).toEqual({
      runtimeId: "runtime-bridge",
      protocol: "http",
      target: "example.com:80",
    });
    expect(events[1].data).toEqual({ mode: "client", route: "upstream", reason: undefined });
  });

  it("target-unresolved 桥成 request.rejected(stage=parse)", () => {
    // 保护：目标都解析不出来属于请求报文层面的拒绝，stage 必须是 parse（与 400 语义一致）。
    const hub = new EventHub({ runtimeId: "runtime-bridge", onListenerError: () => undefined });
    const events = recordAll(hub);
    const core = new FakeCore();
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(asCore(core));

    core.emit("pipe", { type: "target-unresolved", url: "/no-host" } satisfies PipeEvent);

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("request.rejected");
    expect(events[0].data).toEqual({ stage: "parse", reason: "target-unresolved" });
    expect(events[0].context).toEqual({ runtimeId: "runtime-bridge", protocol: "http" });
  });

  it("req 携带身份时按注入的提取器补 client/target（DI 覆盖默认提取）", () => {
    // 保护：route/守卫类变体只带 target，client 要能从 req 兜底提取；提取器可注入，
    // 库用户不必接受 utils/ip 的默认提取策略。
    const hub = new EventHub({ runtimeId: "runtime-bridge", onListenerError: () => undefined });
    const events = recordAll(hub);
    const core = new FakeCore();
    const extractClient = vi.fn(() => "203.0.113.7");
    const extractTarget = vi.fn(() => "injected.example:8443");
    new CoreEventBridge({ hub, protocol: PROTOCOL, extractClient, extractTarget }).attach(
      asCore(core),
    );

    const req = fakeReq({ headers: { host: "example.com" }, method: "GET", url: "/x" });
    core.emit("pipe", {
      type: "target-denied",
      host: "example.com",
      reason: "blacklist",
      req,
    } satisfies PipeEvent);

    expect(extractClient).toHaveBeenCalledWith(req);
    expect(extractTarget).toHaveBeenCalledWith(req);
    expect(events[0].name).toBe("access.target-denied");
    expect(events[0].context).toEqual({
      runtimeId: "runtime-bridge",
      protocol: "http",
      client: "203.0.113.7",
      target: "injected.example:8443",
    });
  });
});

describe("runtime/bridge 本波边界", () => {
  it("forward / forwardError / serverError / clientError / 其余 pipe 变体一律不发公共事件", () => {
    // 保护：本波只桥 auth + 4 类 pipe。forward 是「开始转发」而非终态，错误类归 ErrorBoundary，
    // 提前发半真事件会让订阅方把开始当完成、把局部失败当请求失败。
    const hub = new EventHub({ runtimeId: "runtime-bridge", onListenerError: () => undefined });
    const events = recordAll(hub, ALL_EVENT_NAMES);
    const core = new FakeCore();
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(asCore(core));

    const forward: ProxyForwardEvent = { kind: "http", req: fakeReq({ url: "/x" }) };
    const forwardError: ProxyForwardErrorEvent = { kind: "http", error: new Error("boom") };
    const serverError: ProxyServerErrorEvent = {
      error: new Error("listen failed"),
      host: "127.0.0.1",
      port: 1080,
    };
    const clientError: ProxyClientErrorEvent = { error: new Error("bad request") };

    core.emit("forward", forward);
    core.emit("forwardError", forwardError);
    core.emit("serverError", serverError);
    core.emit("clientError", clientError);
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
      core.emit("pipe", event);
    }

    expect(events).toEqual([]);
    // 边界是「不发布」而不是「不观察」：这些事件照旧被 core 抛出给 CLI 日志面。
    expect(core.listenerCount("forward")).toBe(0);
    expect(core.listenerCount("forwardError")).toBe(0);
  });
});

describe("runtime/bridge 隔离与清理", () => {
  it("公共事件观察者抛错不打断 core 事件回调，其它桥接事件照常发布", () => {
    // 保护：桥接是旁路。观察者异常绝不能顺着 core 的 emit 反向打断鉴权/转发主流程。
    const onListenerError = vi.fn();
    const hub = new EventHub({ runtimeId: "runtime-bridge", onListenerError });
    hub.subscribe("auth.decided", () => {
      throw new Error("observer failed");
    });
    const routes: string[] = [];
    hub.subscribe("route.selected", (event) => {
      routes.push(event.data.route);
    });
    const core = new FakeCore();
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(asCore(core));

    expect(() => core.emit("auth", authAllow)).not.toThrow();
    expect(onListenerError).toHaveBeenCalledWith(expect.any(Error), "auth.decided");
    expect(() =>
      core.emit("pipe", {
        type: "route",
        target: "example.com:80",
        mode: "client",
        route: "upstream",
      } satisfies PipeEvent),
    ).not.toThrow();
    expect(routes).toEqual(["upstream"]);
  });

  it("subscription.dispose() 幂等：解绑 core 监听后不再发布，attach 也不再复活", () => {
    // 保护：runtime.stop() 之后既没有悬挂的 core 监听，也没有「dispose 后又被 attach 挂回去」的漏洞。
    const hub = new EventHub({ runtimeId: "runtime-bridge", onListenerError: () => undefined });
    const events = recordAll(hub);
    const core = new FakeCore();
    const bridge = new CoreEventBridge({ hub, protocol: PROTOCOL });
    bridge.attach(asCore(core));

    expect(core.listenerCount("auth")).toBe(1);
    expect(core.listenerCount("pipe")).toBe(1);
    expect(bridge.subscription.disposed).toBe(false);

    core.emit("auth", authAllow);
    expect(events).toHaveLength(1);

    bridge.subscription.dispose();
    expect(bridge.subscription.disposed).toBe(true);
    expect(core.listenerCount("auth")).toBe(0);
    expect(core.listenerCount("pipe")).toBe(0);

    core.emit("auth", authAllow);
    core.emit("pipe", {
      type: "ip-denied",
      client: "10.0.0.9",
      reason: "blacklist",
    } satisfies PipeEvent);
    expect(events).toHaveLength(1);

    expect(() => {
      bridge.attach(asCore(core));
      bridge.subscription.dispose();
    }).not.toThrow();
    expect(core.listenerCount("auth")).toBe(0);
    core.emit("auth", authAllow);
    expect(events).toHaveLength(1);
  });

  it("attach 不改变 core 自己的 emit：老 listener 仍按注册顺序各收一次，emit 返回 true", () => {
    // 保护：桥接只加观察者，不改 core 的事件投递语义（顺序、次数、返回值）——
    // core 的 emit 行为与返回值是 server 日志面和其它观察者共同的契约。
    const hub = new EventHub({ runtimeId: "runtime-bridge", onListenerError: () => undefined });
    const events = recordAll(hub);
    const core = new FakeCore();
    const order: string[] = [];
    core.on("auth", () => {
      order.push("before-attach");
    });

    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(asCore(core));
    core.on("auth", () => {
      order.push("after-attach");
    });

    expect(core.emit("auth", authAllow)).toBe(true);
    expect(order).toEqual(["before-attach", "after-attach"]);
    // 桥接只**多挂一个**观察者：core 自己的 2 个 listener 一个不少、顺序不变
    expect(core.listenerCount("auth")).toBe(3);
    expect(events).toHaveLength(1);
  });
});

describe("runtime 桥接接线", () => {
  it("createProxyRuntime 桥接事件；stop() 解绑 core 但保留外部 EventHub", async () => {
    // 保护：库用户只通过 runtime.events 观察——桥接必须真的接线到 runtime，
    // 且 stop() 的解绑顺序是「先摘 core 监听、后清 hub」，不留悬挂 core 监听。
    interface EmittableCore extends NodeEventEmitterWithProxyEvents {
      emit(name: "auth", data: ProxyAuthEvent): boolean;
      listenerCount(name: "auth"): number;
    }

    const events = new EventHub({ onListenerError: () => undefined });
    const seen: string[] = [];
    const port = await getFreePort();
    const runtime = createProxyRuntime({
      config: { host: "127.0.0.1", port },
      events,
    });
    activeRuntimes.push(runtime);
    const core = runtime.getProxy() as unknown as EmittableCore;

    const subscription = events.subscribe("auth.decided", (event) => {
      seen.push(`${event.context.protocol ?? "?"}:${event.data.passed}`);
    });

    // bridge 只在 start 轮次建立，构造期不能提前观察 core auth。
    expect(core.listenerCount("auth")).toBe(0);
    await runtime.start();
    expect(core.emit("auth", authAllow)).toBe(true);
    expect(seen).toEqual(["http:true"]);
    expect(core.listenerCount("auth")).toBeGreaterThan(0);

    await runtime.stop();

    // stop() 之后 core 上不再有桥接监听；外部 hub 归调用方，订阅不能被 runtime 清空。
    expect(core.listenerCount("auth")).toBe(0);
    expect(events.listenerCount()).toBe(1);

    const afterStop: string[] = [];
    const afterStopSubscription = events.subscribe("auth.decided", (event) => {
      afterStop.push(event.data.passed ? "allow" : "deny");
    });
    core.emit("auth", authAllow);
    expect(afterStop).toEqual([]);
    subscription.dispose();
    afterStopSubscription.dispose();
  });
});
