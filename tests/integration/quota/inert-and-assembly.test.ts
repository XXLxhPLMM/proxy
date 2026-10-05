/**
 * 耗尽之外的另一半：唯一合计上限、未耗尽零发布、`quota-inert` 那条 warn 的正反两格、两条落盘行、
 * 身份不串号、配额热加载，以及注入位（`services.traffic` / 直构 core 的显式禁用档）。
 *
 * @description
 * `quota-inert` 为什么收窄到「**真的配了非零配额**」∧ `authEnabled === false`（以及为什么负向那一格
 * 才是这条裁决的牙齿）、与 `tests/unit/` 的分工，全部归 `./AGENTS.md`；装配面见 `./quota-fixture.js`。
 *
 * ⚠️ 本档继承了原文件**全部 4 处**内联 config（`:151` / `:175` / `:342` / `:359`）。内联 config 绕开
 * `loadConfig`，`setup-env.ts` 的 `QUOTA_USAGE_DIR` 重定向对它无效 —— 少给一处 `quotaUsageDir`
 * 就会按缺省落成 `<cwd>/cfg/usage`，**往仓库里写真实账本**。
 *
 * @module tests/integration/quota
 */
import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { accountLocatorFor, createConfigContext } from "@/config/index.js";
import { readAuthUsers } from "@/datasource/users/index.js";
import { createIdentityFromConfig } from "@/core/identity.js";
import { HttpProxy } from "@/core/server/http.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import type { UsageAccount } from "@/datasource/quota/index.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { RuntimeWarning } from "@/runtime/index.js";
import { ProxyServer } from "@/server/index.js";
import { LoggerImpl } from "@/utils/logger/index.js";
import { getFreePort, sleep } from "../../helpers/net.js";
import { withProxy } from "../../helpers/proxy.js";
import { set, testConfig, testConfigStore, testLogger } from "../../helpers/config.js";
import { socks5ConnectIpv4, tcConnect } from "../../helpers/socks-client.js";
import {
  ALICE,
  ALICE_PW,
  BOB,
  BOB_PW,
  TARGET_IP,
  account,
  adoptRuntime,
  ctx,
  dir,
  exceeded,
  origin,
  proxyOpts,
  proxyRequest,
  raw,
  usersPath,
  writeUsers,
} from "./quota-fixture.js";

