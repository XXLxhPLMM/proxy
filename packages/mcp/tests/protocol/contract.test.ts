/**
 * 这一档钉住**工具契约的接缝形状**：协议层从不替 handler 拼 `content` / `isError`。
 * ⚠️ 判据锚在「handler 只被调用、返回值被原样塞进 text」这个**行为**上 ——
 * 锚在某个符号名上的断言一旦那个符号被删就会恒真，而恒绿的护栏比没有护栏更贵。
 */

import { describe, expect, it } from "vitest";

import { handleLine, indexTools } from "../../src/protocol/index.js";
import { ECHO_TOOL, FAILING_TOOL } from "./harness.js";

describe("工具契约", () => {
  it("handler 拿到的就是 params.arguments（不被协议层改写）", async () => {
    const seen: Readonly<Record<string, unknown>>[] = [];
    const spy = {
      ...ECHO_TOOL,
      handler: async (args: Readonly<Record<string, unknown>>) => {
        seen.push(args);
        return "ok";
      },
    };
    const tools = indexTools([spy]);
    await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { a: 1, b: [2] } } }), tools);

    expect(seen).toEqual([{ a: 1, b: [2] }]);
  });

  it("handler 的返回值**原样**进 text（协议层不加工、不截断）", async () => {
    const payload = "  含换行\n与制表\t的原文  ";
    const tools = indexTools([{ ...ECHO_TOOL, handler: async () => payload }]);
    const response = await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } }), tools);

    expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: payload }] } });
  });

  it("tool result 里含裸换行的文本仍能安全上线（JSON.stringify 转义它，故一条消息恒是一行）", async () => {
    const tools = indexTools([{ ...ECHO_TOOL, handler: async () => "第一行\n第二行" }]);
    const response = await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } }), tools);

    expect(`${JSON.stringify(response)}\n`.split("\n")).toHaveLength(2);
  });

  it("失败时 text 走 asMcpError 而不是 String(err)（非 Error 也不许裸透）", async () => {
    const tools = indexTools([
      { ...ECHO_TOOL, name: "weird", handler: async () => Promise.reject("裸字符串") },
    ]);
    const response = await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "weird" } }), tools);

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "[local] 未知的失败（不是 Error 实例）" }], isError: true },
    });
  });

  it("协议层只 catch handler 的失败，不吞掉 tools/list 的正常结果", async () => {
    const tools = indexTools([ECHO_TOOL, FAILING_TOOL]);
    const response = await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), tools);

    expect(response).not.toBeNull();
    expect((response as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toEqual(["echo", "boom"]);
  });
});