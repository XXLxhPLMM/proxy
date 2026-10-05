/**
 * 这一档管 `account-table-inert`：jwt 模式下 `users.json` 的 `expiresAt` / `disabled` 都不生效
 * 时的告警真值表（三条判据真值 + 共用码的两侧 + CLI 落盘行）。
 *
 * @module tests/integration/acl
 * 档级不变量（三族告警共用的判据形状、`onWarning` 白名单封顶三条、跨 unit 侧的分工）见 `./AGENTS.md`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigContext } from "@/config/index.js";
import { ACCOUNT_TABLE_INERT_DETAIL, LogEvent } from "@/core/log-events.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { RuntimeWarning } from "@/runtime/index.js";
import { ProxyServer } from "@/server/index.js";
import { LoggerImpl } from "@/utils/logger/index.js";
import { testConfigStore, testLogger } from "../../helpers/config.js";
import { getFreePort } from "../../helpers/net.js";
import { live } from "./inert-fixture.js";

/**
 * `account-table-inert` 启动期告警（真 runtime + 真 `ProxyServer`）。
 *
 * @description
 * **这条告警在防什么**：jwt 的身份来自 token 自身（`sub` 给用户名、`exp` 给过期），**判定根本不查
 * 账号表** —— 运维写的 `expiresAt` / `disabled` 在 jwt 模式下「一个都没生效」而部署看着完全正常
 * （`disabled` 那条是「**以为封住了、其实完全没封**」）。推导见 `./AGENTS.md`。
 *
 * **判据是两个都必须成立的 AND**：`authType === "jwt"` ∧（`hasAccountExpiry` ∨
 * `hasAccountDisabled`）；两个字段**共用一个 code**（成因与做法逐字相同）。
 * ⚠️ 判据不含「是否已过期」（**启动期**事实）与「只报一次」（故断言**恰好**条数）。
 */
