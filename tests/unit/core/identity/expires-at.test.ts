/**
 * 账号有效期（`users.json` 的 `expiresAt`）：**认证点**的第二道判定
 *
 * @description
 * 本档只答「到点了到底发生什么」。形状校验（ISO 形态 fail-closed、已过期合法）在
 * `../config/auth-users/validate.test.ts`；锁的五件事（命中之后才判 / `>=` 边界 / 过期账号
 * 仍在凭证索引里 / jwt 模式下不生效 / 不追溯已建立的连接）逐条列在 `AGENTS.md`。
 *
 * ⚠️ `disabled` 与本档**逐字同构**（连「先 disabled 后 expiry」的顺序判据都相反着来），
 * 故它是另一档而不是并进来；两档合起来才是「第二道判定」这个论断。
 */

import { describe, expect, it } from "vitest";
import { FileAccountIdentity } from "@/core/identity.js";
import type { IdentityContext } from "@/core/types/identity.js";
import type { ProxyAuthEvent } from "@/core/types/proxy.js";
import { b64, ctxWith, signJwt } from "./_identity.js";

describe("identity/账号有效期 expiresAt", () => {
  const NOW = 1_800_000_000_000;

  const basic = (over: { now?: number; exp?: number } = {}): FileAccountIdentity =>
    new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [{ username: "alice", password: "pw1", ...(over.exp === undefined ? {} : { expiresAt: over.exp }) }],
      now: () => over.now ?? NOW,
    });

  /** 一条带正确 Basic 凭证的认证上下文（`onAuthEvent` 由各用例自己拼） */
  const auth = (): IdentityContext =>
    ctxWith({ headers: { "proxy-authorization": `Basic ${b64("alice:pw1")}` } });

  it("未到点放行并回传用户名；到点后拒绝且审计带 user + reason=account-expired", async () => {
    const before: ProxyAuthEvent[] = [];
    const ok = basic({ now: NOW, exp: NOW + 1000 });
    expect(await ok.identify({ ...auth(), onAuthEvent: (e) => before.push(e) })).toEqual({
      passed: true,
      username: "alice",
    });

    const after: ProxyAuthEvent[] = [];
    const expired = basic({ now: NOW, exp: NOW - 1 });
    expect((await expired.identify({ ...auth(), onAuthEvent: (e) => after.push(e) })).passed).toBe(
      false,
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.passed).toBe(false);
    // user 带出来是关键：运维据此答「这个号是被拒了」而不是「这个号不存在」
    expect(after[0]!.user).toBe("alice");
    expect(after[0]!.reason).toBe("account-expired");
  });

  it("边界是 >=：恰好等于到期时刻即拒（差一毫秒仍放行）", async () => {
    expect((await basic({ now: NOW, exp: NOW - 1 }).identify(auth())).passed).toBe(false);
    expect((await basic({ now: NOW, exp: NOW }).identify(auth())).passed).toBe(false);
    expect((await basic({ now: NOW, exp: NOW + 1 }).identify(auth())).passed).toBe(true);
  });

  it("过期账号的凭证仍被出站剥离判据认出（凭据没被识别 ≠ 凭证不存在）", () => {
    // 这是**安全断言**：把过期账号从索引里剔除会让 isOwnCredential 返 false，
    // 于是它的 Proxy-Authorization 被原样转发给目标站。
    const id = basic({ now: NOW, exp: NOW - 1 });
    expect(id.isOwnCredential("authorization", `Basic ${b64("alice:pw1")}`)).toBe(true);
  });

  it("uid 模式同样生效（socks4 USERID 语义与 basic 共用这道判定）", async () => {
    const uid = new FileAccountIdentity({
      enabled: true,
      type: "uid",
      accounts: [{ username: "alice", password: "", expiresAt: NOW - 1 }],
      now: () => NOW,
    });
    const ctx = ctxWith({
      protocol: "socks4",
      headers: { "proxy-authorization": "alice" },
    });
    expect((await uid.identify(ctx)).passed).toBe(false);
  });

  it("jwt 模式：账号表里的 expiresAt 不生效（用户名取自 sub，不查账号表）", async () => {
    // 同名账号 + 已过期 expiresAt + 合法 token：**仍放行**。若哪天改成「jwt 也查账号表」，
    // 本条立刻红 —— 那正是启动期 `account-table-inert` 告警要提醒运维的那种假安全感。
    const token = signJwt({ sub: "alice" }, "s3cr3t");
    const id = new FileAccountIdentity({
      enabled: true,
      type: "jwt",
      jwtSecret: "s3cr3t",
      jwtVerify: async () => true,
      accounts: [{ username: "alice", password: "pw1", expiresAt: NOW - 1 }],
      now: () => NOW,
    });
    const ctx = ctxWith({ headers: { "proxy-authorization": `Bearer ${token}` } });
    expect(await id.identify(ctx)).toEqual({ passed: true, username: "alice" });
  });

  it("none 模式恒放行（没有账号概念，过期无从谈起）", async () => {
    const id = new FileAccountIdentity({
      enabled: true,
      type: "none",
      accounts: [{ username: "alice", password: "pw1", expiresAt: NOW - 1 }],
      now: () => NOW,
    });
    expect(id.isEnabled).toBe(false);
    expect((await id.identify(auth())).passed).toBe(true);
  });

  it("缺 expiresAt 的账号永不过期（表里没有它 = 没有这道判定）", async () => {
    const id = basic({ now: NOW });
    expect(await id.identify(auth())).toEqual({ passed: true, username: "alice" });
  });
});