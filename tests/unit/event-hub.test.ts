import { describe, expect, it, vi } from "vitest";
import {
  EventHub,
  createConnectionScope,
  createRequestScope,
  createRuntimeScope,
} from "@/core/events/index.js";
import type { EventEnvelope } from "@/core/events/index.js";

describe("core/events EventHub", () => {
  it("隔离 listener 异常：其它 listener 仍收到事件，publish 不抛", () => {
    // 保护：事件发布只记录事实，单个观察者异常不能污染发布路径或其它观察者。
    const onListenerError = vi.fn();
    const hub = new EventHub({ runtimeId: "runtime-1", onListenerError });
    const second = vi.fn();
    hub.subscribe("auth.decided", () => {
      throw new Error("observer failed");
    });
    hub.subscribe("auth.decided", second);

    expect(() => hub.publish("auth.decided", { passed: true })).not.toThrow();
    expect(second).toHaveBeenCalledOnce();
    expect(onListenerError).toHaveBeenCalledWith(expect.any(Error), "auth.decided");
  });

  it("用快照分发：emit 中新增/释放 listener 不改变本次迭代", () => {
    // 保护：事件分发不能因观察者在回调里改订阅表而跳过、重复或崩溃。
    const hub = new EventHub({ runtimeId: "runtime-1", onListenerError: () => {} });
    const calls: string[] = [];
    const later: { third?: { readonly disposed: boolean; dispose(): void } } = {};
    const second = hub.subscribe("auth.decided", () => {
      calls.push("second");
      later.third?.dispose();
    });
    later.third = hub.subscribe("auth.decided", () => {
      calls.push("third");
    });
    hub.subscribe("auth.decided", () => {
      calls.push("added");
      hub.subscribe("auth.decided", () => {
        calls.push("new");
      });
    });

    hub.publish("auth.decided", { passed: true });

    expect(calls).toEqual(["second", "third", "added"]);
    expect(later.third?.disposed).toBe(true);
    second.dispose();
  });

  it("dispose 幂等且只读 disposed 状态会及时反映", () => {
    // 保护：清理路径允许重复调用，且订阅状态不会因 dispose 抛错或重复计数。
    const hub = new EventHub();
    const listener = vi.fn();
    const subscription = hub.subscribe("runtime.stopping", listener);

    expect(subscription.disposed).toBe(false);
    expect(() => subscription.dispose()).not.toThrow();
    expect(() => subscription.dispose()).not.toThrow();
    expect(subscription.disposed).toBe(true);
    expect(hub.listenerCount("runtime.stopping")).toBe(0);

    hub.publish("runtime.stopping", undefined);
    expect(listener).not.toHaveBeenCalled();
  });

  it("removeAll 清空全部事件和订阅，之后 publish 仍是安全空操作", () => {
    // 保护：runtime.stop() 释放监听器后不能留下悬挂回调，也不能因空表发布而抛错。
    const hub = new EventHub({ runtimeId: "runtime-1", onListenerError: () => {} });
    const first = hub.subscribe("runtime.started", vi.fn());
    const second = hub.subscribe("auth.decided", vi.fn());
    const once = hub.once("request.completed", vi.fn());

    expect(hub.listenerCount()).toBe(3);
    hub.removeAll();

    expect(hub.listenerCount()).toBe(0);
    expect(first.disposed).toBe(true);
    expect(second.disposed).toBe(true);
    expect(once.disposed).toBe(true);
    expect(() => hub.publish("runtime.stopped", undefined)).not.toThrow();
  });

  it("once 首次触发后自动摘链，第二次发布不再通知", () => {
    // 保护：一次性事实监听不会跨请求残留，也不会在重入发布时重复执行。
    const hub = new EventHub();
    const listener = vi.fn();
    const subscription = hub.once("lifecycle.changed", listener);

    hub.publish("lifecycle.changed", { next: "running", prev: "starting" });
    hub.publish("lifecycle.changed", { next: "stopped", prev: "running" });

    expect(listener).toHaveBeenCalledOnce();
    expect(subscription.disposed).toBe(true);
    expect(hub.listenerCount("lifecycle.changed")).toBe(0);
  });

  it("merge 统一释放多个订阅且重复 dispose 幂等", () => {
    // 保护：组合订阅的清理动作完整执行，并可安全交给 finally 等多处调用。
    const hub = new EventHub();
    const first = hub.subscribe("request.rejected", vi.fn());
    const second = hub.subscribe("request.failed", vi.fn());
    const merged = EventHub.merge([first, second]);

    expect(merged.disposed).toBe(false);
    merged.dispose();
    merged.dispose();

    expect(merged.disposed).toBe(true);
    expect(first.disposed).toBe(true);
    expect(second.disposed).toBe(true);
    expect(hub.listenerCount()).toBe(0);
  });

  it("强类型事件名和 payload：合法事件通过，错误 payload 编译期被拒绝", () => {
    // 保护：事件名与 payload 必须由 AppEventMap 联动，禁止弱类型事件袋回归。
    const hub = new EventHub();
    const assertTypes = (): void => {
      hub.publish("auth.decided", { passed: true });
      // @ts-expect-error passed 必须是 boolean，不能接收字符串
      hub.publish("auth.decided", { passed: "yes" });
    };
    void assertTypes;
    expect(hub.listenerCount()).toBe(0);
  });

  it("发布时浅拷贝 context，显式 runtimeId 优先且调用方后续修改不污染信封", () => {
    // 保护：context 是事件关联快照，不能让调用方复用对象时悄悄改写已发布事实。
    const hub = new EventHub({ runtimeId: "runtime-default" });
    const context = { connectionId: "connection-1" };
    let received: EventEnvelope<"auth.decided"> | undefined;
    hub.subscribe("auth.decided", (event) => {
      received = event;
    });

    hub.publish("auth.decided", { passed: true }, context);
    context.connectionId = "connection-mutated";

    expect(received?.context.runtimeId).toBe("runtime-default");
    expect(received?.context.connectionId).toBe("connection-1");

    hub.publish("auth.decided", { passed: true }, { runtimeId: "runtime-override" });
    expect(received?.context.runtimeId).toBe("runtime-override");
  });
});

