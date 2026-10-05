/**
 * 注入的 `AccessControl` 替身**真的被转发路径问到**（行为级，走一次真请求）
 *
 * 三条性质共用同一件事：只断言「`runtime.services.access` 是我给的那个对象」证明的
 * 仅仅是**赋值发生** —— 一份没人调用的替身照样通过。故判据一律是「真请求 + 计数 +
 * 结论被采信」，端口的六条硬裁决与源码级判据口径归 `./AGENTS.md`。
 *
 * @module tests/unit/core/access-control/port-injection
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProxyRuntime } from "@/runtime/index.js";
import { getFreePort } from "../../../helpers/net.js";
import { activeRuntimes, absoluteGet, countingAccess } from "./_access-control-port.js";

/**
 * 账本目录**必须逐处显式钉**：`createProxyRuntime` 的内联 config 不经 `loadConfig`，
 * 于是 `setup-env.ts` 那两个钉值（`process.env.QUOTA_USAGE_DIR` 与 `set(...)`）两侧全落空，
 * 而 `quotaUsageDir` 的 FIELDS 缺省是相对路径 `cfg/usage`、按 `configDir`（缺省 = `cwd`
 * = 仓库根）绝对化 —— 加上用量数据源的 `open()` 在 `start()` 里就跑（与是否真计量无关），
 * 一条字节都没传的用例照样会在仓库里留下账本。基准形状见 `tests/setup-env.ts`。
 */
const LEDGER_DIR = path.join(os.tmpdir(), "proxy-test-access-port-ledger");

afterEach(async () => {
  for (const r of activeRuntimes.splice(0)) {
    await r.stop().catch(() => undefined);
  }
});

describe("注入的 AccessControl 替身真的被转发路径调用", () => {
  it("经 createProxyRuntime 注入 → 三个方法在一次真请求里各被调用", async () => {
    // client 模式（`checkRoute` 只在 client 模式被问，server 模式零开销短路）+
    // 一个**通配上游**占位（checkRoute 说 direct 时根本不会用到它）。
    // 目标打一个死端口：请求最终 502 没关系 —— 本条只关心三个判定都被问过。
    const port = await getFreePort();
    const deadTarget = await getFreePort();
    const access = countingAccess();
    const runtime = createProxyRuntime({
      config: {
        host: "127.0.0.1",
        port,
        authEnabled: false,
        proxyMode: "client",
        upstreamHost: "127.0.0.1",
        upstreamPort: deadTarget,
        upstreamTimeout: 300,
        quotaUsageDir: LEDGER_DIR,
      },
      services: { access },
    });
    activeRuntimes.push(runtime);

    // 对象同一性：替身原样透传到 runtime 的服务视图与 core 的归一化选项
    expect(runtime.services.access).toBe(access);
    expect(runtime.options.access).toBe(access);

    await runtime.start();
    await absoluteGet(port, `127.0.0.1:${deadTarget}`).catch(() => undefined);

    // ① 入站对端准入：每条连接一次
    expect(access.calls.client.length).toBeGreaterThan(0);
    expect(access.calls.client[0].client).toBe("127.0.0.1");
    // ② 出站目标准入：拨号前一次，入参带客户端请求的目标主机
    // （**只有 host、没有端口**：`parseTargetParts` 解析时已把端口剥开，名单条目也不带端口）
    expect(access.calls.target.length).toBeGreaterThan(0);
    expect(access.calls.target[0].host).toBe("127.0.0.1");
    // ③ 路由判定：client 模式问一次，入参只有 host（不带 user —— 路由与身份正交）
    expect(access.calls.route.length).toBeGreaterThan(0);
    expect(access.calls.route[0].host).toBe("127.0.0.1");
    // 路由判定入参刻意**没有** user 维度（个人名单绝不参与路由，见 user-acl-merge 护栏 4）
    expect(access.calls.route[0]).not.toHaveProperty("user");
  });

  it("替身判否时请求真的被拒（计数不够，还要看结论被采信）", async () => {
    const port = await getFreePort();
    const target = await getFreePort();
    const access = countingAccess({ target: { allowed: false, reason: "rate-limited", source: "engine" } });
    const runtime = createProxyRuntime({
      config: {
        host: "127.0.0.1",
        port,
        authEnabled: false,
        proxyMode: "server",
        quotaUsageDir: LEDGER_DIR,
      },
      services: { access },
    });
    activeRuntimes.push(runtime);

    await runtime.start();
    const status = await absoluteGet(port, `127.0.0.1:${target}`).catch(() => 0);

    expect(access.calls.target.length).toBeGreaterThan(0);
    // 名单拒绝 → 403（`guardPreDial` 的 deny(STATUS_FORBIDDEN)）
    expect(status).toBe(403);
  });

  it("替身说直连时真的直连（checkRoute 的结论被采信，不只是被调用）", async () => {
    // 两个都「放行」的实现无法区分「checkRoute 被问了」与「被问了且结论被采信」：
    // 这一档让 checkRoute 说直连，并让 checkTarget 也说拒 —— 若路由结论没被采信，
    // 仍会走上游（并因 checkTarget 的拒而 403）。故两条同时断言才闭合。
    const origin = http.createServer((_req, res) => {
      res.writeHead(200, { "content-length": "2" });
      res.end("ok");
    });
    const originPort = await getFreePort();
    await new Promise<void>((resolve) => origin.listen(originPort, "127.0.0.1", resolve));
    const deadUpstream = await getFreePort();
    const port = await getFreePort();

    try {
      const access = countingAccess({ route: { direct: true } });
      const runtime = createProxyRuntime({
        config: {
          host: "127.0.0.1",
          port,
          authEnabled: false,
          proxyMode: "client",
          upstreamHost: "127.0.0.1",
          upstreamPort: deadUpstream,
          upstreamTimeout: 300,
          quotaUsageDir: LEDGER_DIR,
        },
        services: { access },
      });
      activeRuntimes.push(runtime);
      await runtime.start();

      // checkRoute 说直连 → 真目标被拨（而不是那个死上游）
      const status = await absoluteGet(port, `127.0.0.1:${originPort}`).catch(() => 0);

      expect(access.calls.route.length).toBeGreaterThan(0);
      expect(status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => origin.close(() => resolve()));
    }
  });
});