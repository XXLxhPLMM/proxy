/**
 * 这一档钉住 `tools/list` 的**逐字转写**与 `tools/call` 的**两种结果形态**
 */

import { describe, expect, it } from "vitest";

import { McpError } from "../../src/utils/errors.js";
import { ECHO_TOOL, FAILING_TOOL, request, startServer } from "./harness.js";

describe("tools/list", () => {
  it("逐字给出 name / description / inputSchema，且不含 handler", async () => {
    const server = startServer([ECHO_TOOL]);
    server.push(request(1, "tools/list"));
    await server.finish();

    expect(server.responses()).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            {
              name: "echo",
              description: "原样回显",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string", description: "要说的话" } },
                required: ["text"],
              },
            },
          ],
        },
      },
    ]);
  });

  it("没有工具时是空数组而不是缺席", async () => {
    const server = startServer([]);
    server.push(request(1, "tools/list"));
    await server.finish();

    expect(server.responses()).toEqual([{ jsonrpc: "2.0", id: 1, result: { tools: [] } }]);
  });
});

describe("tools/call", () => {
  it("成功 ⇒ content 一段 text 且不带 isError", async () => {
    const server = startServer([ECHO_TOOL]);
    server.push(request(7, "tools/call", { name: "echo", arguments: { text: "hi" } }));
    await server.finish();

    const [response] = server.responses() as [{ result: Record<string, unknown> }];
    expect(response.result).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
    expect(Object.prototype.hasOwnProperty.call(response.result, "isError")).toBe(false);
  });

  it("工具抛 McpError ⇒ isError 且 text 是 toReport 的形态，**不是** JSON-RPC 错误", async () => {
    const failing: typeof FAILING_TOOL = {
      ...FAILING_TOOL,
      handler: async () => {
        throw McpError.wire("对面拒了", 503, "req-7");
      },
    };
    const server = startServer([failing]);
    server.push(request(8, "tools/call", { name: "boom", arguments: {} }));
    await server.finish();

    const [response] = server.responses() as [{ result: { content: { text: string }[]; isError?: boolean }; error?: unknown }];
    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toBe("[wire] HTTP 503 requestId=req-7 对面拒了");
  });

  it("工具抛普通 Error ⇒ 仍走 isError，且不带栈", async () => {
    const server = startServer([FAILING_TOOL]);
    server.push(request(9, "tools/call", { name: "boom" }));
    await server.finish();

    const [response] = server.responses() as [{ result: { content: { text: string }[]; isError?: boolean } }];
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toBe("[local] 炸了");
    expect(server.rawLines()[0]).not.toContain("at ");
  });

  it("arguments 缺席时传空对象给 handler", async () => {
    const spy = {
      ...ECHO_TOOL,
      handler: async (args: Readonly<Record<string, unknown>>) => JSON.stringify(args),
    };
    const server = startServer([spy]);
    server.push(request(10, "tools/call", { name: "echo" }));
    await server.finish();

    const [response] = server.responses() as [{ result: { content: { text: string }[] } }];
    expect(response.result.content[0]?.text).toBe("{}");
  });

  it("未知工具名 ⇒ -32602（协议层不认识 ⇒ params 不合法，不是业务失败）", async () => {
    const server = startServer([ECHO_TOOL]);
    server.push(request(11, "tools/call", { name: "不存在", arguments: {} }));
    await server.finish();

    const [response] = server.responses() as [{ error: { code: number } }];
    expect(response.error.code).toBe(-32602);
  });

  it("缺 name ⇒ -32602；arguments 不是对象 ⇒ -32602", async () => {
    const server = startServer([ECHO_TOOL]);
    server.push(request(12, "tools/call", { arguments: {} }));
    server.push(request(13, "tools/call", { name: "echo", arguments: "hi" }));
    server.push(request(14, "tools/call", { name: "echo", arguments: [] }));
    await server.finish();

    const responses = server.responses() as { error: { code: number } }[];
    expect(responses.map((r) => r.error.code)).toEqual([-32602, -32602, -32602]);
  });
});