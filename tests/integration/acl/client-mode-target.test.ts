/**
 * 这一档管 client 模式下的**目标名单语义**（`acl.json` 第二组）：判定对象是客户端请求的目标，
 * absolute-form 与 Host 两种形态、白名单只写站点即可、Upgrade 握手 Host 按目标回写。
 *
 * @module tests/integration/acl
 * 档级不变量（为什么上游不受名单约束、为什么 `ProxyOptions.access` 必填而直构 core 必须显式注入）
 * 见 `./AGENTS.md`；装配面见 `./client-mode-fixture.js`。
 */
import { describe, expect, it } from "vitest";
import { sleep } from "../../helpers/net.js";
import {
  rawRequest,
  upgradeHosts,
  upgradeReq,
  upstreamHits,
  withClientProxy,
  writeAcl,
} from "./client-mode-fixture.js";

describe("acl · client-mode-target（client 模式的目标名单语义）", () => {
  it("上游地址写进目标黑名单：不影响串联（名单不判上游）", async () => {
    writeAcl({ target: { blacklist: ["127.0.0.1", "::1"] } });

    await withClientProxy(async (port) => {
      const res = await rawRequest(
        port,
        "GET http://allowed.invalid/x HTTP/1.1\r\nHost: allowed.invalid\r\n\r\n",
      );
      expect(res.startsWith("HTTP/1.1 200")).toBe(true);
      expect(res).toContain("upstream-ok:");
      expect(upstreamHits).toBe(1);
    });
  });

  it("客户端目标命中黑名单：403 且不拨号（absolute-form 与 Host 两种形态一致）", async () => {
    writeAcl({ target: { blacklist: ["blocked.invalid"] } });

    await withClientProxy(async (port) => {
      // absolute-form：目标在 request-target 的 authority
      const abs = await rawRequest(
        port,
        "GET http://blocked.invalid/a HTTP/1.1\r\nHost: blocked.invalid\r\n\r\n",
      );
      expect(abs.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);

      // origin-form（本地应用不认代理协议时的典型形态）：目标只在 Host
      const origin = await rawRequest(port, "GET /b HTTP/1.1\r\nHost: blocked.invalid\r\n\r\n");
      expect(origin.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);

      expect(upstreamHits).toBe(0);
    });
  });

  it("目标白名单只写站点即可：上游地址不在名单里也照样串联", async () => {
    writeAcl({ target: { whitelist: ["allowed.invalid"] } });

    await withClientProxy(async (port) => {
      const ok = await rawRequest(
        port,
        "GET http://allowed.invalid/c HTTP/1.1\r\nHost: allowed.invalid\r\n\r\n",
      );
      expect(ok.startsWith("HTTP/1.1 200")).toBe(true);

      // 白名单非空且目标未命中 → 拒（上游在不在名单里与此无关）
      const denied = await rawRequest(
        port,
        "GET http://other.invalid/d HTTP/1.1\r\nHost: other.invalid\r\n\r\n",
      );
      expect(denied.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);
      expect(upstreamHits).toBe(1);
    });
  });

  it("WebSocket：名单判目标站点，握手 Host 按目标回写（不是上游地址）", async () => {
    writeAcl({ target: { whitelist: ["allowed.invalid"] } });

    await withClientProxy(async (port) => {
      const denied = await rawRequest(port, upgradeReq("blocked.invalid"));
      expect(denied.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);
      expect(upgradeHosts).toHaveLength(0);

      void rawRequest(port, upgradeReq("allowed.invalid"));
      for (let i = 0; i < 40 && upgradeHosts.length === 0; i++) {
        await sleep(25);
      }

      expect(upgradeHosts).toEqual(["allowed.invalid:80"]);
    });
  });
});