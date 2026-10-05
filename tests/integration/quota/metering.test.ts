/**
 * 计量落点：usage 的 up/down 必须等于**建链后流动的真实字节**，建链协议字节与 HTTP 头都不计入。
 *
 * @description
 * 六条落点路径（CONNECT / CONNECT 首包 / SOCKS5 握手 / HTTP 双向 / 零体）与「HTTP 头两侧各少算
 * 一个头」那个**已知不对称**的量化说明归 `./AGENTS.md`；装配面（三个目标桩与四组 hook）见
 * `./quota-fixture.js`。本档只钉「实测值 = 期望值」这一层。
 *
 * @module tests/integration/quota
 */
import { describe, expect, it } from "vitest";
import { HttpProxy } from "@/core/server/http.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import { withProxy } from "../../helpers/proxy.js";
import { makeCollector, rfc1929, socks5ConnectIpv4, tcConnect } from "../../helpers/socks-client.js";
import {
  ALICE,
  ALICE_PW,
  TARGET_IP,
  account,
  exceeded,
  origin,
  proxyOpts,
  proxyRequest,
  raw,
  tunnelPayload,
  tunnelPipelinedHead,
} from "./quota-fixture.js";

describe("quota/metering（计量落点正确性：真字节，不用 mock）", () => {
  it("隧道路径（CONNECT）：usage 的 up/down 与真实传输字节逐字节相等，且不含建链协议字节", async () => {
    const payload = Buffer.alloc(4096, 0x41); // "A"
    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      const r = await tunnelPayload(port, raw.port, ALICE, ALICE_PW, payload);
      expect(r.established, "CONNECT 必须先回 200").toBe(true);
      expect(r.sent).toBe(4096);
      expect(r.echoed).toBe(4096);
    });

    // 精确：裸 socket 路径上客户端首包与响应余量都经过 socket，两个方向都逐字节精确
    // （usage 是**合计**数：4096 上传 + 4096 下载）
    expect(account.usage(ALICE)).toBe(8192);
    // 建链协议字节**不**计入：CONNECT 请求行+请求头+`200 Connection Established`
    // 一共约 130 字节，若被误计 usage 会明显大于两方向载荷之和
    expect(account.usage(ALICE)).toBeLessThan(8192 + 1024);
    expect(exceeded(), "未耗尽时零发布").toHaveLength(0);
  });

  it("建隧后的首批载荷（`head`：客户端 CONNECT 头之后的首包）也计入 —— 经 meter.charge 补记", async () => {
    // 这条覆盖的是**另一条**落点：CONNECT 请求头与载荷同一次写出去时，载荷被 Node 的解析器
    // 摘进 `head`，**不再触发 socket 的 data 事件**，故只能由 `bridgeWithBuffered` 显式补记。
    // 少了这一步 `usage.up` 会是 0（已用变异测试验证：临时去掉 head 补记 → 本条立刻变红）。
    const payload = Buffer.alloc(3000, 0x4a); // "J"
    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      const r = await tunnelPipelinedHead(port, raw.port, ALICE, ALICE_PW, payload);
      expect(r.established, "CONNECT 必须先回 200").toBe(true);
      expect(r.echoed, "回声应逐字节回来").toBe(3000);
    });
    expect(account.usage(ALICE)).toBe(3000 + 3000);
    expect(exceeded()).toHaveLength(0);
  });

  it("SOCKS5 路径：握手往返（greeting/认证/CONNECT 应答）不计入，只有载荷计入", async () => {
    const payload = Buffer.alloc(2048, 0x42);
    await withProxy(Socks5Proxy, proxyOpts(), async (port) => {
      const sock = await tcConnect(port);
      const c = makeCollector(sock);
      sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      await c.waitFor((b) => b.length >= 2, 3000);
      sock.write(rfc1929(ALICE, ALICE_PW));
      await c.waitFor((b) => b.length >= 4, 3000);
      sock.write(socks5ConnectIpv4(TARGET_IP, raw.port));
      await c.waitFor((b) => b.length >= 14, 3000);
      // 握手协议字节（≥14）先落地，随后才是载荷
      sock.write(payload);
      await c.waitFor((b) => b.length >= 14 + payload.length, 5000);
      sock.destroy();
    });

    expect(account.usage(ALICE)).toBe(2048 + 2048);
    expect(exceeded()).toHaveLength(0);
  });

  it("HTTP 普通转发：usage 精确等于请求体/响应体字节数（HTTP 头两侧都不计入，已量化说明）", async () => {
    const body = Buffer.alloc(1500, 0x43);
    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      const r = await proxyRequest(port, origin.port, ALICE, ALICE_PW, {
        method: "POST",
        path: "/updown",
        body,
      });
      expect(r.status).toBe(200);
      expect(r.got).toBe(64);
    });

    // **不对称（诚实记录，不假装两侧对称）**：
    // `up` 少算请求行+请求头（本次约 120B），`down` 少算状态行+响应头（本次约 100B）。
    // Node 的 IncomingMessage 流只覆盖消息体，两个方向的 HTTP 头都是 Node 直接写进 socket 的。
    // 故这里断言的是**消息体字节数逐字节相等**，头的差额在 `core/quota-meter.ts` 里量化。
    expect(account.usage(ALICE)).toBe(1500 + 64);
    // 源站侧实测也一致（证明代理没有凭空多算/少算载荷）
    expect(origin.bodyIn("updown")).toBe(1500);
    expect(origin.bodyOut("updown")).toBe(64);
    expect(exceeded()).toHaveLength(0);
  });

  it("HTTP 普通转发：零体请求不产生任何计量（GET 只有响应体计入 down）", async () => {
    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      expect((await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/n0?n=0" })).status).toBe(
        200,
      );
    });
    expect(account.usage(ALICE)).toBe(0);

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      expect((await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/n1?n=777" })).got).toBe(
        777,
      );
    });
    expect(account.usage(ALICE)).toBe(777);
  });
});
