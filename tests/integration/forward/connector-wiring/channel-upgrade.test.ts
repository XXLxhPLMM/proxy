/**
 * 这一档钉 `forward/channel/upgrade` 的接线：守卫前缀恒为 `[upgrade]`（决策 ②）与 **全量** route
 * 文本 `<dest> via <upstream>`（决策 ③：client 模式也经连接器层，不许退回只报上游地址的「短」文本）。
 *
 * @module tests/integration/forward/connector-wiring
 * 目录级决策 ①–⑤ 与目录清单见 `../AGENTS.md`；装配面见 `./fixture.js`。
 */
import { describe, expect, it } from "vitest";
import type { PipeEvent } from "@/core/types/proxy.js";
import { set } from "../../../helpers/config.js";
import { getFreePort } from "../../../helpers/net.js";
import { makeCollector, tcConnect } from "../../../helpers/socks-client.js";
import {
  collectPipe,
  guardError,
  requestScope,
  startForwarder,
  subs,
  upgradeReq,
  wsFwd,
} from "./fixture.js";

describe("connector-wiring · forward/channel/upgrade", () => {
  it("经 socks5 上游：route 补上了 `-> <host>:<port> via socks5 <upstream>`（净改进）", async () => {
    set("proxyMode", "client");
    set("upstreamProtocol", "socks5");
    const dead = await getFreePort();
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", dead);
    const events: PipeEvent[] = [];
    subs.push(collectPipe((e) => events.push(e)));
    const fwd = await startForwarder(
      (req, socket, head) => wsFwd.handleUpgrade(req as never, socket, head, requestScope()),
      upgradeReq("target.example", 8443),
    );

    try {
      const client = await tcConnect(fwd.port);
      const c = makeCollector(client);

      await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
      expect(guardError(events, "[upgrade] error ")).toBe(
        `[upgrade] error 127.0.0.1 -> target.example:8443 via socks5 127.0.0.1:${dead}`,
      );
      client.destroy();
    } finally {
      await fwd.close();
    }
  });

  it("有效 client 经 http 上游（2c 改走 connector.transport()）：route 补上了 `-> <host>:<port> via <upstream>`（旧文本是各调点随手写的差异，非契约）", async () => {
    // 守卫 route 文本是 **全量形式** `<dest> via <upstream>`，与 http / tunnel 调点同源：
    // 只报 `${targets.dial.host}:${targets.dial.port}`（即上游地址本身）那种「短」文本是
    // 各调点随手写出来的差异，**不是契约**——它看不出客户端要访问谁，会抹掉排障线索。
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    const dead = await getFreePort();
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", dead);
    const events: PipeEvent[] = [];
    subs.push(collectPipe((e) => events.push(e)));
    const fwd = await startForwarder(
      (req, socket, head) => wsFwd.handleUpgrade(req as never, socket, head, requestScope()),
      upgradeReq("target.example", 8443),
    );

    try {
      const client = await tcConnect(fwd.port);
      const c = makeCollector(client);

      await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
      expect(guardError(events, "[upgrade] error ")).toBe(
        `[upgrade] error 127.0.0.1 -> target.example:8443 via 127.0.0.1:${dead}`,
      );
      client.destroy();
    } finally {
      await fwd.close();
    }
  });

  it("主路径回落直连（server 模式）：route 为 `-> <host>:<port>`，无上游尾巴", async () => {
    set("proxyMode", "server");
    const dead = await getFreePort();
    const events: PipeEvent[] = [];
    subs.push(collectPipe((e) => events.push(e)));
    const fwd = await startForwarder(
      (req, socket, head) => wsFwd.handleUpgrade(req as never, socket, head, requestScope()),
      upgradeReq("127.0.0.1", dead),
    );

    try {
      const client = await tcConnect(fwd.port);
      const c = makeCollector(client);

      await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
      expect(guardError(events, "[upgrade] error ")).toBe(
        `[upgrade] error 127.0.0.1 -> 127.0.0.1:${dead}`,
      );
      client.destroy();
    } finally {
      await fwd.close();
    }
  });
});