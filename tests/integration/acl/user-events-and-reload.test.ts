/**
 * 这一档管每用户名单这一层的**运维可见面**：`[target-denied]` 落盘行带 `source=`、全局优先、
 * 改 `users.json` 不重启即生效。
 *
 * @module tests/integration/acl
 * 档级不变量（身份链只有一条、判定层的合并语义归 `tests/unit/`、与本目录另两档的分工）见 `./AGENTS.md`；
 * 装配面见 `./user-acl-fixture.js`。
 */
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createConfigContext } from "@/config/index.js";
import { HttpProxy } from "@/core/server/http.js";
import { ProxyServer } from "@/server/index.js";
import { LoggerImpl } from "@/utils/logger/index.js";
import { set, testConfigStore } from "../../helpers/config.js";
import { getFreePort, sleep } from "../../helpers/net.js";
import { withProxy } from "../../helpers/proxy.js";
import {
  ALICE,
  ALICE_PW,
  BOB,
  BOB_PW,
  TARGET_IP,
  accessDenied,
  aclPath,
  dir,
  origin,
  originHits,
  proxyGet,
  proxyOpts,
  targetDenied,
  watch,
  writeUsers,
} from "./user-acl-fixture.js";

describe("acl · user-events-and-reload（落盘行 / 全局优先 / 热加载）", () => {
  it("[target-denied] 落盘行带 source=（运维据此知道该改 acl.json 还是 users.json）", async () => {
    // 落盘 switch 装在 **ProxyServer**（进程编排层，core 零日志），故这里必须起真 server；
    // logger 必须是真 `LoggerImpl`（ProxyServer 还要用它的 notice/raw 等编排期通道），
    // 故按 `inbound/tls-client-auth.test.ts` 的做法注入 silent 实例并 spy `warn`。
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
      expect(await proxyGet(port, origin.port, ALICE, ALICE_PW)).toBe(403);
    } finally {
      // 刻意**不**在这里 mockRestore：`mockRestore` 会连带清空 `mock.calls`，
      // 而断言恰恰要读它。logger 是本用例私有的，spy 随用例一起被丢弃。
      await server.stop().catch(() => {});
    }

    const deniedLines = warn.mock.calls.filter((c) => String(c[0]).startsWith("[target-denied]"));
    expect(deniedLines).toHaveLength(1);
    // 文本契约：`[target-denied] <target> 拒绝 reason=<reason> source=<层>`
    expect(deniedLines[0][0]).toBe(
      `[target-denied] ${TARGET_IP}:${origin.port} 拒绝 reason=blacklist source=user`,
    );
    // 结构化字段同步带 source 与 user（jq 侧可查）
    const fields = deniedLines[0][deniedLines[0].length - 1] as Record<string, unknown>;
    expect(fields).toMatchObject({
      target: `${TARGET_IP}:${origin.port}`,
      host: TARGET_IP,
      reason: "blacklist",
      source: "user",
      user: ALICE,
    });
  });

  it("全局与个人名单都拒：报全局那一条（source=global）", async () => {
    // 全局也禁回环（个人名单禁的是同一个 IP，两关都拒）
    fs.writeFileSync(aclPath, JSON.stringify({ target: { blacklist: [TARGET_IP] } }));
    watch();
    await withProxy(
      HttpProxy,
      proxyOpts(),
      async (port) => {
        // 两个人都撞上全局那一关：都报 global（不是 "个人名单恰好也禁了"）
        expect(await proxyGet(port, origin.port, ALICE, ALICE_PW)).toBe(403);
        expect(await proxyGet(port, origin.port, BOB, BOB_PW)).toBe(403);
      },
    );

    const denied = targetDenied();
    expect(denied).toHaveLength(2);
    for (const e of denied) {
      expect(e).toMatchObject({ source: "global", reason: "blacklist" });
    }
    // 公共事件面同样带 global
    expect(accessDenied().map((e) => e.data)).toEqual([
      { host: TARGET_IP, target: `${TARGET_IP}:${origin.port}`, reason: "blacklist", source: "global" },
      { host: TARGET_IP, target: `${TARGET_IP}:${origin.port}`, reason: "blacklist", source: "global" },
    ]);
  });

  it("改 users.json 并越过 1s 节流：同一请求从 403 变 200（不重启）", async () => {
    watch();
    await withProxy(
      HttpProxy,
      proxyOpts(),
      async (port) => {
        expect(await proxyGet(port, origin.port, ALICE, ALICE_PW, "/before")).toBe(403);
        expect(originHits()).toBe(0);

        // 把 alice 的个人名单从「禁回环」改成「白名单圈住回环」
        writeUsers([
          {
            username: ALICE,
            password: ALICE_PW,
            acl: { target: { whitelist: [TARGET_IP] } },
          },
          { username: BOB, password: BOB_PW, acl: { target: { whitelist: [TARGET_IP] } } },
        ]);
        await sleep(1100);

        expect(await proxyGet(port, origin.port, ALICE, ALICE_PW, "/after")).toBe(200);
        expect(originHits()).toBe(1);
        // 整个会话只发生过那一次拒绝
        expect(targetDenied()).toHaveLength(1);
      },
    );
  });
});