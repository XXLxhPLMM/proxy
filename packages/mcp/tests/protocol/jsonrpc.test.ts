/**
 * 这一档钉住 JSON-RPC 的**信封纪律**：未知方法 / 坏帧 / 非法 Request 的错误码，
 * 以及「通知不回任何东西」这条规矩。
 */

import { describe, expect, it } from "vitest";

import { notification, request, startServer } from "./harness.js";

describe("错误码", () => {
  it("未知方法 ⇒ -32601", async () => {
    const server = startServer([]);
    server.push(request(1, "没有这个方法"));
    await server.finish();

    const [response] = server.responses() as [{ error: { code: number; message: string }; result?: unknown }];
    expect(response.result).toBeUndefined();
    expect(response.error.code).toBe(-32601);
  });

  it("坏 JSON ⇒ -32700，且 id 为 null（读不出 id）", async () => {
    const server = startServer([]);
    server.push("{ 这不是 JSON\n");
    await server.finish();

    expect(server.responses()).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "不是合法的 JSON" } }]);
  });

  it("JSON 但不是合法 Request（jsonrpc 版本不对 / 没有 method / id 不是标量）⇒ -32600", async () => {
    const server = startServer([]);
    server.push(`${JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" })}\n`);
    server.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1 })}\n`);
    server.push(`${JSON.stringify({ jsonrpc: "2.0", id: { bad: true }, method: "ping" })}\n`);
    server.push(`${JSON.stringify([1, 2, 3])}\n`);
    await server.finish();

    const responses = server.responses() as { id: unknown; error: { code: number } }[];
    expect(responses.map((r) => r.error.code)).toEqual([-32600, -32600, -32600, -32600]);
    expect(responses[1]?.id).toBe(1);
    expect(responses[2]?.id).toBeNull();
    expect(responses[3]?.id).toBeNull();
  });

  it("任何错误响应都不带栈", async () => {
    const server = startServer([]);
    server.push(request(1, "炸了"));
    server.push("{ 坏\n");
    await server.finish();

    for (const line of server.rawLines()) {
      expect(line).not.toMatch(/\n\s+at |stack|Error:/);
      expect(Object.keys(JSON.parse(line) as object)).not.toContain("data");
    }
  });
});

describe("通知", () => {
  it("notifications/initialized 不回任何东西", async () => {
    const server = startServer([]);
    server.push(notification("notifications/initialized"));
    await server.finish();

    expect(server.rawLines()).toEqual([]);
  });

  it("未知通知也不回任何东西（规矩与方法存不存在无关）", async () => {
    const server = startServer([]);
    server.push(notification("完全/没听过"));
    await server.finish();

    expect(server.rawLines()).toEqual([]);
  });

  it("通知与请求混在一批里，只回请求的那些", async () => {
    const server = startServer([]);
    server.push(notification("notifications/initialized"));
    server.push(request(1, "ping"));
    server.push(notification("还是通知"));
    server.push(request(2, "ping"));
    await server.finish();

    expect(server.responses()).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
  });

  it("通知即便挂在「本来就有结果」的方法上也不回（闸门只看有没有 id）", async () => {
    const server = startServer([]);
    server.push(notification("ping"));
    server.push(notification("tools/list"));
    server.push(notification("initialize", { protocolVersion: "2025-06-18" }));
    await server.finish();

    expect(server.rawLines()).toEqual([]);
  });

  it("空行被忽略，不产生响应", async () => {
    const server = startServer([]);
    server.push("\n   \n\n");
    await server.finish();

    expect(server.rawLines()).toEqual([]);
  });
});