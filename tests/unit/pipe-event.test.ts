import { describe, expect, expectTypeOf, it } from "vitest";
import type { HelperEvent } from "@/core/guard.js";
import type {
  PipeEvent,
  PipeEventBase,
  PipeEventType,
  PipeRouteEvent,
  PipeUpstreamErrorEvent,
} from "@/core/types/proxy.js";

describe("PipeEvent 判别联合类型契约", () => {
  it("14 个管道事件变体在编译期和运行时均完备", () => {
    // 保护：判别键只能由这 14 个字面量组成，新增、删除或拼错变体都必须先更新显式契约。
    expectTypeOf<PipeEventType>().toEqualTypeOf<
      | "target-unresolved"
      | "loop-detected"
      | "route"
      | "upstream-refused"
      | "upstream-error"
      | "upstream-timeout"
      | "ip-denied"
      | "target-denied"
      | "socks"
      | "bad-request"
      | "dial"
      | "established"
      | "client-error"
      | "debug"
    >();

    const events: PipeEvent[] = [
      { type: "target-unresolved", target: "http://", message: "unresolved target" },
      { type: "loop-detected", message: "dial points back to proxy" },
      { type: "route", mode: "server", route: "direct", target: "example.com:443" },
      { type: "upstream-refused", statusLine: "HTTP/1.1 403 Forbidden" },
      { type: "upstream-error", err: new Error("upstream failed") },
      { type: "upstream-timeout", message: "upstream timeout" },
      { type: "ip-denied", protocol: "http", client: "127.0.0.1" },
      { type: "target-denied", host: "denied.example", reason: "blacklist" },
      { type: "socks", message: "socks session closed" },
      { type: "bad-request", message: "invalid socks request" },
      { type: "dial", message: "dialing upstream" },
      { type: "established", message: "upstream established" },
      { type: "client-error", err: new Error("client aborted") },
      { type: "debug", message: "debug fact" },
    ];

    expect(events).toHaveLength(14);
    expect(new Set(events.map((event) => event.type)).size).toBe(14);
  });

  it("route 变体的 mode 与 route 是必填字面量", () => {
    // 保护：server 层消费 `[route]` 时依赖这两个必填判别事实，缺失或扩大为 string 都会破坏日志契约。
    expectTypeOf<Pick<PipeRouteEvent, "mode">>().toEqualTypeOf<{
      mode: "server" | "client";
    }>();
    expectTypeOf<Pick<PipeRouteEvent, "route">>().toEqualTypeOf<{
      route: "direct" | "upstream";
    }>();

    // @ts-expect-error route 是 PipeRouteEvent 必填字段，缺失时必须编译失败
    const missingRoute: PipeRouteEvent = { type: "route", mode: "server" };
    // @ts-expect-error mode 是 PipeRouteEvent 必填字段，缺失时必须编译失败
    const missingMode: PipeRouteEvent = { type: "route", route: "direct" };

    void [missingRoute, missingMode];
  });

  it("所有变体共享的公共维度均保持可选", () => {
    // 保护：公共日志维度按需提供，最小变体只能要求 type（route 的两个路由字段除外）。
    expectTypeOf<PipeEventBase>().toEqualTypeOf<{
      target?: string;
      message?: string;
      url?: string;
      req?: unknown;
      statusLine?: string;
      user?: string;
      client?: string;
      reason?: string;
    }>();

    const minimalEvent: PipeEvent = { type: "debug" };
    expect(minimalEvent).toEqual({ type: "debug" });
  });

  it("switch 按 type 收窄后暴露变体专属字段", () => {
    // 保护：消费端无需强转即可读取 route 字面量与 upstream-error 的 err。
    const consume = (event: PipeEvent): string => {
      switch (event.type) {
        case "route":
          expectTypeOf(event).toEqualTypeOf<PipeRouteEvent>();
          expectTypeOf(event.mode).toEqualTypeOf<"server" | "client">();
          expectTypeOf(event.route).toEqualTypeOf<"direct" | "upstream">();
          return `${event.mode}:${event.route}`;
        case "upstream-error":
          expectTypeOf(event).toEqualTypeOf<PipeUpstreamErrorEvent>();
          expectTypeOf(event.err).toEqualTypeOf<unknown>();
          return event.err instanceof Error ? event.err.message : String(event.err);
        default:
          return event.type;
      }
    };

    expect(consume({ type: "route", mode: "client", route: "upstream" })).toBe("client:upstream");
    expect(consume({ type: "upstream-error", err: new Error("boom") })).toBe("boom");
  });

  it("完整 switch 可用 e satisfies never 穷尽收口，漏 case 时收口失败", () => {
    // 保护：新增 PipeEvent 变体时消费者必须显式处理；default 分支不得残留未收窄事件。
    const exhaustive = (event: PipeEvent): void => {
      switch (event.type) {
        case "target-unresolved":
        case "loop-detected":
        case "route":
        case "upstream-refused":
        case "upstream-error":
        case "upstream-timeout":
        case "ip-denied":
        case "target-denied":
        case "socks":
        case "bad-request":
        case "dial":
        case "established":
        case "client-error":
        case "debug":
          return;
        default:
          event satisfies never; // eslint-disable-line @typescript-eslint/no-unused-expressions
      }
    };

    const missingDebugCase = (event: PipeEvent): void => {
      switch (event.type) {
        case "target-unresolved":
        case "loop-detected":
        case "route":
        case "upstream-refused":
        case "upstream-error":
        case "upstream-timeout":
        case "ip-denied":
        case "target-denied":
        case "socks":
        case "bad-request":
        case "dial":
        case "established":
        case "client-error":
          return;
        default:
          // @ts-expect-error 漏掉 debug case 后 event 尚未收窄为 never
          event satisfies never; // eslint-disable-line @typescript-eslint/no-unused-expressions
      }
    };

    expect(exhaustive).toBeTypeOf("function");
    expect(missingDebugCase).toBeTypeOf("function");
  });

  it("HelperEvent 的五个代表性变体均可直接进入 PipeEvent 事件槽", () => {
    // 保护：guard 产生的拨号守卫事件是 PipeEvent 的真子集，可无转换透传给统一事件消费者。
    expectTypeOf<HelperEvent["type"]>().toEqualTypeOf<
      "dial" | "established" | "upstream-timeout" | "upstream-error" | "client-error"
    >();

    const events: PipeEvent[] = [
      { type: "dial", message: "dialing" } satisfies HelperEvent,
      { type: "established", message: "established" } satisfies HelperEvent,
      { type: "upstream-timeout", message: "timeout" } satisfies HelperEvent,
      {
        type: "upstream-error",
        message: "failed",
        err: new Error("upstream"),
      } satisfies HelperEvent,
      {
        type: "client-error",
        message: "client failed",
        err: new Error("client"),
      } satisfies HelperEvent,
    ];

    expect(events).toHaveLength(5);
  });

  it("PipeEvent 不接受联合未声明的任意字段", () => {
    // 保护：禁止索引签名把判别联合退化回可任意塞值的弱类型事件袋。
    const event: PipeEvent = {
      type: "debug",
      // @ts-expect-error notAField 不属于 PipeEvent 任何变体，未知字段必须编译失败
      notAField: 1,
    };

    expect(event).toEqual({ type: "debug", notAField: 1 });
  });
});
