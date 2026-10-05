/**
 * 矩阵 `D) socks5 入站（SOCKS 隧道 × 各上游）`：入站=socks5 × SOCKS 隧道 × 各上游
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
  s5InPort,
  socks4UpPort,
  socks5UpPort,
  socksConnect,
  sockss4UpPort,
  sockss5UpPort,
} from "./matrix-fixture.js";

describe("D) socks5 入站（SOCKS 隧道 × 各上游）", () => {
  it.each([
    ["http", "http", () => httpUpPort, "", false, 200],
    ["https+CA", "https", () => httpsUpPort, CA, false, 200],
    ["socks4", "socks4", () => socks4UpPort, "", false, 200],
    ["socks5", "socks5", () => socks5UpPort, "", false, 200],
    ["sockss4+CA", "sockss4", () => sockss4UpPort, CA, false, 200],
    ["sockss5+CA", "sockss5", () => sockss5UpPort, CA, false, 200],
  ] as const)(
    "上游 %s → socks5 入站 200",
    async (_n, protocol, portFn, ca, insecure, want) => {
      applyUpstream(protocol, portFn(), ca, insecure);
      const { status, body } = await httpViaSocksProxy(
        s5InPort,
        5,
        "127.0.0.1",
        originPort,
        "/s5-in",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/s5-in");
      expect(want).toBe(200);
    },
    20000,
  );

  it.each([
    ["https 无 CA", "https", () => httpsUpPort],
    ["sockss5 无 CA", "sockss5", () => sockss5UpPort],
  ] as const)(
    "上游 %s：socks5 入站必须回失败应答（不挂死）",
    async (_n, protocol, portFn) => {
      applyUpstream(protocol, portFn(), "", false);
      const res = await socksConnect(s5InPort, 5, "127.0.0.1", originPort);
      expect(res.ok).toBe(false);
      expect(res.rep).toBeGreaterThan(0);
    },
    20000,
  );
});