describe("quota/inert-and-assembly（上限口径 / quota-inert / 落盘行 / 身份隔离 / 热加载 / 装配）", () => {
  // =========================================================================
  // 护栏 6：唯一上限 + 未耗尽零发布
  // =========================================================================

  it("唯一上限：上传 + 下载算在一起（两个方向都在往同一份额度里记）", async () => {
    // 这条锁的是「**只有一个**上限」这件事的端到端后果：一次 POST 的上传 + 响应下载
    // 记在**同一份额度**里。上限取 1000（远大于本例两方向之和）时**不**耗尽，
    // 用量则是两个方向加起来 —— 分方向上限曾经存在过，那时这里是「三个上限各自触发 + 归因」，
    // 归因今天**不存在**了，只剩合计。
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytes: 1000 } }]);
    readAuthUsers({ locator: accountLocatorFor(testConfig), force: true });

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      await proxyRequest(port, origin.port, ALICE, ALICE_PW, {
        method: "POST",
        path: "/both",
        body: Buffer.alloc(40, 0x47),
      });
    });
    expect(exceeded(), "两方向之和没到上限 → 零发布").toHaveLength(0);
    const total = account.usage(ALICE);
    // 合计 = 上传 40 + 响应体（回声，故 > 40；HTTP 路径两方向各少算一个头）
    expect(total).toBeGreaterThan(40);
    expect(total).toBeLessThan(1000);
  });

  it("未耗尽时零发布（连续多次正常传输，一条事件都不许有）", async () => {
    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      for (let i = 0; i < 5; i++) {
        expect(
          (await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: `/ok${i}?n=100` })).status,
        ).toBe(200);
      }
    });
    expect(exceeded()).toHaveLength(0);
    expect(account.usage(ALICE)).toBe(500);
  });

  // =========================================================================
  // 护栏 6：无鉴权 → 不计量 + usage 恒零 + 启动一条 warn
  // =========================================================================

  it("无鉴权：整体不计量（连 consume 都不会被调一次）、usage 恒零、零事件，且启动时有一条 quota-inert warn", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytes: 10 } }]);
    readAuthUsers({ locator: accountLocatorFor(testConfig), force: true });
    set("authEnabled", false);

    // ① 传输不计量：用「记_calls 的替身账本」把「不计量」钉成可观测事实 ——
    //    只断言 usage 恒零是不够的（不调 consume 与调了但查不到配额，两者都让 usage 保持零）。
    const touched: string[] = [];
    const spy: UsageAccount = {
      consume: (user, dir, bytes) => {
        touched.push(`${user}:${dir}:${bytes}`);
        return account.consume(user, dir, bytes);
      },
      usage: (user) => account.usage(user),
    };

    // 即使配额小到 10 字节、传输远超它，也一路放行
    await withProxy(
      HttpProxy,
      { ctx, identity: createIdentityFromConfig(ctx), traffic: spy },
      async (port) => {
        const r = await proxyRequest(port, origin.port, "", "", { path: "/noauth?n=5000" });
        expect(r.status).toBe(200);
        expect(r.got).toBe(5000);
      },
    );
    expect(touched, "无身份 → 计量层一次都不许被调用").toEqual([]);
    expect(account.usage(ALICE)).toBe(0);
    expect(exceeded()).toHaveLength(0);

    // 隧道侧同样零计量
    touched.length = 0;
    await withProxy(
      Socks5Proxy,
      { ctx, identity: createIdentityFromConfig(ctx), traffic: spy },
      async (port) => {
        const sock = await tcConnect(port);
        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        await new Promise((r) => setTimeout(r, 200));
        sock.write(socks5ConnectIpv4(TARGET_IP, raw.port));
        await new Promise((r) => setTimeout(r, 300));
        sock.write(Buffer.alloc(3000, 0x4b));
        await new Promise((r) => setTimeout(r, 300));
        sock.destroy();
      },
    );
    expect(touched, "SOCKS 侧同样零计量").toEqual([]);

    // ② 启动 warn：库路径经 onWarning 旁路
    const warnings: RuntimeWarning[] = [];
    const lib = createProxyRuntime({
      config: {
        host: TARGET_IP,
        port: 1,
        authEnabled: false,
        authUsersFile: usersPath,
        // 内联 config 绕开 loadConfig，setup-env 的 QUOTA_USAGE_DIR 重定向对它无效：
        // 不给这一项就会按缺省落成 <cwd>/cfg/usage，往仓库里写账本文件。
        quotaUsageDir: path.join(dir, "usage"),
      },
      logger: testLogger,
      onWarning: (w) => warnings.push(w),
    });
    adoptRuntime(lib);
    await lib.start();
    expect(warnings.filter((w) => w.code === "quota-inert")).toHaveLength(1);
  });

  it("无鉴权但没配配额：不报 quota-inert（关鉴权本身是常态，没配配额时告警就是噪音）", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW }]);
    readAuthUsers({ locator: accountLocatorFor(testConfig), force: true });
    set("authEnabled", false);

    const warnings: RuntimeWarning[] = [];
    const lib = createProxyRuntime({
      config: {
        host: TARGET_IP,
        port: 1,
        authEnabled: false,
        authUsersFile: usersPath,
        // 内联 config 绕开 loadConfig，setup-env 的 QUOTA_USAGE_DIR 重定向对它无效：
        // 不给这一项就会按缺省落成 <cwd>/cfg/usage，往仓库里写账本文件。
        quotaUsageDir: path.join(dir, "usage"),
      },
      logger: testLogger,
      onWarning: (w) => warnings.push(w),
    });
    adoptRuntime(lib);
    await lib.start();
    expect(warnings.filter((w) => w.code === "quota-inert")).toHaveLength(0);
  });

  it("CLI 路径：quota-inert 落成一条 [quota-inert] warn 行（运维真的看得见）", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytes: 10 } }]);
    readAuthUsers({ locator: accountLocatorFor(testConfig), force: true });
    set("authEnabled", false);

    const logger = new LoggerImpl({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const port = await getFreePort();
    set("port", port);
    const server = new ProxyServer({
      context: createConfigContext({ store: testConfigStore, configDir: dir }),
      logger,
      noColor: true,
      isWorker: true,
    });
    await server.start();
    try {
      const lines = warn.mock.calls.filter((c) => String(c[0]).startsWith("[quota-inert]"));
      expect(lines, "无鉴权 + 配了配额 → 启动必须告警").toHaveLength(1);
      expect(lines[0][0]).toContain("AUTH_ENABLED=false");
      expect(lines[0][0]).toContain("quota 整体不生效");
    } finally {
      await server.stop().catch(() => {});
    }
  });

  it("[quota-exceeded] 落盘 warn 行带 user/usage/limit/方向/上限种类（运维据此判断该扩容还是加单向上限）", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytes: 100 } }]);
    readAuthUsers({ locator: accountLocatorFor(testConfig), force: true });

    const logger = new LoggerImpl({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const port = await getFreePort();
    set("port", port);
    const server = new ProxyServer({
      context: createConfigContext({ store: testConfigStore, configDir: dir }),
      logger,
      noColor: true,
      isWorker: true,
    });
    await server.start();
    try {
      await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/log?n=5000" });
    } finally {
      await server.stop().catch(() => {});
    }
    const lines = warn.mock.calls.filter((c) => String(c[0]).startsWith("[quota-exceeded]"));
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toBe(`[quota-exceeded] ${ALICE} 配额耗尽 dir=down usage=5000 limit=100`);
    expect(lines[0][lines[0].length - 1]).toMatchObject({
      user: ALICE,
      dir: "down",
      usage: 5000,
      limit: 100,
    });
  });

  // =========================================================================
  // 护栏 7：身份不串号
  // =========================================================================

  it("两个用户在同一代理上各耗各的配额，互不影响（锁「user 不得取错」）", async () => {
    writeUsers([
      { username: ALICE, password: ALICE_PW, quota: { bytes: 100 } },
      { username: BOB, password: BOB_PW, quota: { bytes: 100_000 } },
    ]);
    readAuthUsers({ locator: accountLocatorFor(testConfig), force: true });

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      // alice 先撞顶
      const a = await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/a?n=5000" });
      expect(a.aborted).toBe(true);
      // bob 同一条代理、同一目标、同样大的流量：一路放行
      const b = await proxyRequest(port, origin.port, BOB, BOB_PW, { path: "/b?n=5000" });
      expect(b.status).toBe(200);
      expect(b.got).toBe(5000);
      expect(b.aborted).toBe(false);
    });

    expect(account.usage(ALICE)).toBe(5000);
    expect(account.usage(BOB)).toBe(5000);
    // 事件也只归 alice 一条
    const events = exceeded();
    expect(events).toHaveLength(1);
    const only = events[0]!;
    expect(only.data.user).toBe(ALICE);
    expect(only.context.user).toBe(ALICE);
  });

  // =========================================================================
  // 护栏 8：热加载
  // =========================================================================

  it("热加载：改 users.json 的配额越过 1s 节流后对新请求生效，且**已用量保留不清零**", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytes: 100_000 } }]);
    readAuthUsers({ locator: accountLocatorFor(testConfig), force: true });

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      expect((await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/h1?n=1000" })).status).toBe(200);
      expect(account.usage(ALICE)).toBe(1000);

      // 收紧到 1500（高于已用 1000）→ 下一个 1000 字节的请求就该撞顶
      writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytes: 1500 } }]);
      await sleep(1100);

      const r = await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/h2?n=1000" });
      expect(r.aborted, "新配额对后续请求生效").toBe(true);
    });

    const events = exceeded();
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ dir: "down", limit: 1500, usage: 2000 });
    // **已用量保留不清零**（裁决）：清零等于给「重载 users.json」发了一条刷配额的路——
    // 攻击者只要反复触发热加载就能把任意大的配额一次次重置。清零的唯一正当场景是
    // 「配额窗口过期」，那是 5b 落盘时间窗要解决的问题。
    expect(account.usage(ALICE)).toBe(2000);
  });

  // =========================================================================
  // 护栏 9：装配
  // =========================================================================

  it("注入的 UsageAccount 原样生效（不传时用默认镜像，core 侧零缺省解析）", async () => {
    // 替身账本已经在每个用例里被注入了 —— 上面所有用例的 usage 断言本身就是证据。
    // 这里再钉一条「注入的那个实例就是 core 用的那个」：伪造一个只认 alice 的替身，
    // 若 core 偷偷自己造了一份实现，bob 就会被当成不限流。
    const seen: string[] = [];
    const spy = {
      consume: (user: string, dir: "up" | "down", bytes: number) => {
        seen.push(`${user}:${dir}:${bytes}`);
        return account.consume(user, dir, bytes);
      },
      usage: (user: string) => account.usage(user),
    };
    await withProxy(
      HttpProxy,
      { ctx, identity: createIdentityFromConfig(ctx), traffic: spy },
      async (port) => {
        expect((await proxyRequest(port, origin.port, BOB, BOB_PW, { path: "/spy?n=64" })).status).toBe(
          200,
        );
      },
    );
    expect(seen.length, "core 确实调的是注入的那个实例").toBeGreaterThan(0);
    expect(seen.every((s) => s.startsWith(`${BOB}:`)), "user 不得取错").toBe(true);
  });

  it("默认解析只发生在唯一组装点：createProxyRuntime 装内存账本并落到 core，ProxyOptions.traffic 同一个实例", async () => {
    const lib = createProxyRuntime({
      config: {
        host: TARGET_IP,
        port: 1,
        authEnabled: true,
        authType: "basic",
        authUsersFile: usersPath,
        // 内联 config 绕开 loadConfig，setup-env 的 QUOTA_USAGE_DIR 重定向对它无效：
        // 不给这一项就会按缺省落成 <cwd>/cfg/usage，往仓库里写账本文件。
        quotaUsageDir: path.join(dir, "usage"),
      },
      logger: testLogger,
    });
    adoptRuntime(lib);
    await lib.start();
    // services 面上是内存实现（读 users.json 的 quota）
    expect(lib.services.traffic).toBe(lib.options.traffic);
    // 显式注入替身时也原样透传
    const fake: UsageAccount = { consume: () => ({ allow: true }), usage: () => 0 };
    const lib2 = createProxyRuntime({
      config: {
        host: TARGET_IP,
        port: 1,
        authUsersFile: usersPath,
        // 内联 config 绕开 loadConfig，setup-env 的 QUOTA_USAGE_DIR 重定向对它无效：
        // 不给这一项就会按缺省落成 <cwd>/cfg/usage，往仓库里写账本文件。
        quotaUsageDir: path.join(dir, "usage"),
      },
      services: { traffic: fake },
      logger: testLogger,
    });
    adoptRuntime(lib2);
    expect(lib2.services.traffic).toBe(fake);
    expect(lib2.options.traffic).toBe(fake);
  });

  it("直构 core 不注入 traffic → 归一成显式禁用档（不计量、不判定），不崩也不放行一切事件", async () => {
    // 与 `identity ?? noneIdentity()` 同构的既有先例：显式禁用档让「忘注入」不会变成怪问题
    await withProxy(
      HttpProxy,
      { ctx, identity: createIdentityFromConfig(ctx) },
      async (port) => {
        writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytes: 1 } }]);
        const r = await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/raw?n=3000" });
        expect(r.status, "禁用档下配额完全不生效").toBe(200);
        expect(r.got).toBe(3000);
      },
    );
    expect(exceeded()).toHaveLength(0);
  });
});
