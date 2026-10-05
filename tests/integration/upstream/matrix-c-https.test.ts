/**
 * 矩阵 `C) https 入站（TLS 下游 × 各上游）`：入站=https（TLS 下游）× 各上游
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
  httpViaProxy,
  httpsInPort,
  httpsUpPort,
  originPort,
  socks5UpPort,
  sockss5UpPort,
} from "./matrix-fixture.js";

describe("C) https 入站（TLS 下游 × 各上游）", () => {
  it.each([
    ["https+CA", "https", () => httpsUpPort, CA, false, "upstream"],
    ["socks5", "socks5", () => socks5UpPort, "", false, "origin"],
    ["sockss5+CA", "sockss5", () => sockss5UpPort, CA, false, "origin"],
    ["http", "http", () => httpUpPort, "", false, "upstream"],
  ] as const)(
    "上游 %s 命中目标（200）",
    async (_n, protocol, portFn, ca, insecure, kind) => {
      applyUpstream(protocol, portFn(), ca, insecure);
      const local = kind === "origin";
      const url = local ? `http://127.0.0.1:${originPort}/tls-in` : "http://example.com/tls-in";
      const { status, body } = await httpViaProxy(httpsInPort, url, true);
      expect(status, body).toBe(200);

      if (local) {
        expect(body).toContain("origin-ok:/tls-in");
      } else {
        expect(body).toBe(`upstream-ok:${url}`);
      }
    },
    20000,
  );
});
