/**
 * 这一档钉住 `initialize` 的响应**形状**与 `protocolVersion` 的**回声规则**
 */

import { describe, expect, it } from "vitest";

import { ECHO_TOOL, request, startServer } from "./harness.js";

describe("initialize", () => {
  it("回 protocolVersion / capabilities / serverInfo 三段", async () => {
    const server = startServer([ECHO_TOOL]);
    server.push(request(1, "initialize", { protocolVersion: "2025-06-18" }));
    await server.finish();

    expect(server.responses()).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "@b-hole/proxy-mcp", version: "0.1.0" },
        },
      },
    ]);
  });

  it.each(["2025-06-18", "2025-03-26", "2024-11-05"])("支持集里的 %s 原样回声", async (version) => {
    const server = startServer([]);
    server.push(request(1, "initialize", { protocolVersion: version }));
    await server.finish();

    const [response] = server.responses() as [{ result: { protocolVersion: string } }];
    expect(response.result.protocolVersion).toBe(version);
  });

  it("不支持的版本退到最新的那个", async () => {
    const server = startServer([]);
    server.push(request(1, "initialize", { protocolVersion: "1999-01-01" }));
    await server.finish();

    const [response] = server.responses() as [{ result: { protocolVersion: string } }];
    expect(response.result.protocolVersion).toBe("2025-06-18");
  });

  it("ping 回空对象", async () => {
    const server = startServer([]);
    server.push(request(2, "ping"));
    await server.finish();

    expect(server.responses()).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }]);
  });
});