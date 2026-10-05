/**
 * 这一档钉住**分片形态**：一条 `data` 事件与一行之间没有一一对应关系。
 * ⚠️ 这是 stdio 传输唯一真正的坑 —— 「一个事件一条消息」的写法在真实管道上会随机丢消息。
 */

import { describe, expect, it } from "vitest";

import { ECHO_TOOL, request, startServer } from "./harness.js";

describe("分片", () => {
  it("一条 data 事件里两行消息 ⇒ 两个响应", async () => {
    const server = startServer([]);
    server.push(request(1, "ping") + request(2, "ping"));
    await server.finish();

    expect(server.responses()).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
  });

  it("一行被拆到三个 data 事件 ⇒ 仍然一个响应", async () => {
    const server = startServer([ECHO_TOOL]);
    // ⚠️ 切点只落在 ASCII 上：跨切点的多字节字符在**字节**层被劈开是另一回事
    // （真实分片不会那样，`setEncoding("utf8")` 的 StringDecoder 负责那种拼接）
    const line = request(1, "tools/call", { name: "echo", arguments: { text: "split-payload" } });
    server.push(line.slice(0, 10));
    server.push(line.slice(10, 40));
    server.push(line.slice(40));
    await server.finish();

    const responses = server.responses() as { id: number; result: { content: { text: string }[] } }[];
    expect(responses).toHaveLength(1);
    expect(responses[0]?.id).toBe(1);
    expect(responses[0]?.result.content[0]?.text).toBe("echo:split-payload");
  });

  it("一个 data 事件里三行 ⇒ 三个响应", async () => {
    const server = startServer([]);
    server.push(request(1, "ping") + request(2, "ping") + request(3, "ping"));
    await server.finish();

    expect(server.responses()).toHaveLength(3);
  });

  it("坏帧与好帧在同一次写入里 ⇒ 坏帧回 -32700 且循环继续", async () => {
    const server = startServer([ECHO_TOOL]);
    server.push("{ 坏帧\n" + request(1, "ping"));
    await server.finish();

    expect(server.responses()).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "不是合法的 JSON" } },
      { jsonrpc: "2.0", id: 1, result: {} },
    ]);
  });

  it("最后一行没带换行也照样处理（stdin 结束时 leftover 被兑现）", async () => {
    const server = startServer([]);
    server.push(request(1, "ping").trimEnd());
    await server.finish();

    expect(server.responses()).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("输入流里含工具定义时也正常工作（不靠 grep 守恒）", async () => {
    const server = startServer([ECHO_TOOL]);
    server.push(request(1, "tools/call", { name: "echo", arguments: { text: "a" } }));
    server.push(request(2, "tools/call", { name: "echo", arguments: { text: "b" } }));
    await server.finish();

    expect(server.responses()).toEqual([
      { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "echo:a" }] } },
      { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "echo:b" }] } },
    ]);
  });
});