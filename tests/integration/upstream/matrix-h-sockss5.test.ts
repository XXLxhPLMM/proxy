/**
 * 矩阵 `H) sockss5 入站（TLS 承载 SOCKS5）× 六上游`：六协议规格表在 TLS 承载的 SOCKS5 入站上跑满
 *
 * @module tests/integration/upstream
 *
 * 共用的桩 / 端口 / `beforeAll` / `SIX_UPSTREAMS` 在 `./matrix-fixture.ts`；分组索引见 `./AGENTS.md`。
 */

import { describe, expect, it } from "vitest";
import { defaults } from "@/config/index.js";
import {
  CA,
  SIX_UPSTREAMS,
  applyUpstream,
  expectUpstreamSaw,
  httpViaSockssProxy,
  originPort,
  socksConnectOverTls,
  sockss5InPort,
  stub,
} from "./matrix-fixture.js";

describe("H) sockss5 入站（TLS 承载 SOCKS5）× 六上游", () => {
  it.each(SIX_UPSTREAMS)(
    "上游 %s → sockss5 入站 200（目标收到 origin-ok）",
    async (proto, role, secure, kind) => {
      const s = await stub(role, secure);
      applyUpstream(
        proto as (typeof defaults)["upstreamProtocol"],
        s.port,
        secure ? CA : "",
        false,
      );
      const res = await httpViaSockssProxy(
        sockss5InPort,
        5,
        "127.0.0.1",
        originPort,
        "/sockss5-in",
      );
      expect(res.status, res.body).toBe(200);
      expect(res.body).toContain("origin-ok:/sockss5-in");
      expectUpstreamSaw(s, kind, `127.0.0.1:${originPort}`);
      // TLS 承载时「握手完成」本身就是字节级证据：桩只有握手成功才拿得到应用层字节
      if (secure) {
        expect(s.sessions(), "TLS 上游未完成握手").toHaveLength(1);
      }
    },
    20000,
  );

  it("上游 https 无 CA：sockss5 入站必须回 SOCKS5 失败应答（不挂死）", async () => {
    const s = await stub("https", true);
    applyUpstream("https", s.port, "", false);
    const res = await socksConnectOverTls(sockss5InPort, 5, "127.0.0.1", originPort);
    expect(res.ok).toBe(false);
    expect(res.rep).not.toBe(0x00);
  }, 20000);

  it("上游 sockss4 无 CA：sockss5 入站必须回 SOCKS5 失败应答（不挂死）", async () => {
    const s = await stub("socks4", true);
    applyUpstream("sockss4", s.port, "", false);
    const res = await socksConnectOverTls(sockss5InPort, 5, "127.0.0.1", originPort);
    expect(res.ok).toBe(false);
    expect(res.rep).not.toBe(0x00);
  }, 20000);

  it("上游 sockss5 无 CA：sockss5 入站必须回 SOCKS5 失败应答（不挂死）", async () => {
    const s = await stub("socks5", true);
    applyUpstream("sockss5", s.port, "", false);
    const res = await socksConnectOverTls(sockss5InPort, 5, "127.0.0.1", originPort);
    expect(res.ok).toBe(false);
    expect(res.rep).not.toBe(0x00);
  }, 20000);
});
