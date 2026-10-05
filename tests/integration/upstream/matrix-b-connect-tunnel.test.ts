/**
 * 矩阵 `B) CONNECT 隧道（隧道转发路径）`：入站=http × CONNECT × 各上游
 *
 * @module tests/integration/upstream
 *
 * 共用的桩 / 端口 / `beforeAll` 在 `./matrix-fixture.ts`；矩阵覆盖目标与分组索引见 `./AGENTS.md`。
 */

import { describe, expect, it } from "vitest";
import {
  CA,
  applyUpstream,
  httpInPort,
  httpUpPort,
  httpsUpPort,
  originPort,
  socks4UpPort,
  socks5UpPort,
  sockss5UpPort,
  tunnelViaProxy,
} from "./matrix-fixture.js";

describe("B) CONNECT 隧道（隧道转发路径）", () => {
  it.each([
    ["http", "http", () => httpUpPort, "", false],
    ["https+CA", "https", () => httpsUpPort, CA, false],
    ["socks4", "socks4", () => socks4UpPort, "", false],
    ["socks5", "socks5", () => socks5UpPort, "", false],
    ["sockss5+CA", "sockss5", () => sockss5UpPort, CA, false],
  ] as const)(
    "上游 %s 隧道到源站（200）",
    async (_n, protocol, portFn, ca, insecure) => {
      applyUpstream(protocol, portFn(), ca, insecure);
      const { status, body } = await tunnelViaProxy(
        httpInPort,
        `127.0.0.1:${originPort}`,
        "/tunnel",
      );
      expect(status, body).toBe(200);
      expect(body).toContain("origin-ok:/tunnel");
    },
    20000,
  );

  it("上游 https 无 CA：CONNECT 必须失败（502 而非挂死）", async () => {
    applyUpstream("https", httpsUpPort, "", false);
    const { status, body } = await tunnelViaProxy(
      httpInPort,
      `127.0.0.1:${originPort}`,
      "/tunnel",
    );
    expect(status, body).toBe(502);
  }, 20000);

  it("上游 sockss5 无 CA：CONNECT 必须回 502（守卫不得连带销毁客户端）", async () => {
    applyUpstream("sockss5", sockss5UpPort, "", false);
    const { status, body } = await tunnelViaProxy(
      httpInPort,
      `127.0.0.1:${originPort}`,
      "/tunnel",
    );
    expect(status, body).toBe(502);
  }, 20000);
});
