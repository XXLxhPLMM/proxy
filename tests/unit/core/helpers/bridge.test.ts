/**
 * `Dialer.bridge` 与 `guardDialing`：桥接透传、兜底写、失败时的两端归属
 *
 * @description
 * 真 `net.Server` 起在 `127.0.0.1` 的**端口 0** 上（本目录唯一起监听的几档 —— 「一端关闭带走
 * 另一端」「失败只断一端」只有真 socket 看得见）。双连接的腿法：`c1<->s1`（客户端腿）、
 * `c2<->s2`（上游腿），`guardDialing(c1, s2)`，**兜底写进 c1、读端是 s1** —— 读自己的那一端
 * 会撞 RST 竞态。
 *
 * ⚠️ 这两个模块**不住 `core/helpers/`**（归 `core/forward/upstream/dial.js` 与
 * `core/guard.js`），判据随模块走，故它们自己的档里也有一份对应的牙。
 */

import { describe, expect, it } from "vitest";
import net from "node:net";
import { Dialer } from "@/core/forward/upstream/dial.js";
import { guardDialing } from "@/core/guard.js";
import { testContext } from "../../../helpers/config.js";

// 双连接：c1<->s1（客户端腿），c2<->s2（上游腿）；guardDialing(c1, s2)
// 兜底写进 c1，读端是 s1，避免 RST 竞态
const mkLegs = async (): Promise<{
  c1: net.Socket;
  s1: net.Socket;
  s2: net.Socket;
  close: () => Promise<void>;
}> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const conns: net.Socket[] = [];
  server.on("connection", (s) => {
    s.on("error", () => {});
    conns.push(s);
  });
  const c1 = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => c1.once("connect", resolve));
  const c2 = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => c2.once("connect", resolve));
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (conns.length >= 2) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });
  const [s1, s2] = conns;
  for (const s of [c1, c2]) s.on("error", () => {});
  c2.destroy(); // c2 只用来占出第二条腿
  return {
    c1,
    s1,
    s2,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of [c1, s1, s2]) if (!s.destroyed) s.destroy();
        server.close(() => resolve());
      }),
  };
};

describe("Dialer.bridge 与 guardDialing", () => {
  it("Dialer.bridge 双向透传且一端关闭带走另一端", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
    const a = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => a.once("connect", resolve));
    const b = await accepted;
    for (const s of [a, b]) s.on("error", () => {});
    new Dialer(testContext).bridge(
      a as unknown as import("node:stream").Duplex,
      b as unknown as import("node:stream").Duplex,
    );

    const gotA = new Promise<string>((resolve) => a.once("data", (c) => resolve(c.toString())));
    b.write("hi-a");
    await expect(gotA).resolves.toContain("hi-a");

    const closedB = new Promise<void>((resolve) => b.once("close", resolve));
    a.destroy();
    await closedB;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("guardDialing 建链失败写兜底、建链后只断不断写", async () => {
    // 建链期上游 error -> 客户端腿收到兜底
    {
      const { c1, s1, s2, close } = await mkLegs();
      guardDialing(c1, s2, { logPrefix: "test", errorReply: "ERR-BOOM" });
      const data = new Promise<string>((resolve) => s1.once("data", (c) => resolve(c.toString())));
      s2.destroy(new Error("boom"));
      await expect(data).resolves.toContain("ERR-BOOM");
      await close();
    }

    // established 后上游 error -> 只断不断写
    {
      const { c1, s1, s2, close } = await mkLegs();
      const dial = guardDialing(c1, s2, { logPrefix: "test", errorReply: "ERR-BOOM" });
      dial.established();
      let leaked = "";
      s1.on("data", (c) => (leaked += c.toString()));
      const closedC1 = new Promise<void>((resolve) => c1.once("close", resolve));
      s2.destroy(new Error("boom"));
      await closedC1;
      expect(leaked).not.toContain("ERR-BOOM");
      await close();
    }
  });

  it("guardDialing keepClientOnFailure：失败只断上游，客户端留给调用方应答", async () => {
    // 置位：客户端必须存活且可写，否则调用方的 SOCKS 失败应答 / 502 写不出去
    {
      const { c1, s1, s2, close } = await mkLegs();
      guardDialing(c1, s2, {
        logPrefix: "test",
        timeoutReply: "",
        errorReply: "",
        keepClientOnFailure: true,
      });
      let got = "";
      s1.on("data", (c) => (got += c.toString()));
      s2.destroy(new Error("boom"));
      await new Promise((r) => setTimeout(r, 50));
      expect(c1.destroyed).toBe(false);
      c1.write("SOCKS-FAIL");
      await new Promise((r) => setTimeout(r, 50));
      expect(got).toBe("SOCKS-FAIL");
      await close();
    }

    // 未置位：空 reply 仍是连带销毁（Upgrade 等无报文可回场景），客户端应被关闭
    {
      const { c1, s2, close } = await mkLegs();
      guardDialing(c1, s2, { logPrefix: "test", timeoutReply: "", errorReply: "" });
      const closed = new Promise<void>((resolve) => c1.once("close", resolve));
      s2.destroy(new Error("boom"));
      await closed;
      expect(c1.destroyed).toBe(true);
      await close();
    }
  });
});