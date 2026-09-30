/**
 * `PipeEvent` 判别联合的类型契约：14 变体穷尽、**无索引签名**
 *
 * @description
 * 本档是「`helper/pipe` 事件口径不靠判别键收窄解决、靠 `e satisfies never` 收口」这条决策的
 * 可执行版本。
 *
 * 被否掉的是「给 `PipeEventBase` 加索引签名（`[k: string]: unknown`）」。索引签名会让
 * 14 变体的**穷尽性彻底消失**：switch 的 `default` 分支里 `event` 永远收窄不到 `never`，
 * 于是「漏了新变体」从**编译期失败**退化成运行期一条静默的 `debug`。正确形态是让消费者在覆盖
 * 全部 case 之后于 `default` 用 `e satisfies never` 把「漏了新变体」变成编译期失败。
 *
 * 锁点两组，互为正反两面：
 * - **收口有效**：「完整 switch 可用 e satisfies never 穷尽收口，漏 case 时收口失败」——
 *   `exhaustive` 覆盖 14 个 case 后 `event satisfies never` 编译通过；而**故意**漏掉 `debug`
 *   的那份带 `// @ts-expect-error 漏掉 debug case 后 event 尚未收窄为 never`。
 *   **「漏了会红」这件事本身就是断言**：`@ts-expect-error` 在收窄意外成功时会报「未使用的
 *   抑制注释」，`tsc --noEmit` 当场失败。
 * - **索引签名不许回来**：「PipeEvent 不接受联合未声明的任意字段」——
 *   `const event: PipeEvent = { type: "debug", notAField: 1 }` 带
 *   `// @ts-expect-error notAField 不属于 PipeEvent 任何变体，未知字段必须编译失败`。
 *   给 `PipeEventBase` 加上索引签名的那一天，这两处 `@ts-expect-error` 会同时失去 error →
 *   `pnpm typecheck` 红。
 *
 * 变体清单本身（`expectTypeOf<PipeEventType>().toEqualTypeOf<…14 个字面量>()`）与运行期的 14 条
 * 样本由本档第一、二条钉着：`expect(new Set(events.map((event) => event.type)).size).toBe(14)`
 * ——新增、删除或拼错变体都必须先更新显式契约。
 *
 * ⚠️ 变体数是**契约**不是实现细节：`tests/unit/core-event-bridge.test.ts` 的
 * 「target-unresolved 不经 bridge 桥接（请求终态只由 RequestTerminal 发一次）」证明
 * **新增任何 pipe 变体前必须先确认它没有已由终态 publisher 覆盖的公共形状** —— 否则同一次
 * 拒绝会在事件流里发两条。
 *
 * ### 两条 quota 事件**刻意不进** `PipeEvent` 判别联合
 *
 * `traffic.quota-exceeded` / `traffic.usage-error` 是**独立的公共契约**而不是管道细节：
 * 它们是「用量判定 + 落盘账本」这一域的公共事实，由 core 经注入的闭包（`onUsageError`）
 * 直接发布到 `ctx.events`，**不经过 `pipe`**。加进联合会让上面那份 14 变体的穷尽清单与
 * 两处既有护栏（`tests/unit/pipe-event.test.ts` 的类型契约 + 运行期样本集、
 * `tests/integration/library-event-log-binding.test.ts` 的「pipe switch 仍是 14 变体」数出来那条）
 * 同时要改——那正是「契约」与「顺手加一个 case」的分界线。
 * 牙齿：`expectTypeOf<PipeEventType>().toEqualTypeOf<…14 个字面量>()`（多一个字面量当场红）
 * + `expect(new Set(events.map((event) => event.type)).size).toBe(14)`。
 * 反向那一面（它们**确实**是公共事件、且落盘那一跳由 runtime 的 `bindProxyEventLogs` 承担，
 * core 自己不落日志）在 `tests/integration/library-event-log-binding.test.ts` 的
 * 「11 类公共事件订阅一条不少」那条——`expect(code).toContain('bind("traffic.quota-exceeded"')`
 * 与 `bind("traffic.usage-error"`。
 */
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
      // 请求作用域标识：协议入口注入，供 runtime bridge 与终态事件串联
      requestId?: string;
      connectionId?: string;
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
