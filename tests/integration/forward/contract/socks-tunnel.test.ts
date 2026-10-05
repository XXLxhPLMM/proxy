/**
 * 这一档钉合同③：经 SOCKS 隧道时 Host **无条件**回写为 `formatAuthority(dest.host, dest.port)`
 * 并强制 `Connection: close` —— 与②的「absolute-form 才回写」刻意是两种判据，不许顺手统一。
 *
 * @module tests/integration/forward/contract
 * 目录级合同（出站形态那张表与三条决策）与目录清单见 `../AGENTS.md`；装配面见 `./fixture.js`。
 */
import { describe, expect, it } from "vitest";
import { set } from "../../../helpers/config.js";
import {
  headers,
  ORIGIN_REPLY,
  rawRequest,
  requestLine,
  setup,
  startProxy,
  startRaw,
  startSocks5Upstream,
  UPSTREAM_PASS,
  UPSTREAM_USER,
} from "./fixture.js";

describe("contract · ③ SOCKS 隧道", () => {
  it("客户端发的 bogus Host 被无条件回写为真实目标 authority，并强制 Connection: close", async () => {
    setup();
    const origin = await startRaw(ORIGIN_REPLY);
    const socks = await startSocks5Upstream();
    set("proxyMode", "client");
    set("upstreamProtocol", "socks5");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", socks.port);
    set("upstreamUsername", UPSTREAM_USER);
    set("upstreamPassword", UPSTREAM_PASS);

    const proxyPort = await startProxy();
    const { status } = await rawRequest(
      proxyPort,
      `GET http://127.0.0.1:${origin.port}/via-socks HTTP/1.1\r\nHost: bogus-host.example\r\n\r\n`,
    );

    expect(status).toBe(200);

    const head = origin.received().toString();
    expect(requestLine(head)).toBe("GET /via-socks HTTP/1.1");

    const h = headers(head);
    // 无条件回写（与 ② 的「absolute-form 才回写」刻意不同）
    expect(h.host).toBe(`127.0.0.1:${origin.port}`);
    expect(h.connection).toBe("close");
    // ④ SOCKS 绝不带上游凭证（哪怕配了账号）——凭证在 SOCKS 握手里
    expect(h["proxy-authorization"]).toBeUndefined();
  });

  it("IPv6 目标：Host 回写补回方括号（`[::1]:port`，不是畸形的 `::1:port`）", async () => {
    setup();
    const origin = await startRaw(ORIGIN_REPLY, undefined, "::1");
    const socks = await startSocks5Upstream();
    set("proxyMode", "client");
    set("upstreamProtocol", "socks5");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", socks.port);

    const proxyPort = await startProxy();
    const { status } = await rawRequest(
      proxyPort,
      `GET http://[::1]:${origin.port}/v6 HTTP/1.1\r\nHost: bogus.example\r\n\r\n`,
    );

    expect(status).toBe(200);

    const h = headers(origin.received().toString());
    expect(h.host).toBe(`[::1]:${origin.port}`);
  });
});