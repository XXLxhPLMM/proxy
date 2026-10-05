/**
 * 这一档钉「有效路由是 direct 时必须走 `connectors.direct()` 而不是 `connectors.upstream()`」：
 * 判别靠**双桩互斥**（真目标桩与上游代理桩同时在跑，拨了谁一目了然）+ 配 `upstream` 路由名单让
 * client 模式请求回落 direct（CONNECT / Upgrade / SOCKS 三条通道各一条）。
 *
 * @module tests/integration/forward/connector-wiring
 * 目录级决策 ①–⑤ 与目录清单见 `../AGENTS.md`；装配面见 `./fixture.js`。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAcl } from "@/datasource/acl/index.js";
import { aclLocatorFor } from "@/config/index.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { set, testConfig } from "../../../helpers/config.js";
import { withProxy } from "../../../helpers/proxy.js";
import { makeCollector, socks5ConnectIpv4, tcConnect } from "../../../helpers/socks-client.js";
import type { Tcp } from "./fixture.js";
import {
  collectPipe,
  connectReq,
  fileAccess,
  readBytes,
  requestScope,
  startForwarder,
  startTcp,
  subs,
  tunnelFwd,
  upgradeReq,
  waitUntil,
  wsFwd,
} from "./fixture.js";

describe("连接器选择（有效路由 direct ⟺ directConnector）", () => {
  let dir: string;
  let aclPath: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-connector-wiring-"));
    aclPath = path.join(dir, "acl.json");
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 写 acl.json 并强制重读（跳过 1s 节流，等价于节流窗口已过） */
  function writeAcl(acl: unknown): void {
    set("aclFile", aclPath);
    fs.writeFileSync(aclPath, JSON.stringify(acl));
    readAcl({ locator: aclLocatorFor(testConfig), force: true });
  }

  /**
   * 造「真目标桩 + 上游代理桩」一对：拨了谁由 `received()` 判别。
   * 上游桩刻意选 sockss5 承载的 `sockss5` 协议：它是**代理型**连接器，
   * 若接线误用 `connectorFor` 就一定会去拨它（明文握手首字节 0x05 一眼可辨）。
   */
  async function startPair(): Promise<{ target: Tcp; upstream: Tcp }> {
    const target = await startTcp();
    const upstream = await startTcp((sock) => {
      // 假 SOCKS5 上游：应请求就应答（这样「误走上游」会表现为真目标没收到任何字节）
      let stage: "method" | "connect" = "method";
      sock.on("data", () => {
        if (stage === "method") {
          stage = "connect";
          sock.write(Buffer.from([0x05, 0x00]));
          return;
        }

        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      });
    });

    return { target, upstream };
  }

  it("CONNECT：client 模式 + upstream 路由名单命中 → 直拨真目标，上游桩零字节", async () => {
    writeAcl({ upstream: { blacklist: ["127.0.0.1"] } });
    set("proxyMode", "client");
    set("upstreamProtocol", "socks5");
    const { target, upstream } = await startPair();
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", upstream.port);

    const fwd = await startForwarder(
      (req, socket, head) => tunnelFwd.handleConnect(req as never, socket, head, requestScope()),
      connectReq("127.0.0.1", target.port),
    );

    try {
      const client = await tcConnect(fwd.port);
      const c = makeCollector(client);

      client.write("probe-through-tunnel");
      await c.waitFor((b) => b.includes(Buffer.from("200 Connection Established")), 3000);
      // 探针经隧道到达真目标 = 走的是 directConnector
      await waitUntil(
        () => target.received().includes(Buffer.from("probe-through-tunnel")),
        3000,
        "真目标收到探针",
      );
      expect(target.received().length).toBeGreaterThan(0);
      // 上游桩一个字节都没收到 = 绝没有走 connectorFor
      expect(upstream.received().length).toBe(0);
      client.destroy();
    } finally {
      await fwd.close();
      await target.close();
      await upstream.close();
    }
  });

  it("WebSocket：client 模式 + upstream 路由名单命中 → 直拨真目标并等 101，上游桩零字节", async () => {
    writeAcl({ upstream: { blacklist: ["127.0.0.1"] } });
    set("proxyMode", "client");
    set("upstreamProtocol", "socks5");
    // 真目标会回 101（裸状态行 + CRLFCRLF 即可，relay 不校验 Upgrade 头）
    const target = await startTcp((sock) => {
      sock.on("data", (c: Buffer) => {
        if (c.includes(Buffer.from("\r\n\r\n"))) {
          sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
        }
      });
    });
    const upstream = await startTcp((sock) => {
      let stage: "method" | "connect" = "method";
      sock.on("data", () => {
        if (stage === "method") {
          stage = "connect";
          sock.write(Buffer.from([0x05, 0x00]));
          return;
        }

        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      });
    });
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", upstream.port);

    const fwd = await startForwarder(
      (req, socket, head) => wsFwd.handleUpgrade(req as never, socket, head, requestScope()),
      upgradeReq("127.0.0.1", target.port),
    );

    try {
      const client = await tcConnect(fwd.port);
      const c = makeCollector(client);

      client.write("GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n\r\n");
      await c.waitFor((b) => b.includes(Buffer.from("101")), 3000);
      // origin-form + Host 回写真实目标（不是上游地址）
      await waitUntil(
        () => target.received().includes(Buffer.from("Host: 127.0.0.1")),
        3000,
        "真目标收到 Upgrade",
      );
      expect(target.received().toString().startsWith("GET /ws HTTP/1.1")).toBe(true);
      // 绝不带上游凭证头
      expect(target.received().toString().toLowerCase()).not.toContain("proxy-authorization");
      expect(upstream.received().length).toBe(0);
      client.destroy();
    } finally {
      await fwd.close();
      await target.close();
      await upstream.close();
    }
  });

  it("SOCKS：client 模式 + upstream 路由名单命中 → 直拨真目标并回成功应答，上游桩零字节", async () => {
    writeAcl({ upstream: { blacklist: ["127.0.0.1"] } });
    set("proxyMode", "client");
    set("upstreamProtocol", "socks5");
    const { target, upstream } = await startPair();
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", upstream.port);

    const events: PipeEvent[] = [];

    subs.push(collectPipe((e) => events.push(e)));
    await withProxy(Socks5Proxy, { access: fileAccess }, async (port) => {
      const sock = await tcConnect(port);

      sock.write(Buffer.from([0x05, 0x01, 0x00]));
      await readBytes(sock, 2);
      sock.write(socks5ConnectIpv4("127.0.0.1", target.port));

      const reply = await readBytes(sock, 10);

      // 成功应答（REP=0x00）；误走 connectorFor 时真目标收不到任何字节
      expect(reply[1]).toBe(0x00);
      sock.write("probe-through-socks");
      await waitUntil(
        () => target.received().includes(Buffer.from("probe-through-socks")),
        3000,
        "真目标收到探针",
      );
      expect(upstream.received().length).toBe(0);
      sock.destroy();
    });
  });
});