/**
 * 这一档钉合同⑤：上游拨不通时回 502 且发 `upstream-error` 事件（不挂死）——`settleDialFailure`
 * 的「超时 → 504、其余 → 502」那一半；超时那一半逐字锁在 `../http-via-socks.test.ts`。
 *
 * @module tests/integration/forward/contract
 * 目录级合同（出站形态那张表与三条决策）与目录清单见 `../AGENTS.md`；装配面见 `./fixture.js`。
 */
import { describe, expect, it } from "vitest";
import { set } from "../../../helpers/config.js";
import { getFreePort } from "../../../helpers/net.js";
import { collectPipe, rawRequest, setup, startProxy } from "./fixture.js";

describe("contract · ⑤ 上游失败分流", () => {
  it("上游拨不通：回 502 且发 upstream-error 事件（三条支路同一收尾）", async () => {
    setup();
    const dead = await getFreePort();
    const events = collectPipe();
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", dead);

    const proxyPort = await startProxy();
    const { status, text } = await rawRequest(
      proxyPort,
      "GET http://example.com/dead HTTP/1.1\r\nHost: h.example\r\n\r\n",
    );

    expect(status).toBe(502);
    expect(text).toContain("Bad Gateway");
    expect(
      events.some(
        (e) => e.type === "upstream-error" && String((e as { message?: string }).message).includes(`[http] upstream error 127.0.0.1:${dead}`),
      ),
      `实得事件：${JSON.stringify(events.map((e) => [e.type, (e as { message?: string }).message ?? ""]))}`,
    ).toBe(true);
  });
});