/**
 * `FileAccountIdentity` 的判定真值表：`enabled` / `basic` / `uid` 四形态 / basic+socks4
 *
 * @description
 * 这一档答「凭证**比对**这一步发生什么」：哪几种载体形态被认、多账号下命中的是谁、拒绝长什么样。
 *
 * ⚠️ 三条不在这一档（拆开即假绿或散掉同一张表，理由见 `AGENTS.md`）：jwt 分支 →
 * `verify.test.ts`；scheme 大小写 / 空用户名向量 / 审计事件字段 / tag 语义 → `token-parsing.test.ts`；
 * `expiresAt` 与 `disabled` 两道认证点后置判定 → 各自一档。
 */

import { describe, expect, it } from "vitest";
import { FileAccountIdentity } from "@/core/identity.js";
import { acct, b64, ctxWith } from "./_identity.js";

describe("identity/FileAccountIdentity", () => {
  it("enabled=false 直接放行且不带用户名", async () => {
    const id = new FileAccountIdentity({ enabled: false, enableLogging: false });
    const r = await id.identify(ctxWith({}));
    expect(r.passed).toBe(true);
    expect(r.username).toBeUndefined();
  });

  it("basic 比对 Base64 与明文均通过，并回传命中账号的用户名", async () => {
    const id = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [acct("u", "p")],
      enableLogging: false,
    });
    expect(
      (
        await id.identify(
          ctxWith({ headers: { "proxy-authorization": `Basic ${b64("u:p")}` } }),
        )
      ).username,
    ).toBe("u");
    expect(
      (await id.identify(ctxWith({ headers: { "proxy-authorization": "u:p" } }))).passed,
    ).toBe(true);
  });

  it("basic 无 token / 错密码拒绝", async () => {
    const id = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [acct("u", "p")],
      enableLogging: false,
    });
    expect((await id.identify(ctxWith({}))).passed).toBe(false);
    expect(
      (await id.identify(ctxWith({ headers: { "proxy-authorization": "Basic d3Jvbmc=" } })))
        .passed,
    ).toBe(false);
  });

  it("多账号：任一账号命中即通过，且回传命中者（顺序无关）", async () => {
    const accounts = [acct("alice", "pw1"), acct("bob", "pw2"), acct("carol", "")];
    const id = new FileAccountIdentity({ enabled: true, type: "basic", accounts, enableLogging: false });

    for (const a of accounts) {
      const r = await id.identify(
        ctxWith({
          headers: { "proxy-authorization": `Basic ${b64(`${a.username}:${a.password}`)}` },
        }),
      );
      expect(r.passed).toBe(true);
      expect(r.username).toBe(a.username);
    }

    // 密码不匹配：bob 的密码配 alice 的用户名必须拒
    expect(
      (
        await id.identify(
          ctxWith({ headers: { "proxy-authorization": `Basic ${b64("alice:pw2")}` } }),
        )
      ).passed,
    ).toBe(false);
    // 不在表内的账号一律拒
    expect(
      (
        await id.identify(
          ctxWith({ headers: { "proxy-authorization": `Basic ${b64("dave:pw")}` } }),
        )
      ).passed,
    ).toBe(false);
  });

  it("uid：命中任一账号用户名即通过（只比对用户名，密码忽略）", async () => {
    const id = new FileAccountIdentity({
      enabled: true,
      type: "uid",
      accounts: [acct("alice", "pw1"), acct("bob", "")],
      enableLogging: false,
    });
    // 裸用户名 / user:pass / b64(user:pass) / b64(裸用户名) 四种形态；密码部分不参与判定
    const cases = ["alice", "bob", "alice:pw1", "alice:WRONGPASS", b64("alice"), b64("bob:")];
    for (const token of cases) {
      const r = await id.identify(
        ctxWith({ headers: { "proxy-authorization": token }, protocol: "socks4" }),
      );
      expect(r.passed).toBe(true);
      expect(r.username === "alice" || r.username === "bob").toBe(true);
    }
    expect(
      (
        await id.identify(
          ctxWith({ headers: { "proxy-authorization": "nobody" }, protocol: "socks4" }),
        )
      ).passed,
    ).toBe(false);
  });

  it("basic + socks4：USERID 承载裸用户名或 user:pass 时按 uid 形态放行", async () => {
    const id = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [acct("alice", "pw1")],
      enableLogging: false,
    });
    expect(
      (
        await id.identify(
          ctxWith({ headers: { "proxy-authorization": "alice" }, protocol: "socks4" }),
        )
      ).passed,
    ).toBe(true);
    // 明文/密文凭证同样放行
    expect(
      (
        await id.identify(
          ctxWith({
            headers: { "proxy-authorization": b64("alice:pw1") },
            protocol: "sockss4",
          }),
        )
      ).passed,
    ).toBe(true);
    // socks4 协议没有密码字段：USERID 形如 `user:xxx` 时只比对用户名（密码部分无从校验）
    expect(
      (
        await id.identify(
          ctxWith({ headers: { "proxy-authorization": "alice:anything" }, protocol: "socks4" }),
        )
      ).passed,
    ).toBe(true);
    // 用户名不在账号表内仍拒绝
    expect(
      (
        await id.identify(
          ctxWith({ headers: { "proxy-authorization": "nobody:pw1" }, protocol: "socks4" }),
        )
      ).passed,
    ).toBe(false);
  });
});