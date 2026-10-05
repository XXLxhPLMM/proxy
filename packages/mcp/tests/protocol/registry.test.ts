/**
 * 这一档钉住**启动期的不变量**：重复工具名当场抛，且在往 stdout 写过任何东西之前抛。
 * ⚠️ 判据锚在「抛」这个行为上，而不是锚在某个被删符号的名字上 ——
 * 后者一旦符号被改名，断言就恒真而不报警了。
 */

import { describe, expect, it } from "vitest";

import { runStdioServer } from "../../src/protocol/index.js";
import { ECHO_TOOL } from "./harness.js";

describe("工具表", () => {
  it("重复的工具名 ⇒ runStdioServer 抛", () => {
    const duplicated = [ECHO_TOOL, { ...ECHO_TOOL, description: "另一个" }];
    expect(() => runStdioServer(duplicated)).toThrow(/重复/);
  });

  it("抛的消息里带着撞车的名字（好排查）", () => {
    const duplicated = [ECHO_TOOL, { ...ECHO_TOOL, description: "另一个" }];
    expect(() => runStdioServer(duplicated)).toThrow("echo");
  });

  it("重名是在挂 stdin 监听之前判的：抛出后没有任何请求得到响应", () => {
    const duplicated = [ECHO_TOOL, { ...ECHO_TOOL, description: "另一个" }];
    expect(() => runStdioServer(duplicated)).toThrow(/重复/);
    expect(process.stdin.listenerCount("data")).toBe(0);
  });

  it("名字互不相同不抛（`name` 是唯一键）", async () => {
    const unique = [ECHO_TOOL, { ...ECHO_TOOL, name: "echo2" }];
    const { indexTools } = await import("../../src/protocol/index.js");
    expect([...indexTools(unique).keys()]).toEqual(["echo", "echo2"]);
  });
});