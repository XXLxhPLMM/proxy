/**
 * `forward/channel/upgrade` 的自环判定两侧：真实目标指回本代理的监听地址（SOCKS 隧道实际落点），
 * 与上游指回自身监听地址 —— 两者都必须在**拨号之前**拒（上游零建链）。
 *
 * `preDialPeerTarget` 不可删、不可短路的理由（只判上游自环就是真实的自环漏洞）与观测形态
 * 归 `./AGENTS.md`；两档共用的装配面归 `./upgrade-fixture.ts`（`set("port", port)` 那条自环锚点
 * 只住在它的 `withWsProxy` 里，抄一份进档就会立刻失效）。
 *
 * @module tests/integration/forward
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sleep } from "../../helpers/net.js";
import { set } from "../../helpers/config.js";
import {
  DEST_HOST,
  DEST_PORT,
  cleanupEach,
  ofType,
  prepareEach,
  upgradeTo,
  upstreamStub,
  withWsProxy,
} from "./upgrade-fixture.js";

describe("forward · upgrade-self-loop（自环判定：两侧都必须保住）", () => {
  beforeEach(prepareEach);

  afterEach(cleanupEach);

  it("真实目标自环：SOCKS 上游下客户端请求代理自己的监听地址 → 拒（502），且上游零建链", async () => {
    const stub = await upstreamStub("socks5");

    set("upstreamProtocol", "socks5");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", stub.port);

    await withWsProxy(async (port, events) => {
      // 目标 = 代理自己的监听地址（withWsProxy 已把 set("port") 钉成这个端口）
      const res = await upgradeTo(port, "127.0.0.1", port);
      await sleep(120);

      expect(
        res.toString(),
        "真实目标自环必须被拒（只判上游自环的话这条会被放行，客户端就能让本代理连回自己）",
      ).toContain("502");

      const loops = ofType(events, "loop-detected");

      expect(loops, "恰好一条 loop-detected").toHaveLength(1);
      expect(loops[0]).toMatchObject({ target: `127.0.0.1:${port}` });
      expect(stub.connections(), "自环必须在拨号之前拒：上游零建链").toBe(0);
      // 路由事件仍恰好一条（它在补判守卫之前发出）
      expect(ofType(events, "route"), "每请求恰发一条 route").toHaveLength(1);
    });
  });

  it("上游自环：SOCKS 上游指回代理自己的监听地址 → 拒（502）且在路由事件之前", async () => {
    set("upstreamProtocol", "socks5");

    await withWsProxy(async (port, events) => {
      // 上游 = 代理自己的监听地址；真实目标与它无关
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", port);

      const res = await upgradeTo(port, DEST_HOST, DEST_PORT);
      await sleep(120);

      expect(
        res.toString(),
        "2d 删掉了 viaSocks 里的 denyUpstreamLoop 调用，上游自环必须仍由第一次 preDial 判掉",
      ).toContain("502");

      const loops = ofType(events, "loop-detected");

      expect(loops, "恰好一条 loop-detected").toHaveLength(1);
      expect(loops[0]).toMatchObject({ target: `127.0.0.1:${port}` });
      expect(ofType(events, "route"), "被第一次 preDial 拒掉 → 到不了 emitRoute").toHaveLength(0);
    });
  });
});
