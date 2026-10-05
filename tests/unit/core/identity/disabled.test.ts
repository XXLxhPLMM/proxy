/**
 * 账号禁用（`users.json` 的 `disabled`）：**认证点**的第二道判定，与 `expiresAt` 逐字同构
 *
 * @description
 * 本档只答「被禁用了到底发生什么」。形状校验（必须真的是布尔）在
 * `../../config/auth-users/expiry.test.ts`；锁的六件事（命中之后才判 / 禁用优先于过期 /
 * 被禁用账号仍在凭证索引里 / 显式 `false` 与缺省同义 / jwt 模式下不生效 / uid 模式同样生效）
 * 逐条列在 `AGENTS.md`。
 *
 * ⚠️ 「禁用优先于过期」要读的是**另一档**（`expires-at.test.ts`）—— 两个条件同时成立时报哪一个，
 * 只有两边都在场才是完整的那条判据。
 */

import { describe, expect, it } from "vitest";
import { FileAccountIdentity } from "@/core/identity.js";
import type { IdentityContext } from "@/core/types/identity.js";
import type { ProxyAuthEvent } from "@/core/types/proxy.js";
import { b64, ctxWith, signJwt } from "./_identity.js";

describe("identity/账号禁用 disabled", () => {
  const NOW = 1_800_000_000_000;

  const basic = (over: { disabled?: boolean; exp?: number } = {}): FileAccountIdentity =>
    new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [
        {
          username: "alice",
          password: "pw1",
          ...(over.disabled === undefined ? {} : { disabled: over.disabled }),
          ...(over.exp === undefined ? {} : { expiresAt: over.exp }),
        },
      ],
      now: () => NOW,
    });

  const auth = (): IdentityContext =>
    ctxWith({ headers: { "proxy-authorization": `Basic ${b64("alice:pw1")}` } });

  it("disabled: true → 拒绝，审计带 user + reason=account-disabled（不是「没凭证」）", async () => {
    const events: ProxyAuthEvent[] = [];
    const id = basic({ disabled: true });
    const result = await id.identify({ ...auth(), onAuthEvent: (e) => events.push(e) });

    expect(result.passed).toBe(false);
    // 拒绝结果**不回传 username**（与过期那条同形：身份没成立）
    expect(result).toEqual({ passed: false });
    expect(events).toHaveLength(1);
    expect(events[0]!.passed).toBe(false);
    // ⚠️ `user` 必须有：审计要能指名「我禁的是谁」，而 `attempted` 是「他自称是谁」——两者混了
    // 的话，被禁的运维在日志里看到的是一个无法对账的串
    expect(events[0]!.user).toBe("alice");
    expect(events[0]!.reason).toBe("account-disabled");
  });

  it("显式 disabled: false 与缺省同义，都放行并回传用户名", async () => {
    for (const over of [{ disabled: false }, {}]) {
      expect(await basic(over).identify(auth())).toEqual({ passed: true, username: "alice" });
    }
  });

  it("禁用优先于过期：两个条件都成立时报 account-disabled", async () => {
    const events: ProxyAuthEvent[] = [];
    const id = basic({ disabled: true, exp: NOW - 1 });
    await id.identify({ ...auth(), onAuthEvent: (e) => events.push(e) });
    expect(events[0]!.reason).toBe("account-disabled");
  });

  it("被禁用账号的凭证仍被出站剥离判据认出（凭据没被识别 ≠ 凭证不存在）", () => {
    // 这是**安全断言**：把被禁用的账号从凭证索引里剔除会让 isOwnCredential 返 false，
    // 于是它的 Proxy-Authorization 被原样转发给目标站。索引里没有它**不是漏洞** ——
    // 方向是「宁可多剥不泄漏」。
    const id = basic({ disabled: true });
    expect(id.isOwnCredential("authorization", `Basic ${b64("alice:pw1")}`)).toBe(true);
  });

  it("uid 模式同样生效（socks4 USERID 语义与 basic 共用这道判定）", async () => {
    const uid = new FileAccountIdentity({
      enabled: true,
      type: "uid",
      accounts: [{ username: "alice", password: "", disabled: true }],
      now: () => NOW,
    });
    const ctx = ctxWith({ protocol: "socks4", headers: { "proxy-authorization": "alice" } });
    expect((await uid.identify(ctx)).passed).toBe(false);
  });

  it("jwt 模式：账号表里的 disabled 不生效（用户名取自 sub，不查账号表）", async () => {
    // 同名账号 + `disabled: true` + 合法 token：**仍放行**。若哪天改成「jwt 也查账号表」，
    // 本条立刻红 —— 那正是启动期 `account-table-inert` 告警要提醒运维的那种假安全感，
    // 而且是那一族里最严重的一个：不是「到期了还在用」，是「以为封住了、其实没封」。
    const token = signJwt({ sub: "alice" }, "s3cr3t");
    const id = new FileAccountIdentity({
      enabled: true,
      type: "jwt",
      jwtSecret: "s3cr3t",
      jwtVerify: async () => true,
      accounts: [{ username: "alice", password: "pw1", disabled: true }],
      now: () => NOW,
    });
    const ctx = ctxWith({ headers: { "proxy-authorization": `Bearer ${token}` } });
    expect(await id.identify(ctx)).toEqual({ passed: true, username: "alice" });
  });

  it("none 模式恒放行（没有账号概念，禁用无从谈起）", async () => {
    const id = new FileAccountIdentity({
      enabled: true,
      type: "none",
      accounts: [{ username: "alice", password: "pw1", disabled: true }],
      now: () => NOW,
    });
    expect(id.isEnabled).toBe(false);
    expect((await id.identify(auth())).passed).toBe(true);
  });
});