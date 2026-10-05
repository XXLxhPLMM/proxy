/**
 * 失败路径：**拨号失败必须 reject（不吞），且向 client 一个字节都不写**
 *
 * @description
 * 两条决策：① 四个连接器拨不通上游时一律 reject 且不向 `client` 写任何字节（`keepClientOnFailure`
 * 是契约的一部分：失败后 client 仍活着，收尾留给 channel）；② `sockss*` 的 TLS 承载由构造参数
 * `secure` 决定，明文哑上游只会收到 TLS ClientHello（首字节 `0x16`），沉默上游按 `upstreamTimeout`
 * 兜底抛 `DialTimeoutError` 且 `logPrefix` 透传到守卫事件。三档共用纪律在 `AGENTS.md`。
 */
import { describe, expect, it } from "vitest";
import net from "node:net";
import {
  DirectConnector,
  HttpConnectConnector,
  Socks4Connector,
  Socks5Connector,
  type OpenContext,
  type UpstreamConnector,
} from "@/core/forward/upstream/connector/index.js";
import { DialTimeoutError } from "@/core/forward/upstream/dial.js";
import type { HelperEvent } from "@/core/guard.js";
import { restoreConfig, set, snapshotConfig, testContext } from "../../../../../helpers/config.js";
import { getFreePort, listen } from "../../../../../helpers/net.js";
import { DEST, makeClient } from "./_connector-open.js";

/** 组装 OpenContext（测试侧只提供 `onEvent`/`logPrefix`/`dest`，其余给缺省） */
function openCtx(partial: Partial<OpenContext> & { client: OpenContext["client"]; dest: OpenContext["dest"] }) {
  const events: HelperEvent[] = [];

  return {
    events,
    ctx: {
      onEvent: (e: HelperEvent) => events.push(e),
      ...partial,
    } as OpenContext,
  };
}

const closeServer = (server: net.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

describe("core/forward/upstream/connector 拨号失败", () => {
  it("四个连接器拨不通上游时一律 reject，且不向 client 写任何字节", async () => {
    const dead = await getFreePort();
    const prev = snapshotConfig(["upstreamHost", "upstreamPort"]);
    const { client, seen } = makeClient();

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);

      const cases: { name: string; make: () => UpstreamConnector; dest: OpenContext["dest"] }[] = [
        {
          name: "direct",
          make: () => new DirectConnector(testContext),
          dest: { host: "127.0.0.1", port: dead },
        },
        {
          name: "http-connect",
          make: () => new HttpConnectConnector(testContext, false),
          dest: DEST,
        },
        {
          name: "socks4",
          make: () => new Socks4Connector(testContext, false),
          dest: DEST,
        },
        {
          name: "socks5",
          make: () => new Socks5Connector(testContext, false),
          dest: DEST,
        },
      ];

      for (const c of cases) {
        await expect(
          c.make().open({ client, dest: c.dest, onEvent: () => {}, logPrefix: "tunnel" }),
          `${c.name} 拨号失败必须 reject`,
        ).rejects.toThrow();
      }

      expect(seen).toHaveLength(0);
      // keepClientOnFailure：失败后 client 仍活着，收尾留给 channel 写自己的失败应答
      expect(client.destroyed).toBe(false);
    } finally {
      restoreConfig(prev);
    }
  });

  it("sockss* 走 TLS 承载：明文哑上游只会收到 TLS ClientHello，且沉默上游按 upstreamTimeout 兜底", async () => {
    const firstByte: number[] = [];
    const server = net.createServer((sock) => {
      sock.on("error", () => {});
      sock.on("data", (chunk: Buffer) => {
        if (firstByte.length === 0) {
          firstByte.push(chunk[0]);
        }
        // 沉默：不回任何字节，逼 upstreamTimeout 兜底
      });
    });

    const port = await getFreePort();

    await listen(server, port);

    const prev = snapshotConfig(["upstreamHost", "upstreamPort", "upstreamTimeout"]);
    const { client } = makeClient();
    const { ctx, events } = openCtx({ client, dest: DEST, logPrefix: "sockss" });

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", port);
      set("upstreamTimeout", 1200);

      await expect(new Socks5Connector(testContext, true).open(ctx)).rejects.toThrow(
        DialTimeoutError,
      );

      // TLS record 首字节固定 0x16（handshake）
      expect(firstByte).toEqual([0x16]);
      // logPrefix 必须透传到守卫事件（`[sockss] timeout ...`）
      expect(
        events.some(
          (e) => e.type === "upstream-timeout" && e.message.startsWith("[sockss] timeout"),
        ),
      ).toBe(true);
    } finally {
      restoreConfig(prev);
      await closeServer(server);
    }
  });
});
