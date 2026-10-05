/**
 * 这一档管 `acl-inert` 告警的**落盘面**：真 `ProxyServer` 落的那一行 `warn` 的逐字文案，
 * 加脚手架 `withProxy` 的 `access` 缺省档不是放行桩（行为面 + 源码级）。
 *
 * @module tests/integration/acl
 * 档级不变量（判据为什么是两个 AND、为什么 `onWarning` 是白名单而不整体转发、跨 unit 侧的分工）
 * 见 `./AGENTS.md`；装配面见 `./inert-fixture.js`。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConfigContext } from "@/config/index.js";
import { ACL_INERT_DETAIL, LogEvent } from "@/core/log-events.js";
import { HttpProxy } from "@/core/server/http.js";
import { LoggerImpl } from "@/utils/logger/index.js";
import { ProxyServer } from "@/server/index.js";
import { testConfigStore } from "../../helpers/config.js";
import { getFreePort } from "../../helpers/net.js";
import { withProxy } from "../../helpers/proxy.js";
import { blockAfter, codeOf, codeOnly, TESTS_DIR } from "../../helpers/source-scan.js";
import {
  absoluteGet,
  countingAccess,
  freshAcl,
  live,
  runtimeContext,
} from "./inert-fixture.js";

describe("CLI 落盘行 `[acl-inert]`", () => {
  it("落一条 warn 行，文案与文案常量逐字相同（运维真的看得见）", async () => {
    const aclFile = freshAcl({ clientIp: { blacklist: ["203.0.113.9"] } });
    const port = await getFreePort();
    testConfigStore.set("port", port);
    testConfigStore.set("host", "127.0.0.1");
    testConfigStore.set("aclFile", aclFile);
    testConfigStore.set("logFile", "");

    const logger = new LoggerImpl({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    live.server = new ProxyServer({
      context: createConfigContext({ store: testConfigStore, configDir: live.dir }),
      logger,
      noColor: true,
      services: { access: countingAccess() },
    });
    await live.server.start();

    const lines = warn.mock.calls.filter((c) => String(c[0]).startsWith(`[${LogEvent.AclInert}]`));
    expect(lines, "注入 access + 配了名单 → 启动必须告警").toHaveLength(1);
    expect(String(lines[0][0])).toBe(`[${LogEvent.AclInert}] ${ACL_INERT_DETAIL}`);
    // 文案必须回答「怎么办」与「哪几组不生效」——只说「出问题了」等于没报
    expect(String(lines[0][0])).toContain("clientIp/target");
    expect(String(lines[0][0])).toContain("upstream");
    expect(String(lines[0][0])).toContain("createFileAccessControl");
  });

  it("没注入 access 时不落这一行（`onWarning` 是白名单，不是整体转发）", async () => {
    const aclFile = freshAcl({ target: { blacklist: ["203.0.113.9"] } });
    const port = await getFreePort();
    testConfigStore.set("port", port);
    testConfigStore.set("host", "127.0.0.1");
    testConfigStore.set("aclFile", aclFile);
    testConfigStore.set("logFile", "");

    const logger = new LoggerImpl({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    live.server = new ProxyServer({
      context: createConfigContext({ store: testConfigStore, configDir: live.dir }),
      logger,
      noColor: true,
    });
    await live.server.start();

    const lines = warn.mock.calls.filter((c) => String(c[0]).startsWith(`[${LogEvent.AclInert}]`));
    expect(lines).toHaveLength(0);
  });

  it("源码级：`onWarning` 是**白名单**（三条），刻意不整体转发", () => {
    // 锁的是「只接白名单、不整体转发」这条裁决。**已变异验证**：给 handler 加一档
    // `else { this.logger.warn(w.message); }` 立刻红本条。
    //
    // ⚠️ 为什么这条只能源码级：`config-normalized` / `start-failed` 要经
    // `prepareRuntimeConfigStore` 的拆项覆盖告警或启动抛错才触发，那两条路径的触发条件
    // 属于配置归一那一面（改动它要连带改这里的断言）。而这条纪律的**全部内容**就是
    // 「handler 长什么样」，文本面才是它的直接对象。
    const code = codeOf("server", "index.ts");
    const at = code.indexOf("onWarning: (w) =>");
    expect(at, "server/index.ts 里的 onWarning handler 必须在").toBeGreaterThanOrEqual(0);
    const body = blockAfter(code, "onWarning: (w) =>");

    // ① 白名单里的三条都真的接了。第三条是 `account-table-inert`（jwt 模式下 users.json 的
    //   `expiresAt` / `disabled` 都不生效）——**逐条点名**而不是数出现次数：数次数的话新增
    //   一条白名单时本断言会静默通过，而漏接（新增告警却不落盘）才是真正要防的失效。
    expect(body).toContain('w.code === "quota-inert"');
    expect(body).toContain('w.code === "acl-inert"');
    expect(body).toContain('w.code === "account-table-inert"');
    // ② **不许有兜底分支**：整体转发就长成「else 支把 w.message 原样 warn 出去」
    expect(body, "onWarning 不许整体转发").not.toMatch(/\belse\s*\{/);
    expect(body).not.toMatch(/this\.logger\.warn\(\s*w\./);
  });
});

describe("测试脚手架：withProxy 的 access 缺省不是放行桩", () => {
  it("经 withProxy 起了代理、**没有**显式注入 access → 名单照样生效（403）", async () => {
    // 锁的是 `tests/helpers/proxy.ts` 的那条裁决：`opts.access ?? createFileAccessControl(ctx.config)`。
    //
    // **为什么这条必须存在**：`ProxyOptions.access` 现在是编译期必填，core 侧零缺省解析；
    // 而 `withProxy` 收的是 `Partial<ProxyOptions>`，若脚手架不管，TypeScript 不会逼每个
    // 调用点表态。届时「补救」最自然的形态就是补一个**恒放行桩**——那等于把「配了名单、
    // 请求照过、测试全绿」这个假绿从 core 搬进脚手架。本条把「脚手架的缺省档是真判定」
    // 变成可观测事实：忘了注入 → 按配置真的拒，而不是静默放行。
    const aclFile = freshAcl({ clientIp: { blacklist: ["127.0.0.1"] } });
    const port = await getFreePort();
    const prev = testConfigStore.get("aclFile");
    testConfigStore.set("aclFile", aclFile);
    try {
      await withProxy(
        HttpProxy,
        { ctx: runtimeContext() },
        async (proxyPort) => {
          const res = await absoluteGet(proxyPort, `127.0.0.1:${port}`);
          expect(res.status, "withProxy 的缺省 access 必须真的按 acl.json 拒").toBe(403);
        },
      );
    } finally {
      testConfigStore.set("aclFile", prev);
    }
  });

  it("源码级：withProxy 的缺省是 createFileAccessControl，**不是** openAccessControl", () => {
    // 上一条是行为面（强），这条是文本面（钉住「哪一份」）：万一有人把实现换成放行桩却
    // 恰好让上一条仍绿（例如把黑名单目标换成测试自己写的桩），本条会点名是谁。
    //
    // ⚠️ 读的是 `tests/helpers/proxy.ts` 本身（`source-scan.ts:sourceOf` 只认 `src/` 下的
    // 路径，那不是它能覆盖的目录）。路径从 `TESTS_DIR` 派生而不是数 `..` —— 层数只许出现在
    // `source-scan.ts` 那一处，多一级会静默读到别的东西。
    const raw = fs.readFileSync(path.join(TESTS_DIR, "helpers", "proxy.ts"), "utf8");
    expect(raw).toMatch(/access:\s*opts\.access\s*\?\?\s*createFileAccessControl\(ctx\.config\)/);
    expect(codeOnly(raw), "脚手架里不许出现放行桩").not.toContain("openAccessControl");
  });
});