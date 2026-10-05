/**
 * 矩阵 `E) socks4 入站`：入站=socks4 × SOCKS 隧道 × 各上游
 *
 * @module tests/integration/upstream
 *
 * 共用的桩 / 端口 / `beforeAll` 在 `./matrix-fixture.ts`；矩阵覆盖目标与分组索引见 `./AGENTS.md`。
 */

import { describe, expect, it } from "vitest";
import {
  CA,
  applyUpstream,
  httpUpPort,
  httpViaSocksProxy,
  httpsUpPort,
  originPort,
  s4InPort,
  socks4UpPort,
  socksConnect,
  sockss4UpPort,
} from "./matrix-fixture.js";

describe("E) socks4 入站", () => {
  it.each([
    ["http", "http", () => httpUpPort, "", false],
    ["socks4", "socks4", () => socks4UpPort, "", false],
    ["sockss4+CA", "sockss4", () => sockss4UpPort, CA, false],
    ["https+CA", "https", () => httpsUpPort, CA, false],
  ] as const)(
    "上游 %s → socks4 入站 200",
    async (_n, protocol, portFn, ca, insecure) => {
      applyUpstream(protocol, portFn(), ca, insecure);
      const { status, body } = await httpViaSocksProxy(
        s4InPort,
        4,
        "127.0.0.1",
        originPort,
        "/s4-in",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/s4-in");
    },
    20000,
  );

  it("上游 https 无 CA：socks4 入站必须回失败应答", async () => {
    applyUpstream("https", httpsUpPort, "", false);
    const res = await socksConnect(s4InPort, 4, "127.0.0.1", originPort);
    expect(res.ok).toBe(false);
    expect(res.rep).not.toBe(0x5a);
  }, 20000);
});
