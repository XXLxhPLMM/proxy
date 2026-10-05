/**
 * 矩阵 `A) http 入站（absolute-form 串联）`：入站=http × 各上游的命中档与「自签必拒」档
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
  httpViaProxy,
  httpsUpPort,
  originPort,
  socks4UpPort,
  socks5UpPort,
  sockss4UpPort,
  sockss5UpPort,
} from "./matrix-fixture.js";

describe("A) http 入站（absolute-form 串联）", () => {
  it.each([
    ["http", "http", () => httpUpPort, "", false, "upstream"],
    ["https+CA", "https", () => httpsUpPort, CA, false, "upstream"],
    ["https+insecure", "https", () => httpsUpPort, "", true, "upstream"],
    ["socks4", "socks4", () => socks4UpPort, "", false, "origin"],
    ["socks5", "socks5", () => socks5UpPort, "", false, "origin"],
    ["sockss4+CA", "sockss4", () => sockss4UpPort, CA, false, "origin"],
    ["sockss5+CA", "sockss5", () => sockss5UpPort, CA, false, "origin"],
  ] as const)(
    "上游 %s 命中目标（200）",
    async (_name, protocol, portFn, ca, insecure, expectKind) => {
      applyUpstream(protocol, portFn(), ca, insecure);
      // http/https 上游按 absolute-form 交给上游代理；socks 上游直达真实目标，须用可达的本地源站
      const local = expectKind === "origin";
      const url = local ? `http://127.0.0.1:${originPort}/chain` : "http://example.com/chain";
      const { status, body } = await httpViaProxy(httpInPort, url);
      expect(status, body).toBe(200);

      if (local) {
        expect(body).toContain("origin-ok:/chain");
      } else {
        // client 串联必须保留 absolute-form 交给上游代理
        expect(body).toBe(`upstream-ok:${url}`);
      }
    },
    20000,
  );

  it.each([
    ["https 无 CA（自签上游必须拒绝）", "https", () => httpsUpPort, "", false, "example.com"],
    [
      "https CA 文件缺失（回退系统库 → 自签被拒）",
      "https",
      () => httpsUpPort,
      "keys/nope.crt",
      false,
      "example.com",
    ],
    ["sockss5 无 CA（自签上游必须拒绝）", "sockss5", () => sockss5UpPort, "", false, "local"],
  ] as const)(
    "上游 %s → 502",
    async (_n, protocol, portFn, ca, insecure, target) => {
      applyUpstream(protocol, portFn(), ca, insecure);
      const url =
        target === "local"
          ? `http://127.0.0.1:${originPort}/denied`
          : "http://example.com/denied";
      const { status, body } = await httpViaProxy(httpInPort, url);
      expect(status, body).toBe(502);
    },
    20000,
  );
});
