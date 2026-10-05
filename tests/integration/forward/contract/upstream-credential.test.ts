/**
 * 这一档钉合同④：上游凭证**只**经 http/https 上游注入 —— SOCKS 与直连绝不带
 * `Proxy-Authorization`（SOCKS 的凭证在握手里，直连压根没有上游）。
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
  setup,
  startProxy,
  startRaw,
  startSocks5Upstream,
  stopProxies,
  UPSTREAM_BASIC,
  UPSTREAM_PASS,
  UPSTREAM_USER,
} from "./fixture.js";

describe("contract · ④ 上游凭证只经 http/https 上游注入", () => {
  it("矩阵：配了上游账号时，http 上游带凭证、SOCKS 与直连都不带", async () => {
    setup();
    const origin = await startRaw(ORIGIN_REPLY);
    const httpUp = await startRaw(ORIGIN_REPLY);
    const socks = await startSocks5Upstream();
    set("upstreamUsername", UPSTREAM_USER);
    set("upstreamPassword", UPSTREAM_PASS);

    // (a) http 上游 → 上游收到凭证
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", httpUp.port);
    let proxyPort = await startProxy();
    await rawRequest(proxyPort, "GET http://example.com/a HTTP/1.1\r\nHost: h.example\r\n\r\n");
    expect(headers(httpUp.received().toString())["proxy-authorization"]).toBe(UPSTREAM_BASIC);

    // (b) socks5 上游 → 源站收不到凭证
    await stopProxies();
    set("upstreamProtocol", "socks5");
    set("upstreamPort", socks.port);
    proxyPort = await startProxy();
    await rawRequest(
      proxyPort,
      `GET http://127.0.0.1:${origin.port}/b HTTP/1.1\r\nHost: h.example\r\n\r\n`,
    );
    expect(headers(origin.received().toString())["proxy-authorization"]).toBeUndefined();

    // (c) 直连（server 模式）→ 源站收不到凭证
    await stopProxies();
    set("proxyMode", "server");
    proxyPort = await startProxy();
    await rawRequest(
      proxyPort,
      `GET http://127.0.0.1:${origin.port}/c HTTP/1.1\r\nHost: h.example\r\n\r\n`,
    );
    expect(headers(origin.received().toString())["proxy-authorization"]).toBeUndefined();
  }, 20000);
});