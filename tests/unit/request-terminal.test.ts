/**
 * `RequestTerminal` 的互斥语义：每个请求的终态**只发一次**
 *
 * @description
 * `request.completed` / `request.rejected` / `request.failed` 是同一个请求的三个互斥终态，
 * 三个出口**共用这一份抢占**，而不是各自 `publish` 一次。终态**只由 `RequestTerminal` 抢占并
 * 发布一次**；`complete` / `reject` / `fail` 在**抢占成功之后**才发布，所以「观察面异常」不会
 * 反过来改变协议收尾。
 *
 * 被否掉的是「每个出口各自发一次事件」或「先发布再判重」：
 * - 各自发一次 → 一次请求被拒时 `request.rejected` 与 `request.failed` 各来一条，运维分不清
 *   「到底哪一关拒的」，日志面与 `runtime/bridge.ts` 都要开始做去重（第二真相源）。
 * - 先发布再判重 → 发布本身有副作用，观察者抛错时已经发出去了，收不住。
 *
 * 锁点：
 * - 「首次 claim 成功，之后所有终态都失败」：`expect(terminal.claim("completed")).toBe(true)` 之后
 *   `expect(terminal.claim("rejected")).toBe(false)`、`expect(terminal.claim("failed")).toBe(false)`，
 *   且 `expect(terminal.kind).toBe("completed")` —— 首次分类结果**不可被覆盖**。
 * - 「completed/rejected/failed 三类互斥」：三类各当第一发穷举一遍，其余全拒。
 * - 「便捷收尾方法也只有第一次会发布」：`terminal.fail` → `reject` → `complete` 连打三次，
 *   `expect(calls).toEqual(["failed"])` —— 三个便捷方法**共用同一份抢占**，不是三个独立出口。
 *
 * 端到端那一半（真 `ProxyRuntime` 下 HTTP / SOCKS 的 completed/rejected/failed 生产与**唯一性**，
 * 每条路径 `expect(records).toHaveLength(1)`）在
 * `tests/integration/request-terminal-events.test.ts`；「`pipe` 侧不得为同一事实再发一条公共
 * 拒绝 / 失败事件」由 `tests/unit/core-event-bridge.test.ts` 的「target-unresolved 不经 bridge
 * 桥接（请求终态只由 RequestTerminal 发一次）」承担。
 */
import { describe, expect, it } from "vitest";
import { RequestTerminal } from "@/core/request-terminal.js";

describe("core/request-terminal", () => {
  it("首次 claim 成功，之后所有终态都失败", () => {
    const terminal = new RequestTerminal();

    expect(terminal.settled).toBe(false);
    expect(terminal.kind).toBeUndefined();
    expect(terminal.claim("completed")).toBe(true);
    expect(terminal.settled).toBe(true);
    expect(terminal.kind).toBe("completed");
    expect(terminal.claim("rejected")).toBe(false);
    expect(terminal.claim("failed")).toBe(false);
    expect(terminal.kind).toBe("completed");
  });

  it("completed/rejected/failed 三类互斥：首次分类结果不可被覆盖", () => {
    for (const first of ["completed", "rejected", "failed"] as const) {
      const terminal = new RequestTerminal();
      expect(terminal.claim(first)).toBe(true);
      for (const other of ["completed", "rejected", "failed"] as const) {
        expect(terminal.claim(other)).toBe(false);
      }
      expect(terminal.kind).toBe(first);
    }
  });

  it("便捷收尾方法也只有第一次会发布", () => {
    const calls: string[] = [];
    const terminal = new RequestTerminal({
      publisher: {
        completed: () => calls.push("completed"),
        rejected: () => calls.push("rejected"),
        failed: () => calls.push("failed"),
      },
    });

    terminal.fail(new Error("dial failed"), "dial");
    terminal.reject("denied", "access", 403);
    terminal.complete(200);

    expect(calls).toEqual(["failed"]);
    expect(terminal.kind).toBe("failed");
  });
});
