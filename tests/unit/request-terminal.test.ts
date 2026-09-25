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
