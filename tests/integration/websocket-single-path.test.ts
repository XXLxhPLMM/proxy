/**
 * @fileoverview `forward/websocket` 的「单一路径」接线护栏（Phase 2d）
 *
 * @description
 * 2d 删掉了 {@link WsForwarder.handle} 里最后一处上游协议分支（「client + socks 上游」早分支：
 * 目标尚未解析就自行 `resolveRoute`）。本文件锁三件**删掉它之后最容易悄悄丢**的东西：
 *
 * 1. **每请求恰好一条 `route` 事件**（SOCKS 上游 / http(s) 上游 / 直连三种情形各一条）。
 *    早分支把 `resolveRoute`/`preDial`/`emitRoute` 塞在 `viaSocks` 内部，与另外三条通道的
 *    事件顺序不同；统一后顺序变成和其它通道一样——**这是收敛、不是 bug**。但只要
 *    `viaSocks` 里的那份 `emitRoute` 没一并删掉，同一条请求就会发**两条** `route`
 *    （`[route]` 落盘行也跟着翻倍），所以这条「恰好一条」是本切片最要紧的断言。
 *    顺带钉住 `emitRoute` 仍会短路的那一档：server 模式直连**零条**（既有语义，未变）。
 * 2. **真实目标的自环判定没被丢**（本切片的核心护栏）。统一后 `preDial` 判的 `dial` 在
 *    client 模式下是**上游**；SOCKS 隧道实际落到**真实目标**。若只跑一次 `preDial`，
 *    「客户端请求代理自己的监听地址」这条自环根本没人看——客户端就能让本代理经 SOCKS
 *    隧道连回自己。保住它的是 `handle` 里「`peerTarget(dest) !== targets.dial` 才补判一次
 *    preDial」那条（与 `http.handle` 同源）。
 * 3. **上游自环判定也没被丢**（2d 同时删掉了 `viaSocks` 里的 `denyUpstreamLoop` 调用）：
 *    上游指回自身监听地址必须仍被拒，且**在拨号之前**拒（零建链）。
 *
 * 观测手段：真 `HttpProxy` + 裸 socket 手写 Upgrade 请求（与 `forwarder-connector-wiring`
 * 同形——这几项要观察转发器入口的守卫事件与原始状态行报文，套真 server 反而会掺进
 * `HttpProxy` 的 ACL/鉴权判定之外的东西）。自环判定读的是 accessor 的 `host`/`port`，
 * 故必须与真实监听地址一致（本文件用 `set("port", <真实端口>)` 钉住）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAcl } from "@/config/index.js";
import { HttpProxy } from "@/core/server/http.js";
import type { EventHub, EventSubscription } from "@/core/events/index.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { EventHub as Hub } from "@/core/events/index.js";
import { getFreePort, sleep } from "../helpers/net.js";
import { makeCollector, tcConnect } from "../helpers/socks-client.js";
import { startUpstreamStub, type UpstreamStub } from "../helpers/upstream-stub.js";
import {
  restoreConfig,
  set,
  silenceLogs,
  snapshotConfig,
  testConfig,
  testLogger,
} from "../helpers/config.js";
import type { CoreContext } from "@/core/context.js";

/** 本文件自建一条总线（往共享测试总线上挂长期订阅会跨用例累积） */
const bus: EventHub = new Hub({ onListenerError: () => undefined });
const ctx: CoreContext = { config: testConfig, logger: testLogger, events: bus };

/** 本文件涉及的配置键（逐键快照/恢复，不依赖生产全局 store） */
const KEYS = [
  "aclFile",
  "authEnabled",
  "authType",
  "host",
  "port",
  "proxyMode",
  "upstreamHost",
  "upstreamPort",
  "upstreamProtocol",
  "upstreamTimeout",
  "logLevel",
  "logFile",
] as const;

/** 客户端请求的目标（非本机，避免与自环判定混淆） */
const DEST_HOST = "target.example";
const DEST_PORT = 8443;

/** 取某一类事件的全部载荷（按 `type` 过滤） */
function ofType(events: PipeEvent[], type: PipeEvent["type"]): PipeEvent[] {
  return events.filter((e) => e.type === type);
}