describe("core/events EventScope", () => {
  it("runtime → connection → request 作用域继承并覆写关联 id", () => {
    // 保护：作用域链只携带关联事实，子作用域不能丢失或误改 runtime/connection/request。
    const runtime = createRuntimeScope("runtime-1");
    const connection = createConnectionScope(runtime.runtimeId, "connection-1").child({
      protocol: "http",
      client: "127.0.0.1",
    });
    const request = connection.child({
      connectionId: "connection-2",
      request: true,
      requestId: "request-1",
      target: "example.com:443",
    });
    const standaloneRequest = createRequestScope(runtime.runtimeId, "request-2", "connection-3");

    expect(runtime.runtimeId).toBe("runtime-1");
    expect(connection.runtimeId).toBe("runtime-1");
    expect(connection.connectionId).toBe("connection-1");
    expect(request.runtimeId).toBe("runtime-1");
    expect(request.connectionId).toBe("connection-2");
    expect(request.requestId).toBe("request-1");
    expect(request.protocol).toBe("http");
    expect(request.client).toBe("127.0.0.1");
    expect(request.target).toBe("example.com:443");
    expect(standaloneRequest.connectionId).toBe("connection-3");
    expect(standaloneRequest.requestId).toBe("request-2");
  });

  it("child/withIdentity 返回独立快照，toContext 不泄漏 runtimeId", () => {
    // 保护：派生作用域不修改父级，身份补全可直接安全传给 publish。
    const parent = createConnectionScope("runtime-1", "connection-1").child({
      protocol: "http",
      client: "127.0.0.1",
    });
    const child = parent.child({
      connectionId: "connection-2",
      request: true,
      requestId: "request-1",
    });
    const identified = child.withIdentity({ user: "alice", target: "example.com:80" });

    expect(parent.connectionId).toBe("connection-1");
    expect(parent.requestId).toBeUndefined();
    expect(child.connectionId).toBe("connection-2");
    expect(child.requestId).toBe("request-1");
    expect(child.toContext()).toEqual({
      connectionId: "connection-2",
      requestId: "request-1",
      protocol: "http",
      client: "127.0.0.1",
    });
    expect(identified.toContext()).toEqual({
      connectionId: "connection-2",
      requestId: "request-1",
      protocol: "http",
      client: "127.0.0.1",
      user: "alice",
      target: "example.com:80",
    });
    expect(identified.toContext()).not.toHaveProperty("runtimeId");
  });
});
