/**
 * `FileAccountIdentity` 的构造面 + `createIdentityFromConfig` 的注入面
 *
 * @description
 * 两段：一段是**提取器**（头名 / scheme / 值载体怎么被读成 token），一段是**注入面**
 * （私有 `ConfigStore` 换掉后鉴权开关 / 类型 / 账号表都跟着换）。
 *
 * ⚠️ 凭证判据归插件、判据与识别同源、记忆化的六项失效判据都不在这里 ——
 * 那几条的牙齿与变异表见 `AGENTS.md`。
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileAccountIdentity, createIdentityFromConfig } from "@/core/identity.js";
import { ConfigStore, configAccessorFromStore } from "@/config/index.js";
import {
  get,
  set,
  testContext,
  testContextFor,
  restoreConfig,
  snapshotConfig,
} from "../../../helpers/config.js";
import { acct, b64, ctxWith } from "./_identity.js";

describe("identity/extractors (via FileAccountIdentity.identify)", () => {
  it("Header 优先 proxy-authorization，自动剥离 Basic/Bearer", async () => {
    const id = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [acct("test", "123")],
      enableLogging: false,
    });
    expect(
      (
        await id.identify(
          ctxWith({ headers: { "proxy-authorization": `Basic ${b64("test:123")}` } }),
        )
      ).passed,
    ).toBe(true);

    const jwt = new FileAccountIdentity({
      enabled: true,
      type: "jwt",
      jwtSecret: "s",
      jwtVerify: async (t) => t === "abc",
      enableLogging: false,
    });
    expect(
      (await jwt.identify(ctxWith({ headers: { authorization: "Bearer abc" } }))).passed,
    ).toBe(true);
    expect((await id.identify(ctxWith({ headers: {} }))).passed).toBe(false);
  });

  it("头名大小写无关，数组值取首个非空", async () => {
    const id = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [acct("test", "123")],
      enableLogging: false,
    });
    expect(
      (
        await id.identify(
          ctxWith({ headers: { "Proxy-Authorization": `Basic ${b64("test:123")}` } }),
        )
      ).passed,
    ).toBe(true);
    expect(
      (
        await id.identify(
          ctxWith({ headers: { "PROXY-AUTHORIZATION": ["", b64("test:123")] } }),
        )
      ).passed,
    ).toBe(true);
    expect((await id.identify(ctxWith({ headers: { authorization: ["  "] } }))).passed).toBe(
      false,
    );
  });

  it("非标携带（Cookie/URL）不是 token", async () => {
    const id = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [acct("u", "p")],
      enableLogging: false,
    });
    expect(
      (
        await id.identify(
          ctxWith({ headers: { cookie: "token=abc123" }, url: "/?token=xyz" }),
        )
      ).passed,
    ).toBe(false);
  });
});

// ── CoreContext 注入（core 依赖端口）护栏 ──
// 证明身份链路经注入的 context 读配置与账号表，而不是全局单例 —— 「多 Runtime 隔离」
// 在身份侧的最小可验证单元。
//
// 形参收 CoreContext 而不是 ConfigAccessor 是身份工厂的签名取舍：三件套整体注入，
// 理由见 src/core/identity/factory.ts 文件头（isOwnCredential 在最热路径上）。断言口径不变
// —— 隔离性判据是「换掉 ctx.config 就换掉真相源」，accessor 只是 ctx 的三个成员之一。
describe("createIdentityFromConfig 注入 CoreContext", () => {
  it("全局与私有 store 各读各的：注入后鉴权开关/类型/账号表都来自该 store", async () => {
    const prev = snapshotConfig(["authEnabled", "authType", "authUsersFile", "authLogging"]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-identity-accessor-"));
    const usersFile = path.join(dir, "users.json");
    fs.writeFileSync(usersFile, JSON.stringify([{ username: "bob", password: "pw-bob" }]));
    try {
      // 全局：关闭鉴权
      set("authEnabled", false);
      set("authType", "none");
      set("authUsersFile", path.join(dir, "missing.json"));
      set("authLogging", false);

      // 私有 store：basic 鉴权 + 自己的账号表（与全局那份不同）
      const store = new ConfigStore({
        authEnabled: true,
        authType: "basic",
        authUsersFile: usersFile,
        authLogging: false,
      });
      const scoped = createIdentityFromConfig(testContextFor(configAccessorFromStore(store)));

      // 注入的 provider：认私有账号表里的凭据
      const b64Bob = Buffer.from("bob:pw-bob").toString("base64");
      expect(
        (
          await scoped.identify(
            ctxWith({ headers: { "proxy-authorization": `Basic ${b64Bob}` } }),
          )
        ).passed,
      ).toBe(true);
      // 私有账号表里的错误口令一律拒绝
      expect(
        (
          await scoped.identify(
            ctxWith({
              headers: {
                "proxy-authorization": `Basic ${Buffer.from("bob:wrong").toString("base64")}`,
              },
            }),
          )
        ).passed,
      ).toBe(false);
      // 无凭证 → 拒绝（证明确实开着鉴权，而不是被全局的关闭状态放行）
      expect((await scoped.identify(ctxWith({ headers: {} }))).passed).toBe(false);

      // 全局 provider 不受私有 store 影响：仍按全局（关闭）放行
      const global = createIdentityFromConfig(testContext);
      expect(global.isEnabled).toBe(false);
      expect((await global.identify(ctxWith({ headers: {} }))).passed).toBe(true);

      // 全局配置全程未被改写
      expect(get("authEnabled")).toBe(false);
      expect(get("authType")).toBe("none");
    } finally {
      restoreConfig(prev);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});