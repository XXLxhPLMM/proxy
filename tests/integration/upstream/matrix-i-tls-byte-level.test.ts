/**
 * 矩阵 `I) 真实 TLS 上游通路（字节级）`：TLS 承载的三个上游从 ClientHello 到应用层首包逐字节取证
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
  httpViaProxy,
  httpViaSocksProxy,
  originPort,
  s4InPort,
  s5InPort,
  stub,
  tunnelViaProxy,
} from "./matrix-fixture.js";

describe("I) 真实 TLS 上游通路（字节级）", () => {
  /**
   * 明文哑桩上的 ClientHello 字节级取证。
   *
   * 为什么必须反向取证：`tls.Server` 一 accept 就把裸 socket 包成 TLSSocket，
   * 握手字节在 handle 层被 TLS 解析器吃掉，桩上挂的 `data` 监听永不触发——
   * **真实 TLS 上游一侧拿不到首字节**（见 helpers/upstream-stub.ts 文件头）。
   * 于是把 TLS 承载的上游配置指向一个明文桩：桩收到的首字节必然是 0x16
   * （TLS handshake record），且凑不出任何一角色的应用层报文（`requestKind` 恒空）。
   * 桩回一段明文 HTTP 错误（`rejectWithPlaintext`），客户端握手立刻失败 → 502 而非干等超时。
   */
  it.each([
    ["https", () => httpViaProxy(httpInPort, "http://example.com/tls-mismatch")],
    [
      "sockss4",
      () => tunnelViaProxy(httpInPort, `127.0.0.1:${originPort}`, "/tls-mismatch"),
    ],
    [
      "sockss5",
      () => tunnelViaProxy(httpInPort, `127.0.0.1:${originPort}`, "/tls-mismatch"),
    ],
  ] as const)(
    "上游 %s 打到明文哑桩：只发出 ClientHello(0x16)、零应用层报文 → 502",
    async (proto, drive) => {
      const s = await stub("https", false, true);
      applyUpstream(proto, s.port, CA, false);
      const { status, body } = await drive();
      // 握手失配必须快速失败（502），绝不能挂到 upstreamTimeout
      expect(status, body).toBe(502);
      // 字节级：桩收到的第一个字节是 TLS handshake record 头 0x16
      expect(s.firstBytes()).toEqual([0x16]);
      // 且这段 TLS 里没有任何一角色的应用层报文（明文 HTTP 桩解析不出 CONNECT/SOCKS）
      expect(s.last()?.requestKind).toBe("");
      expect(s.sessions()).toHaveLength(1);
    },
    20000,
  );

  it("https 上游：real TLS 握手完成 + 上游收到 absolute-form（含正确目标与 Host）", async () => {
    const s = await stub("https", true);
    applyUpstream("https", s.port, CA, false);
    const url = "http://example.com/tls-real";
    const { status, body } = await httpViaProxy(httpInPort, url);
    expect(status, body).toBe(200);
    expect(body).toBe(`upstream-ok:${url}`);

    const facts = s.last();
    expect(facts).toBeDefined();
    // 传输层：真的完成了 TLS 握手（而不是明文套了个 https 端口）
    expect(facts?.protocol).toMatch(/^TLSv/);
    expect(facts?.cipher).not.toBe("");
    // 目标主机是 IP 字面量：按 RFC6066 置空 SNI（upstreamTlsOptions 的 servername 口径）
    expect(facts?.servername).toBe("");
    // 协议形态：absolute-form 请求行 + 正确的目标
    expect(facts?.requestKind).toBe("absolute-form");
    expect(facts?.requestLine).toBe(`GET ${url} HTTP/1.1`);
    expect(facts?.target).toBe("example.com:80");
    // 明文应用层首包首字节必须是 'G'（GET），不是 TLS 记录头 0x16
    expect(facts?.firstChunk[0]).toBe(0x47);
  }, 20000);

  it("sockss4 上游：real TLS 握手完成 + 上游收到 SOCKS4 CONNECT（含正确目标）", async () => {
    const s = await stub("socks4", true);
    applyUpstream("sockss4", s.port, CA, false);
    const { status, body } = await tunnelViaProxy(
      httpInPort,
      `127.0.0.1:${originPort}`,
      "/tls-sockss4",
    );
    expect(status, body).toBe(200);
    expect(body).toContain("origin-ok:/tls-sockss4");

    const facts = s.last();
    expect(facts?.protocol).toMatch(/^TLSv/);
    expect(facts?.cipher).not.toBe("");
    expect(facts?.servername).toBe("");
    // 协议形态：SOCKS4 CONNECT（VER=0x04 CMD=0x01），且目标三元组正确
    expect(facts?.requestKind).toBe("socks4-connect");
    expect(facts?.firstChunk[0]).toBe(0x04);
    expect(facts?.firstChunk[1]).toBe(0x01);
    expect(facts?.target).toBe(`127.0.0.1:${originPort}`);
  }, 20000);

  it("sockss5 上游：real TLS 握手完成 + 上游收到 SOCKS5 greeting（含正确目标）", async () => {
    const s = await stub("socks5", true);
    applyUpstream("sockss5", s.port, CA, false);
    const { status, body } = await tunnelViaProxy(
      httpInPort,
      `127.0.0.1:${originPort}`,
      "/tls-sockss5",
    );
    expect(status, body).toBe(200);
    expect(body).toContain("origin-ok:/tls-sockss5");

    const facts = s.last();
    expect(facts?.protocol).toMatch(/^TLSv/);
    expect(facts?.cipher).not.toBe("");
    expect(facts?.servername).toBe("");
    // 协议形态：SOCKS5 greeting（VER=0x05 NMETHODS=1 METHOD=0x00）
    expect(facts?.requestKind).toBe("socks5-greeting");
    expect([...facts!.firstChunk.subarray(0, 3)]).toEqual([0x05, 0x01, 0x00]);
    expect(facts?.target).toBe(`127.0.0.1:${originPort}`);
  }, 20000);

  it("TLS 上游 × SOCKS4 入站：真实握手 + 上游看到 socks4 CONNECT（跨入站承载）", async () => {
    const s = await stub("socks4", true);
    applyUpstream("sockss4", s.port, CA, false);
    const { status, body } = await httpViaSocksProxy(
      s4InPort,
      4,
      "127.0.0.1",
      originPort,
      "/s4-in-tls-sockss4",
    );
    expect(status, body).toBe(200);
    expect(body).toContain("origin-ok:/s4-in-tls-sockss4");
    expect(s.last()?.protocol).toMatch(/^TLSv/);
    expect(s.last()?.requestKind).toBe("socks4-connect");
    expect(s.last()?.target).toBe(`127.0.0.1:${originPort}`);
  }, 20000);

  it("TLS 上游 × SOCKS5 入站：真实握手 + 上游看到 socks5 greeting（跨入站承载）", async () => {
    const s = await stub("socks5", true);
    applyUpstream("sockss5", s.port, CA, false);
    const { status, body } = await httpViaSocksProxy(
      s5InPort,
      5,
      "127.0.0.1",
      originPort,
      "/s5-in-tls-sockss5",
    );
    expect(status, body).toBe(200);
    expect(body).toContain("origin-ok:/s5-in-tls-sockss5");
    expect(s.last()?.protocol).toMatch(/^TLSv/);
    expect(s.last()?.requestKind).toBe("socks5-greeting");
    expect(s.last()?.target).toBe(`127.0.0.1:${originPort}`);
  }, 20000);
});
