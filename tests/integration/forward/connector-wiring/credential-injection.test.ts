/**
 * 这一档钉决策 ④ 的牙齿：上游凭证的注入判据**只**认连接器端口，upgrade 通道不得绕过端口自己读
 * config 或按 `kind` 推「对端是代理」——毒样本是那个 `kind:"https"` + `targetForm:"origin"` 的
 * 「隧道中继型」连接器（危害与「两条判据在今天的内置实现上等价 ≠ 两条判据是对的」那条推理随 `../AGENTS.md`）。
 *
 * @module tests/integration/forward/connector-wiring
 * 目录级决策 ①–⑤ 与目录清单见 `../AGENTS.md`；装配面见 `./fixture.js`。
 */
import { describe, expect, it } from "vitest";
import { WsForwarder } from "@/core/forward/channel/upgrade.js";
import { createConnectorSource } from "@/core/forward/upstream/connector/index.js";
import { set, testContext } from "../../../helpers/config.js";
import { getFreePort } from "../../../helpers/net.js";
import { makeCollector, tcConnect } from "../../../helpers/socks-client.js";
import {
  requestScope,
  startForwarder,
  startTcp,
  testServices,
  tunnelRelayConnector,
  waitUntil,
} from "./fixture.js";

describe("上游凭证的注入判据只认端口（两条通道逐字同源，都不读 config、不推 `kind`）", () => {
  it("「隧道中继型」连接器：Upgrade 报文必须是 origin-form，且绝不注入 Proxy-Authorization", async () => {
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    // **上游凭证配齐**：连接器替身明说「本次不给」（`upstreamAuthHeader() === undefined`），
    // 若通道侧仍绕过端口自己 `upstreamAuthValue(this.config)`，这条就会原样漏出去。
    // 配齐之后本用例才是真的在测「判据归谁」，而不是「恰好没配凭证所以看不见」。
    set("upstreamUsername", "upstream-user");
    set("upstreamPassword", "upstream-pass");
    // 有效的上游地址（永远拨不到：走上的是替身）——只为让 client 模式的 `dial` 有个值
    const dead = await getFreePort();

    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", dead);

    // 源站桩：回 101（顺带证明报文真的落到了「真实目标」并被桥接）
    const origin = await startTcp((sock) => {
      sock.on("data", (c: Buffer) => {
        if (c.includes(Buffer.from("\r\n\r\n"))) {
          sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
        }
      });
    });

    // ⚠️ 端口对 `kind` 与 `targetForm` **零约束**：这个替身**编译期就合法**（见替身注释）
    const relay = tunnelRelayConnector();
    const relayFwd = new WsForwarder(testContext, testServices(), {
      direct: () => createConnectorSource(testContext).direct(),
      upstream: () => relay,
    });

    // 客户端发 **absolute-form**（真实 client 模式客户端的形态）：这正是判据的分水岭——
    // 判成「对端是代理」就原样保留它，判成「对端是源站」就换成 origin-form。
    // 用 origin-form 的客户端请求写不出这两者的差别（两条分支产出同一串），所以必须绝对形态。
    const absoluteUrl = `http://127.0.0.1:${origin.port}/ws`;
    const req = {
      url: absoluteUrl,
      method: "GET",
      httpVersion: "1.1",
      headers: { host: `127.0.0.1:${origin.port}` },
      rawHeaders: [
        "Host",
        `127.0.0.1:${origin.port}`,
        "Upgrade",
        "websocket",
        "Connection",
        "Upgrade",
      ],
    };

    const fwd = await startForwarder(
      (r, socket, head) => relayFwd.handleUpgrade(r as never, socket, head, requestScope()),
      req,
    );

    try {
      const client = await tcConnect(fwd.port);
      const c = makeCollector(client);

      client.write(
        `GET ${absoluteUrl} HTTP/1.1\r\nHost: 127.0.0.1:${origin.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
      );
      // 101 证明报文确实送到了「真实目标」并被桥接——排除「压根没转发」那种假绿
      await c.waitFor((b) => b.includes(Buffer.from("101")), 3000);
      await waitUntil(() => origin.received().length > 0, 3000, "源站收到 Upgrade 报文");

      const received = origin.received().toString();

      // ① request-target 是 **origin-form**（对端是源站，不是 HTTP 代理）
      expect(received.split("\r\n")[0], "对端是源站 → 请求行必须是 origin-form").toBe(
        "GET /ws HTTP/1.1",
      );
      expect(received, "报文里不得残留 absolute-form 的 URL").not.toContain(absoluteUrl);

      // ② **绝不注入上游 Basic 凭证**——凭据只由 `connector.upstreamAuthHeader()` 决定
      expect(
        received.toLowerCase(),
        "上游凭证绝不发给非代理对端（端口说 undefined 就是 undefined）",
      ).not.toContain("proxy-authorization");
      expect(received, "凭证的 base64 片段也不许出现").not.toContain(
        Buffer.from("upstream-user:upstream-pass").toString("base64"),
      );

      // ③ Host 回写为真实目标 authority（证明报文确实是按「对端是源站」那套规则写的）
      expect(received.toLowerCase()).toContain(`host: 127.0.0.1:${origin.port}`);

      client.destroy();
    } finally {
      await fwd.close();
      await origin.close();
    }
  });
});