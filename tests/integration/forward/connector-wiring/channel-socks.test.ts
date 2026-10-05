/**
 * 这一档钉 `forward/channel/socks` 的接线：直连 / http 上游 / socks5 上游三条分支的守卫 route 文本
 * 逐字（真 `Socks5Proxy` + 裸 SOCKS5 客户端握手）。
 *
 * @module tests/integration/forward/connector-wiring
 * 目录级决策 ①–⑤ 与目录清单见 `../AGENTS.md`；装配面见 `./fixture.js`。
 */
import { describe, expect, it } from "vitest";
import { Socks5Proxy } from "@/core/server/socks5.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { set } from "../../../helpers/config.js";
import { getFreePort } from "../../../helpers/net.js";
import { withProxy } from "../../../helpers/proxy.js";
import { socks5ConnectIpv4, tcConnect } from "../../../helpers/socks-client.js";
import { collectPipe, guardError, readBytes, subs, waitUntil } from "./fixture.js";

describe("connector-wiring · forward/channel/socks", () => {
  /** 起一个真 Socks5Proxy，并把它的 pipe 事实收进数组 */
  async function withSocks5(
    fn: (port: number, events: PipeEvent[]) => Promise<void>,
  ): Promise<void> {
    const events: PipeEvent[] = [];

    subs.push(collectPipe((e) => events.push(e)));
    await withProxy(Socks5Proxy, {}, (port) => fn(port, events));
  }

  it("直连分支：route 文本带 `-> <host>:<port>` 目标尾巴", async () => {
    set("proxyMode", "server");
    const dead = await getFreePort();

    await withSocks5(async (port, events) => {
      const sock = await tcConnect(port);

      sock.write(Buffer.from([0x05, 0x01, 0x00]));
      await readBytes(sock, 2);
      sock.write(socks5ConnectIpv4("127.0.0.1", dead));
      await readBytes(sock, 10);

      await waitUntil(
        () => events.some((e) => e.type === "upstream-error"),
        3000,
        "socks 直连守卫事件",
      );
      expect(guardError(events, "[socks] error ")).toBe(`[socks] error 127.0.0.1 -> 127.0.0.1:${dead}`);
      sock.destroy();
    });
  });

  it("http 上游分支：route 带 `via <upstreamHost>:<upstreamPort>`（与既有形态逐字一致）", async () => {
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    const dead = await getFreePort();
    const dest = await getFreePort();
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", dead);

    await withSocks5(async (port, events) => {
      const sock = await tcConnect(port);

      sock.write(Buffer.from([0x05, 0x01, 0x00]));
      await readBytes(sock, 2);
      sock.write(socks5ConnectIpv4("127.0.0.1", dest));
      await readBytes(sock, 10);

      await waitUntil(
        () => events.some((e) => e.type === "upstream-error"),
        3000,
        "socks http 上游守卫事件",
      );
      expect(guardError(events, "[socks] error ")).toBe(
        `[socks] error 127.0.0.1 -> 127.0.0.1:${dest} via 127.0.0.1:${dead}`,
      );
      sock.destroy();
    });
  });

  it("socks 上游分支：route 补上了 `-> <host>:<port> via socks5 <upstream>`（净改进）", async () => {
    set("proxyMode", "client");
    set("upstreamProtocol", "socks5");
    const dead = await getFreePort();
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", dead);

    await withSocks5(async (port, events) => {
      const sock = await tcConnect(port);

      sock.write(Buffer.from([0x05, 0x01, 0x00]));
      await readBytes(sock, 2);
      sock.write(socks5ConnectIpv4("10.1.2.3", 8443));
      await readBytes(sock, 10);

      await waitUntil(
        () => events.some((e) => e.type === "upstream-error"),
        3000,
        "socks socks 上游守卫事件",
      );
      expect(guardError(events, "[socks] error ")).toBe(
        `[socks] error 127.0.0.1 -> 10.1.2.3:8443 via socks5 127.0.0.1:${dead}`,
      );
      sock.destroy();
    });
  });
});