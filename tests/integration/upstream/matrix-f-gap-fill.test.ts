/**
 * 矩阵 `F) 补档：既有入站缺失的上游组合`：把 A)~E) 未覆盖的入站 × 上游格子补齐
 *
 * @module tests/integration/upstream
 *
 * 共用的桩 / 端口 / `beforeAll` 在 `./matrix-fixture.ts`；矩阵覆盖目标与分组索引见 `./AGENTS.md`。
 */

import { describe, expect, it } from "vitest";
import {
  CA,
  applyUpstream,
  expectUpstreamSaw,
  httpInPort,
  httpViaProxy,
  httpViaSocksProxy,
  httpsInPort,
  originPort,
  s4InPort,
  stub,
  tunnelViaProxy,
} from "./matrix-fixture.js";

describe("F) 补档：既有入站缺失的上游组合", () => {
  it("https 入站 × socks4 上游：absolute-form 经 SOCKS 隧道到源站", async () => {
    const s = await stub("socks4", false);
    applyUpstream("socks4", s.port, "", false);
    // socks 系上游必须用可达的本地源站（不是 example.com）
    const { status, body } = await httpViaProxy(
      httpsInPort,
      `http://127.0.0.1:${originPort}/https-in-socks4`,
      true,
    );
    expect(status, body).toBe(200);
    expect(body).toContain("origin-ok:/https-in-socks4");
    expectUpstreamSaw(s, "socks4-connect", `127.0.0.1:${originPort}`);
    // 字节级：上游首包必须是 SOCKS4 CONNECT 头
    expect(s.last()?.firstChunk[0]).toBe(0x04);
    expect(s.last()?.firstChunk[1]).toBe(0x01);
  }, 20000);

  it("https 入站 × sockss4 上游：TLS 承载的 SOCKS4 隧道到源站", async () => {
    const s = await stub("socks4", true);
    applyUpstream("sockss4", s.port, CA, false);
    const { status, body } = await httpViaProxy(
      httpsInPort,
      `http://127.0.0.1:${originPort}/https-in-sockss4`,
      true,
    );
    expect(status, body).toBe(200);
    expect(body).toContain("origin-ok:/https-in-sockss4");
    expectUpstreamSaw(s, "socks4-connect", `127.0.0.1:${originPort}`);
    // 字节级：TCP 首字节必须是 TLS ClientHello（0x16），明文 SOCKS4 头只会是 0x04
    expect(s.last()?.firstChunk[0]).toBe(0x04);
  }, 20000);

  it("socks4 入站 × socks5 上游：SOCKS4 入站 → SOCKS5 上游", async () => {
    const s = await stub("socks5", false);
    applyUpstream("socks5", s.port, "", false);
    const { status, body, rep } = await httpViaSocksProxy(
      s4InPort,
      4,
      "127.0.0.1",
      originPort,
      "/s4-in-socks5",
    );
    expect(status, body).toBe(200);
    expect(rep).toBe(0);
    expect(body).toContain("origin-ok:/s4-in-socks5");
    expectUpstreamSaw(s, "socks5-greeting", `127.0.0.1:${originPort}`);
    // 字节级：上游首包必须是 SOCKS5 greeting（0x05 0x01 0x00）
    expect([...s.last()!.firstChunk.subarray(0, 3)]).toEqual([0x05, 0x01, 0x00]);
  }, 20000);

  it("socks4 入站 × sockss5 上游：SOCKS4 入站 → TLS 承载的 SOCKS5 上游", async () => {
    const s = await stub("socks5", true);
    applyUpstream("sockss5", s.port, CA, false);
    const { status, body, rep } = await httpViaSocksProxy(
      s4InPort,
      4,
      "127.0.0.1",
      originPort,
      "/s4-in-sockss5",
    );
    expect(status, body).toBe(200);
    expect(rep).toBe(0);
    expect(body).toContain("origin-ok:/s4-in-sockss5");
    expectUpstreamSaw(s, "socks5-greeting", `127.0.0.1:${originPort}`);
    expect([...s.last()!.firstChunk.subarray(0, 3)]).toEqual([0x05, 0x01, 0x00]);
  }, 20000);

  it("http 入站 CONNECT × sockss4 上游：隧道经 TLS 承载的 SOCKS4 上游", async () => {
    const s = await stub("socks4", true);
    applyUpstream("sockss4", s.port, CA, false);
    const { status, body } = await tunnelViaProxy(
      httpInPort,
      `127.0.0.1:${originPort}`,
      "/tunnel-sockss4",
    );
    expect(status, body).toBe(200);
    expect(body).toContain("origin-ok:/tunnel-sockss4");
    expectUpstreamSaw(s, "socks4-connect", `127.0.0.1:${originPort}`);
  }, 20000);
});
