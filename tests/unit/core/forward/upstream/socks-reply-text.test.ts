/**
 * `readReply` 的两条报错文案：落盘日志文本，逐字不可改（文本面 + 行为面）
 *
 * @description
 * 它们**经 channel 的 catch 进落盘日志**，改文案即改日志文本：`expect(base.includes(new Error(
 * "<msg>"))` 逐字锁着，配两条行为面用例（对端提前关闭 reject / 沉默上游按 `upstreamTimeout`
 * 兜底并销毁 socket）—— 只锁文本会被「换个变量拼出来」绕过，只锁行为则漏掉文案改动。为什么
 * 它们归 SOCKS 基类、`readReply` 的可见性为何由编译期锁定，在 `AGENTS.md`。
 */
import { describe, expect, it } from "vitest";
import { PassThrough, type Duplex } from "node:stream";
import { Socks4Connector } from "@/core/forward/upstream/connector/index.js";
// 共享基类是连接器层内部件（刻意不进 barrel），测试按深路径直引
import { SocksUpstreamConnector } from "@/core/forward/upstream/connector/socks-upstream.js";
import { restoreConfig, set, snapshotConfig, testContext } from "../../../../helpers/config.js";
import { SOCKS_REPLY_ERRORS, forwardSourceOf } from "./_dialer-protocol-boundary.js";

/** 借原型取 protected 的 `readReply`（运行期它就是基类原型上的方法；只为断言其行为） */
function callReadReply(
  connector: SocksUpstreamConnector,
  sock: Duplex,
  n: number,
): Promise<Buffer> {
  return (
    SocksUpstreamConnector.prototype as unknown as {
      readReply(s: Duplex, bytes: number): Promise<Buffer>;
    }
  ).readReply.call(connector, sock, n);
}

describe("readReply 的两条报错文案（落盘日志文本，逐字不可改）", () => {
  it("两条文案逐字住在 SocksUpstreamConnector 源码里（2c 只搬位置、不动一个字）", () => {
    const base = forwardSourceOf("upstream", "connector", "socks-upstream.ts");

    for (const msg of SOCKS_REPLY_ERRORS) {
      expect(
        base.includes(`new Error("${msg}")`),
        `socks-upstream.ts 里的报错文案必须逐字是 ${JSON.stringify(msg)}（它经 channel 的 catch 进落盘日志）`,
      ).toBe(true);
    }
  });

  it("对端提前关闭 → reject「socks upstream closed before reply」（行为面，不只是文本）", async () => {
    const connector = new Socks4Connector(testContext, false);
    const sock = new PassThrough();
    const pending = callReadReply(connector, sock, 2);

    sock.destroy();
    await expect(pending).rejects.toThrow(SOCKS_REPLY_ERRORS[0]);
  });

  it("沉默上游 → 按 upstreamTimeout 兜底报「socks reply timeout」并销毁 socket", async () => {
    const snap = snapshotConfig(["upstreamTimeout"]);

    try {
      set("upstreamTimeout", 20);
      const connector = new Socks4Connector(testContext, false);
      const sock = new PassThrough();
      const pending = callReadReply(connector, sock, 2);

      await expect(pending).rejects.toThrow(SOCKS_REPLY_ERRORS[1]);
      expect(sock.destroyed, "读超时必须销毁已建链的上游（否则连接挂在守卫之外）").toBe(true);
    } finally {
      restoreConfig(snap);
    }
  });
});