describe("account-table-inert：jwt 模式下配了 expiresAt / disabled → 恰好一条", () => {
  let usersDir = "";

  beforeEach(() => {
    usersDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-table-inert-"));
  });

  afterEach(() => {
    // runtime / server 的停机与 mock 复原归 `./inert-fixture.js` 的模块级 afterEach，本档只回收自己的临时目录
    try {
      fs.rmSync(usersDir, { recursive: true, force: true });
    } catch {
      // 清理失败不应遮蔽用例结论
    }
  });

  /** 每档独立 users.json 路径（`readJsonCached` 的 1s 节流缓存是模块级、键为 `label + path`） */
  function freshUsers(body: unknown): string {
    const p = path.join(usersDir, `users-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify(body));
    return p;
  }

  const tableWarnings = (warnings: RuntimeWarning[]): RuntimeWarning[] =>
    warnings.filter((w) => w.code === "account-table-inert");

  /**
   * 本档两处内联 config 都必须显式给账本目录：库模式不经 `loadConfig`，`setup-env.ts` 的
   * `QUOTA_USAGE_DIR` 钉值两侧都落空（`new ConfigStore(内联)` 与宿主 env 无关），缺省相对
   * 路径 `cfg/usage` 会按 `configDir = process.cwd()` 绝对化到仓库里。与「是否真计量」无关：
   * `start()` 无条件 `open()` 用量数据源。复用本档的 `usersDir` —— 它已在 `afterEach` 里回收。
   */
  const usageDir = (): string => path.join(usersDir, "usage");

  async function startJwtRuntime(usersFile: string): Promise<RuntimeWarning[]> {
    const warnings: RuntimeWarning[] = [];
    const port = await getFreePort();
    const lib = createProxyRuntime({
      config: {
        host: "127.0.0.1",
        port,
        authEnabled: true,
        authType: "jwt",
        jwtSecret: "s3cr3t",
        authUsersFile: usersFile,
        logFile: "",
        quotaUsageDir: usageDir(),
      },
      logger: testLogger,
      onWarning: (w) => warnings.push(w),
    });
    live.runtime = lib;
    await lib.start();
    return warnings;
  }

  it("jwt + 有人配了 expiresAt → 恰好一条，文案必须点名 exp 与改成 basic/uid", async () => {
    const usersFile = freshUsers([
      { username: "alice", password: "pw1", expiresAt: "2030-01-01T00:00:00Z" },
    ]);
    const warnings = await startJwtRuntime(usersFile);
    const lines = tableWarnings(warnings);
    expect(lines, "jwt 模式 + 配了 expiresAt → 启动必须告警").toHaveLength(1);
    // 文案必须回答「那该怎么过期」——只说「不生效」而不说正确做法，运维只知道配错了
    expect(lines[0]!.message).toBe(ACCOUNT_TABLE_INERT_DETAIL);
    expect(lines[0]!.message).toContain("exp");
    expect(lines[0]!.message).toContain("basic");
    expect(lines[0]!.message).toContain("uid");
  });

  it("jwt + 没人配 expiresAt → 零条（没配就在报 = 噪音）", async () => {
    const usersFile = freshUsers([{ username: "alice", password: "pw1" }]);
    expect(tableWarnings(await startJwtRuntime(usersFile))).toHaveLength(0);
  });

  it("basic + 配了 expiresAt → 零条（basic 下它是生效的）", async () => {
    const usersFile = freshUsers([
      { username: "alice", password: "pw1", expiresAt: "2030-01-01T00:00:00Z" },
    ]);
    const warnings: RuntimeWarning[] = [];
    const port = await getFreePort();
    const lib = createProxyRuntime({
      config: {
        host: "127.0.0.1",
        port,
        authEnabled: true,
        authType: "basic",
        authUsersFile: usersFile,
        logFile: "",
        quotaUsageDir: usageDir(),
      },
      logger: testLogger,
      onWarning: (w) => warnings.push(w),
    });
    live.runtime = lib;
    await lib.start();
    expect(tableWarnings(warnings), "basic 下 expiresAt 生效，不该报").toHaveLength(0);
  });

  it("jwt + 只有 disabled（没人配 expiresAt）→ 恰好一条（共用码，但判据两侧各自独立成立）", async () => {
    // 这一格是「共用码 ≠ 放宽判据」的牙齿：判据若被写成「只认 expiresAt」，本档会**零条**，
    // 于是「运维封禁了一个账号、部署看起来完全正常」又一次零信号通过。
    const usersFile = freshUsers([{ username: "alice", password: "pw1", disabled: true }]);
    const lines = tableWarnings(await startJwtRuntime(usersFile));
    expect(lines, "jwt 模式 + 配了 disabled → 启动必须告警").toHaveLength(1);
    // 文案必须**点名 disabled**：一条只写 expiresAt 的告警会让读者以为它与自己那个
    // 「以为封住了」的安全假设无关
    expect(lines[0]!.message).toContain("disabled");
  });

  it("jwt + 全员显式 disabled:false → 零条（显式 false 与缺省同义，不该报）", async () => {
    // `hasAccountDisabled` 判的是 `=== true` 而不是「键存在」。判成「键存在」的话，一个把
    // 所有账号都显式写成 `false` 的部署每次启动都收一条「配了不生效」——告警一旦误报就永久失信。
    const usersFile = freshUsers([{ username: "alice", password: "pw1", disabled: false }]);
    expect(tableWarnings(await startJwtRuntime(usersFile))).toHaveLength(0);
  });

  it("CLI 落盘行 `[account-table-inert]`：文案与文案常量逐字相同", async () => {
    const usersFile = freshUsers([
      { username: "alice", password: "pw1", expiresAt: "2030-01-01T00:00:00Z" },
    ]);
    const port = await getFreePort();
    testConfigStore.set("port", port);
    testConfigStore.set("host", "127.0.0.1");
    testConfigStore.set("authEnabled", true);
    testConfigStore.set("authType", "jwt");
    testConfigStore.set("jwtSecret", "s3cr3t");
    testConfigStore.set("authUsersFile", usersFile);
    testConfigStore.set("logFile", "");

    const logger = new LoggerImpl({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    live.server = new ProxyServer({
      context: createConfigContext({ store: testConfigStore, configDir: usersDir }),
      logger,
      noColor: true,
    });
    await live.server.start();

    const lines = warn.mock.calls.filter((c) =>
      String(c[0]).startsWith(`[${LogEvent.AccountTableInert}]`),
    );
    expect(lines, "白名单接了这条 → CLI 必须真的落这一行").toHaveLength(1);
    expect(String(lines[0][0])).toBe(
      `[${LogEvent.AccountTableInert}] ${ACCOUNT_TABLE_INERT_DETAIL}`,
    );
  });
});