/**
 * 起一个真 `HttpProxy` 并把它的 pipe 事实收进数组
 *
 * @description
 * `set("port", port)` 是**必需**的：`isSelfLoopAddr` 的判据是
 * `destHost:destPort` vs 配置里的 `host`/`port`，而真实监听端口由 `withProxy` 内部随机取、
 * 调用方拿不到。这里自己取端口再构造，两边就一致了。
 */
async function withWsProxy(
  fn: (port: number, events: PipeEvent[]) => Promise<void>,
): Promise<void> {
  const events: PipeEvent[] = [];
  const sub: EventSubscription = bus.subscribe("pipe", (e) => events.push(e.data));
  const port = await getFreePort();

  set("host", "127.0.0.1");
  set("port", port);

  const proxy = new HttpProxy({ host: "127.0.0.1", port, ctx });

  await proxy.start();

  try {
    await fn(port, events);
  } finally {
    sub.dispose();
    await proxy.stop().catch(() => undefined);
  }
}

/**
 * 手写一条 Upgrade 请求打给代理，等到**第一个完整响应头**（`CRLFCRLF`）就返回原始字节
 *
 * @description
 * 拒绝路径（400/403/502）与拨号失败路径（502）都由 `refuse` 写一段含 `CRLFCRLF` 的裸状态行，
 * 所以「拿到响应头」这个判据对成功与失败都成立；而成功路径要等 101 之后才有隧道数据，
 * 本文件只关心「守卫/路由事件」不关心载荷，故统一在响应头处收手。
 */
async function upgradeTo(
  port: number,
  host: string,
  targetPort: number,
  ms = 5000,
): Promise<Buffer> {
  const client = await tcConnect(port);
  const c = makeCollector(client);

  client.write(
    `GET /ws HTTP/1.1\r\nHost: ${host}:${targetPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
  );

  try {
    return await c.waitFor((b) => b.includes(Buffer.from("\r\n\r\n")), ms);
  } finally {
    client.destroy();
  }
}

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

describe("integration/websocket-single-path", () => {
  let snap: Record<string, unknown>;
  const stubs: UpstreamStub[] = [];

  beforeEach(() => {
    snap = snapshotConfig(KEYS);
    silenceLogs();
    set("authEnabled", false);
    set("authType", "none");
    set("proxyMode", "client");
  });

  afterEach(async () => {
    for (const s of stubs.splice(0)) {
      await s.close();
    }

    restoreConfig(snap);
  });

  /** 起一个明文 socks5 上游桩（明文承载：`firstBytes()`/`connections()` 才可观测） */
  async function socks5Upstream(): Promise<UpstreamStub> {
    const s = await startUpstreamStub("socks5", { secure: false });

    stubs.push(s);

    return s;
  }

  // ── 每请求恰好一条 route 事件 ───────────────────────────────────────────

  describe("每请求恰好一条 `route` 事件", () => {
    it("SOCKS 上游：恰好一条（`mode=client` / `route=upstream` / 无 reason）", async () => {
      const stub = await socks5Upstream();

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
      const stub = await startUpstreamStub("https", { secure: false });

      stubs.push(stub);

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
        readAcl({ config: testConfig, force: true });

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
      const stub = await socks5Upstream();

      try {
        set("aclFile", path.join(dir, "acl.json"));
        set("upstreamProtocol", "socks5");
        set("upstreamHost", "127.0.0.1");
        set("upstreamPort", stub.port);
        fs.writeFileSync(
          path.join(dir, "acl.json"),
          JSON.stringify({ target: { blacklist: [DEST_HOST] } }),
        );
        readAcl({ config: testConfig, force: true });

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

  // ── 自环判定：两侧都必须保住 ───────────────────────────────────────────

  describe("自环判定（2d 唯一有真实风险的点）", () => {
    it("真实目标自环：SOCKS 上游下客户端请求代理自己的监听地址 → 拒（502），且上游零建链", async () => {
      const stub = await socks5Upstream();

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
});
