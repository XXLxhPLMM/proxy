/**
 * 请求作用域标识生成器（scope-ids）契约
 *
 * 保护的不变量：
 *  - 同一连接对象重复取 connectionId 恒等（keep-alive 共享）
 *  - 不同连接对象的 connectionId 互不相同
 *  - newRequestId 每次都是新值（跨请求唯一）
 *  - 不依赖任何全局状态（可安全并发/多 runtime 使用）
 */
import { describe, expect, it } from "vitest";
import { connectionIdFor, newRequestId } from "@/core/scope-ids.js";

describe("core/scope-ids", () => {
  it("同一连接对象重复取 connectionId 恒等", () => {
    const conn = { tag: "conn" };
    const first = connectionIdFor(conn);
    const second = connectionIdFor(conn);
    expect(second).toBe(first);
  });

  it("不同连接对象的 connectionId 互不相同", () => {
    const a = connectionIdFor({ tag: "a" });
    const b = connectionIdFor({ tag: "b" });
    expect(a).not.toBe(b);
    expect(a).toHaveLength(36); // uuid
    expect(b).toHaveLength(36);
  });

  it("newRequestId 每次生成新值", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      ids.add(newRequestId());
    }
    expect(ids.size).toBe(1000);
  });

  it("connectionId 与 requestId 使用不同命名空间（不互相覆盖）", () => {
    const conn = {};
    const connId = connectionIdFor(conn);
    const reqId = newRequestId();
    expect(connId).not.toBe(reqId);
  });
});
