/**
 * 这一档钉 `forward/channel/tunnel` 的接线：三条上游支路的守卫 route 文本（逐字契约）+ 上游
 * CONNECT 回非 200 时 `refusal` 的**不断链透传**（响应头与余量逐字节写给客户端再断链）。
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
  connectReq,
  guardError,
  requestScope,
  startForwarder,
  startTcp,
  subs,
  tunnelFwd,
} from "./fixture.js";

describe("connector-wiring · forward/channel/tunnel", () => {
  it("直连：route 为 `<clientAddr> -> <host>:<port>`，不带任何上游尾巴", async () => {
    set("proxyMode", "server");
    const dead = await getFreePort();
    const events: PipeEvent[] = [];
    subs.push(collectPipe((e) => events.push(e)));
    const fwd = await startForwarder(
      (req, socket, head) => tunnelFwd.handleConnect(req as never, socket, head, requestScope()),
      connectReq("127.0.0.1", dead),
    );

    try {
      const client = await tcConnect(fwd.port);
      const c = makeCollector(client);

      await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
      expect(guardError(events, "[tunnel] error ")).toBe(
        `[tunnel] error 127.0.0.1 -> 127.0.0.1:${dead}`,
      );
      client.destroy();
    } finally {
      await fwd.close();
    }
  });

  it("经 http 上游：route 带 `via <upstreamHost>:<upstreamPort>`（与既有形态逐字一致）", async () => {
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    const dead = await getFreePort();
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", dead);
    const events: PipeEvent[] = [];
    subs.push(collectPipe((e) => events.push(e)));
    const fwd = await startForwarder(
      (req, socket, head) => tunnelFwd.handleConnect(req as never, socket, head, requestScope()),
      connectReq("target.example", 8443),
    );

    try {
      const client = await tcConnect(fwd.port);
      const c = makeCollector(client);

      await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
      expect(guardError(events, "[tunnel] error ")).toBe(
        `[tunnel] error 127.0.0.1 -> target.example:8443 via 127.0.0.1:${dead}`,
      );
      client.destroy();
    } finally {
      await fwd.close();
    }
  });

  it("经 socks5 上游：route 带 `via socks5 <upstreamHost>:<upstreamPort>`（与既有形态逐字一致）", async () => {
    set("proxyMode", "client");
    set("upstreamProtocol", "socks5");
    const dead = await getFreePort();
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", dead);
    const events: PipeEvent[] = [];
    subs.push(collectPipe((e) => events.push(e)));
    const fwd = await startForwarder(
      (req, socket, head) => tunnelFwd.handleConnect(req as never, socket, head, requestScope()),
      connectReq("target.example", 8443),
    );

    try {
      const client = await tcConnect(fwd.port);
      const c = makeCollector(client);

      await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
      expect(guardError(events, "[tunnel] error ")).toBe(
        `[tunnel] error 127.0.0.1 -> target.example:8443 via socks5 127.0.0.1:${dead}`,
      );
      client.destroy();
    } finally {
      await fwd.close();
    }
  });

  it("refusal 透传：上游 CONNECT 回 407 时响应头+余量逐字节写给客户端再断链（不断链语义）", async () => {
    set("proxyMode", "client");
    set("upstreamProtocol", "http");

    const head =
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="up"\r\n\r\n';
    const rest = "denied-by-upstream";
    // 假上游：读到完整 CONNECT 请求头后回 head+rest（rest 是响应头之后的先发字节）
    const upstream = await startTcp((sock) => {
      let buf = Buffer.alloc(0);
      const onData = (c: Buffer): void => {
        buf = Buffer.concat([buf, c]);

        if (buf.indexOf("\r\n\r\n") === -1) {
          return;
        }

        sock.off("data", onData);
        sock.write(head + rest);
      };
      sock.on("data", onData);
    });
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", upstream.port);

    const events: PipeEvent[] = [];
    subs.push(collectPipe((e) => events.push(e)));
    const fwd = await startForwarder(
      (req, socket, head2) => tunnelFwd.handleConnect(req as never, socket, head2, requestScope()),
      connectReq("target.example", 8443),
    );

    try {
      const client = await tcConnect(fwd.port);
      const c = makeCollector(client);

      // 逐字节：Proxy-Authenticate 必须送达客户端，且余量不得被吞
      await c.waitFor((b) => b.includes(Buffer.from(rest)), 3000);
      expect(c.bytes().toString()).toBe(head + rest);
      // refusal 不是建链成功：绝不能回 200，绝不能建隧
      expect(c.bytes().toString()).not.toContain("200 Connection Established");
      // 断链语义：写完即断
      await c.waitClose(2000);
      // refusal 不是拨号失败：不得回自己的 502/504，也不得发 upstream-error
      expect(c.bytes().toString()).not.toContain("502");
      expect(c.bytes().toString()).not.toContain("504");
      expect(events.filter((e) => e.type === "upstream-error")).toHaveLength(0);
      client.destroy();
    } finally {
      await fwd.close();
      await upstream.close();
    }
  });
});