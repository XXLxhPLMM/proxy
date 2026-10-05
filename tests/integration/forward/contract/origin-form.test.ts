/**
 * 这一档钉合同②：`targetForm === "origin"`（直连源站）—— request-target 归一为 origin-form，
 * 且 Host 只在**客户端发 absolute-form** 时按 RFC 7230 §5.4 条件回写为该请求行的权威值。
 *
 * @module tests/integration/forward/contract
 * 目录级合同（出站形态那张表与三条决策）与目录清单见 `../AGENTS.md`；装配面见 `./fixture.js`。
 */
import { describe, expect, it } from "vitest";
import { set } from "../../../helpers/config.js";
import { headers, ORIGIN_REPLY, rawRequest, requestLine, setup, startProxy, startRaw } from "./fixture.js";

describe("contract · ② origin-form（直连源站）", () => {
  it("客户端发 absolute-form：request-target 归一为 origin-form，Host 按 §5.4 回写为权威值", async () => {
    setup();
    const origin = await startRaw(ORIGIN_REPLY);
    set("proxyMode", "server");

    const proxyPort = await startProxy();
    const { status } = await rawRequest(
      proxyPort,
      `GET http://127.0.0.1:${origin.port}/abs-direct HTTP/1.1\r\nHost: bogus-host.example\r\n\r\n`,
    );

    expect(status).toBe(200);

    const head = origin.received().toString();
    // origin-form（不是 `GET http://…`）
    expect(requestLine(head)).toBe("GET /abs-direct HTTP/1.1");
    // §5.4：absolute-form 的权威值来自 request-target，客户端那个 bogus Host 被覆盖
    expect(headers(head).host).toBe(`127.0.0.1:${origin.port}`);
  });

  it("客户端发 origin-form：request-target 与 Host 都原样透传（不回写）", async () => {
    setup();
    const origin = await startRaw(ORIGIN_REPLY);
    set("proxyMode", "server");

    const proxyPort = await startProxy();
    const { status } = await rawRequest(
      proxyPort,
      `GET /plain-direct HTTP/1.1\r\nHost: 127.0.0.1:${origin.port}\r\n\r\n`,
    );

    expect(status).toBe(200);

    const head = origin.received().toString();
    expect(requestLine(head)).toBe("GET /plain-direct HTTP/1.1");
    expect(headers(head).host).toBe(`127.0.0.1:${origin.port}`);
  });
});