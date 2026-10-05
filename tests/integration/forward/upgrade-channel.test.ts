/**
 * `forward/channel/upgrade` 的「每请求恰好一条 `route` 事件」：SOCKS 上游 / http 上游 / 回落直连 /
 * server 模式直连 / 目标命中黑名单五种情形各钉一次条数与字段。
 *
 * 「恰好一条」是本档最要紧的断言（`viaSocks` 里那份 `emitRoute` 若还在，同一请求就发两条）；
 * 那一段推理与 `upgrade-self-loop.test.ts` 拆档前的共同出处都在 `./AGENTS.md`。
 *
 * 两档共用的装配面在 `./upgrade-fixture.ts`；⚠️ 「自环判定读的是 accessor 的 `host`/`port`、
 * 故必须与真实监听地址一致」那条的实现**只**住在它的 `withWsProxy`（调用方拿不到真实端口），
 * 抄一份进档就会立刻失效。
 *
 * @module tests/integration/forward
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAcl } from "@/datasource/acl/index.js";
import { aclLocatorFor } from "@/config/index.js";
import { getFreePort, sleep } from "../../helpers/net.js";
import { set, testConfig } from "../../helpers/config.js";
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

/** 轮询等待条件成立（避免固定 sleep 抖动） */
async function waitUntil(cond: () => boolean, ms = 3000, label = ""): Promise<void> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (cond()) {
      return;
    }

    await sleep(10);
  }

  throw new Error(`waitUntil 超时${label ? `：${label}` : ""}`);
}

describe("forward · upgrade-channel（每请求恰好一条 route 事件）", () => {
  beforeEach(prepareEach);

  afterEach(cleanupEach);

  it("SOCKS 上游：恰好一条（`mode=client` / `route=upstream` / 无 reason）", async () => {
    const stub = await upstreamStub("socks5");

    set("upstreamProtocol", "socks5");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", stub.port);

    await withWsProxy(async (port, events) => {
      // 桩不回 SOCKS 应答 → 握手读超时前会先拿到别的收尾；这里只等事件，断言不依赖桩行为
      void upgradeTo(port, DEST_HOST, DEST_PORT).catch(() => undefined);

      await waitUntil(
        () => ofType(events, "route").length > 0,
        3000,
        "SOCKS 上游的 route 事件",
      );
      // 多等一拍：给「第二条 route」留出机会（重复发是同步的，但事件分发在同一轮里）
      await sleep(120);

      const routes = ofType(events, "route");

      expect(routes, "每请求恰发一条 route").toHaveLength(1);
      expect(routes[0]).toMatchObject({
        target: `${DEST_HOST}:${DEST_PORT}`,
        mode: "client",
        route: "upstream",
      });
      expect(
        (routes[0] as { reason?: string }).reason,
        "未命中 upstream 路由名单 → 不带 reason（逐字不写键）",
      ).toBeUndefined();
    });
  });

  it("http 上游：恰好一条（`mode=client` / `route=upstream`）", async () => {
    const stub = await upstreamStub("https");

    set("upstreamProtocol", "http");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", stub.port);

    await withWsProxy(async (port, events) => {
      void upgradeTo(port, DEST_HOST, DEST_PORT).catch(() => undefined);

      await waitUntil(() => ofType(events, "route").length > 0, 3000, "http 上游的 route 事件");
      await sleep(120);

      const routes = ofType(events, "route");

      expect(routes, "每请求恰发一条 route").toHaveLength(1);
      expect(routes[0]).toMatchObject({
        target: `${DEST_HOST}:${DEST_PORT}`,
        mode: "client",
        route: "upstream",
      });
    });
  });

  it("直连（client 模式命中 upstream 路由名单回落）：恰好一条（`mode=server` / `route=direct` / 带 reason）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ws-single-path-"));

    try {
      set("aclFile", path.join(dir, "acl.json"));
      set("upstreamProtocol", "socks5");
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", await getFreePort());
      // 强制重读（跳过 1s 节流，等价于节流窗口已过）
      fs.writeFileSync(
        path.join(dir, "acl.json"),
        JSON.stringify({ upstream: { blacklist: [DEST_HOST] } }),
      );
      readAcl({ locator: aclLocatorFor(testConfig), force: true });

      await withWsProxy(async (port, events) => {
        void upgradeTo(port, DEST_HOST, DEST_PORT).catch(() => undefined);

        await waitUntil(() => ofType(events, "route").length > 0, 3000, "回落直连的 route 事件");
        await sleep(120);

        const routes = ofType(events, "route");

        expect(routes, "每请求恰发一条 route").toHaveLength(1);
        expect(routes[0]).toMatchObject({
          target: `${DEST_HOST}:${DEST_PORT}`,
          mode: "server",
          route: "direct",
          reason: "blacklist",
        });
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("server 模式直连：零条（`emitRoute` 对「server 且无 reason」短路，既有语义未变）", async () => {
    set("proxyMode", "server");
    set("upstreamProtocol", "socks5");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", await getFreePort());

    await withWsProxy(async (port, events) => {
      const res = await upgradeTo(port, DEST_HOST, DEST_PORT).catch(() => Buffer.alloc(0));

      // 直连一个不存在的目标 → 502（证明请求确实走到了拨号这一步）
      expect(res.toString()).toContain("502");
      expect(ofType(events, "route"), "server 模式短路不发 route").toHaveLength(0);
    });
  });

  it("目标命中黑名单：恰好一条 `target-denied`、零条 `route`（补判那次 preDial 不得重复发）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ws-single-path-"));
    const stub = await upstreamStub("socks5");

    try {
      set("aclFile", path.join(dir, "acl.json"));
      set("upstreamProtocol", "socks5");
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", stub.port);
      fs.writeFileSync(
        path.join(dir, "acl.json"),
        JSON.stringify({ target: { blacklist: [DEST_HOST] } }),
      );
      readAcl({ locator: aclLocatorFor(testConfig), force: true });

      await withWsProxy(async (port, events) => {
        const res = await upgradeTo(port, DEST_HOST, DEST_PORT);

        expect(res.toString()).toContain("403");
        expect(
          ofType(events, "target-denied"),
          "第一次 preDial 就拒了 → 补判那次根本没跑，事件不得重复发",
        ).toHaveLength(1);
        expect(ofType(events, "target-denied")[0]).toMatchObject({
          host: DEST_HOST,
          reason: "blacklist",
        });
        expect(ofType(events, "route"), "拒绝路径到不了 emitRoute").toHaveLength(0);
        expect(stub.connections(), "被拒的请求绝不建上游连接").toBe(0);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
