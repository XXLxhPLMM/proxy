/**
 * 这一档管 `acl-inert` 告警的**正反四格真值表**：配了名单 + 注入替身报恰好一条，两条负向各零条。
 *
 * @module tests/integration/acl
 * 档级不变量（判据为什么是两个 AND、为什么必须是真 runtime 断言、与 `tests/unit/` 那一半的分工）
 * 见 `./AGENTS.md`；装配面见 `./inert-fixture.js`。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACL_INERT_DETAIL } from "@/core/log-events.js";
import { aclWarnings, countingAccess, freshAcl, live, startRuntime } from "./inert-fixture.js";

describe("acl-inert：配了 acl.json + 注入自定义 access", () => {
  it("恰好一条 acl-inert，且 message 就是文案常量（库路径）", async () => {
    const access = countingAccess();
    const aclFile = freshAcl({ target: { blacklist: ["203.0.113.9"] } });

    const warnings = await startRuntime({ aclFile, access });

    expect(aclWarnings(warnings)).toHaveLength(1);
    expect(aclWarnings(warnings)[0].message).toBe(ACL_INERT_DETAIL);
    // 注入的替身真的被判过（只断言「`runtime.services.access` 是我给的那个对象」证明的
    // 仅仅是赋值发生 —— 一份没人调用的替身照样通过）
    expect(live.runtime!.services.access).toBe(access);
  });

  it("真的在判名单：acl.json 的黑名单**没有**被内置引擎采信，替身说的是放行就放行", async () => {
    // 告警的价值全在这条上：它之所以必须报，是因为 acl.json 真的不生效。
    // 只断言「报了一条告警」而不验证「那份文件确实被忽略」，等于报了个假的。
    const aclFile = freshAcl({ target: { blacklist: ["203.0.113.9"] } });
    const access = countingAccess();
    await startRuntime({ aclFile, access });

    const lib = live.runtime!;
    // 替身说放行 ⇒ 放行（内置引擎对着同一个文件会判 `blacklist` 拒）
    expect(lib.options.access.checkTarget({ host: "203.0.113.9" })).toEqual({ allowed: true });
    expect(access.targetCalls).toHaveLength(1);
    // 对照组：默认实现对着同一份文件确实会拒 —— 证明「acl.json 写了东西」不是空话
    const { createFileAccessControl } = await import("@/core/access-control.js");
    const fileAccess = createFileAccessControl(lib.context.accessor);
    expect(fileAccess.checkTarget({ host: "203.0.113.9" })).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "global",
    });
  });

  it("只有 `upstream` 路由名单非空也算「配了」（文案点名的那一类失效也必须报）", async () => {
    const aclFile = freshAcl({ upstream: { whitelist: ["intranet.example.com"] } });
    const warnings = await startRuntime({ aclFile, access: countingAccess() });
    expect(aclWarnings(warnings)).toHaveLength(1);
  });
});

describe("acl-inert：配了 acl.json 但没有注入自定义 access → 零条", () => {
  it("走默认实现时**不报**（内置引擎真的在判那份名单，没有「有东西没生效」）", async () => {
    const aclFile = freshAcl({ target: { blacklist: ["203.0.113.9"] } });
    const warnings = await startRuntime({ aclFile });

    expect(aclWarnings(warnings)).toHaveLength(0);
    // 正向证据：默认实现真的在按那份文件判定（否则这条只是「什么都没发生」）
    expect(live.runtime!.options.access.checkTarget({ host: "203.0.113.9" })).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "global",
    });
  });
});

describe("acl-inert：没配 acl.json 但注入了自定义 access → 零条", () => {
  it("整份缺失 → 零条（注入替身是常态，不该报）", async () => {
    const warnings = await startRuntime({
      aclFile: path.join(live.dir, "definitely-absent.json"),
      access: countingAccess(),
    });
    expect(aclWarnings(warnings)).toHaveLength(0);
  });

  it("文件在但三组全空 → 零条（判据看「非空」不看「文件在不在」）", async () => {
    const aclFile = freshAcl({
      clientIp: {},
      target: { whitelist: [], blacklist: [] },
      upstream: {},
    });
    const warnings = await startRuntime({ aclFile, access: countingAccess() });
    expect(aclWarnings(warnings)).toHaveLength(0);
  });
});