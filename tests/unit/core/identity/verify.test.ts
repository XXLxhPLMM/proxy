/**
 * `FileAccountIdentity` 的 jwt 分支：外部 `verify` 委托、内置 HS256、生产路径接线
 *
 * @description
 * 这一档答「jwt 模式的凭证比对发生什么」：委托给谁、没委托时怎么拒、内置校验器的
 * fail-closed 面有多宽、`createIdentityFromConfig` 默认接的是哪一支。
 *
 * ⚠️ 「凭证比对」那半张表在 `file-account.test.ts`、「解析与 tag 语义」在
 * `token-parsing.test.ts`；拆开即假绿的理由与 `AGENTS.md` 里的对照表同源。
 */

import { describe, expect, it } from "vitest";
import {
  FileAccountIdentity,
  createIdentityFromConfig,
  defaultJwtVerify,
} from "@/core/identity.js";
import type { IdentityOptions, IdentityProvider } from "@/core/types/identity.js";
import type { ProxyAuthEvent } from "@/core/types/proxy.js";
import type { IdentityContext } from "@/core/types/identity.js";
import { set, testContext, restoreConfig, snapshotConfig } from "../../../helpers/config.js";
import { ctxWith, signJwt } from "./_identity.js";

describe("identity/FileAccountIdentity：外部 verify 与内置 HS256", () => {
  it("jwt 委托外部 verify，用户名取自 token 的 sub", async () => {
    const id = new FileAccountIdentity({
      enabled: true,
      type: "jwt",
      jwtSecret: "s",
      jwtVerify: async (t, s) => t === "good" && s === "s",
      enableLogging: false,
    });
    const payload = Buffer.from(JSON.stringify({ sub: "alice" })).toString("base64url");
    const token = `header.${payload}.sig`;
    const ok = new FileAccountIdentity({
      enabled: true,
      type: "jwt",
      jwtSecret: "s",
      jwtVerify: async (t, s) => t === token && s === "s",
      enableLogging: false,
    });
    const r = await ok.identify(ctxWith({ headers: { authorization: `Bearer ${token}` } }));
    expect(r.passed).toBe(true);
    expect(r.username).toBe("alice");

    expect(
      (await id.identify(ctxWith({ headers: { authorization: "Bearer bad" } }))).passed,
    ).toBe(false);
  });

  it("jwt 未注入 verify：按拒绝处理且审计 deny 照常落（异常不再逃逸 emit）", async () => {
    const events: ProxyAuthEvent[] = [];
    const id = new FileAccountIdentity({ enabled: true, type: "jwt", jwtSecret: "s", enableLogging: true });

    expect(
      (
        await id.identify(
          ctxWith({
            headers: { authorization: "Bearer x" },
            onAuthEvent: (e) => events.push(e),
          }),
        )
      ).passed,
    ).toBe(false);

    // verifyJwt 声明为 async，「未注入」的抛错转成 rejected Promise 后被 catch 成 false：
    // 审计事件必须仍然产生（同步抛错会越过 emit，整条 JWT 模式无任何审计）
    expect(events).toHaveLength(1);
    expect(events[0].passed).toBe(false);
    expect(events[0].reason).toBeUndefined();
  });

  it("defaultJwtVerify 内置 HS256 校验：签名/exp/空密钥/错算法全走 fail-closed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const good = signJwt({ sub: "alice" }, "s3cr3t");
    // 合法未过期放行（无 exp 也放行）
    expect(await defaultJwtVerify(good, "s3cr3t")).toBe(true);
    expect(
      await defaultJwtVerify(signJwt({ sub: "alice", exp: now + 60 }, "s3cr3t"), "s3cr3t"),
    ).toBe(true);
    // 空密钥 / 错密钥 / 签名篡改
    expect(await defaultJwtVerify(good, "")).toBe(false);
    expect(await defaultJwtVerify(good, "other")).toBe(false);
    expect(await defaultJwtVerify(`${good}x`, "s3cr3t")).toBe(false);
    // 非三段式 / 垃圾字节（永不抛出）
    expect(await defaultJwtVerify("not-a-jwt", "s3cr3t")).toBe(false);
    expect(await defaultJwtVerify("a.b", "s3cr3t")).toBe(false);
    expect(await defaultJwtVerify("!!!.???.###", "s3cr3t")).toBe(false);
    // alg 非 HS256（即便签名段按 HMAC 拼对）与 alg=none 一律拒绝
    expect(
      await defaultJwtVerify(signJwt({ sub: "alice" }, "s3cr3t", { alg: "RS256" }), "s3cr3t"),
    ).toBe(false);
    expect(
      await defaultJwtVerify(
        `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
          JSON.stringify({ sub: "alice" }),
        ).toString("base64url")}.`,
        "s3cr3t",
      ),
    ).toBe(false);
    // exp 过期 / 非有限数值拒绝
    expect(
      await defaultJwtVerify(signJwt({ sub: "alice", exp: now - 60 }, "s3cr3t"), "s3cr3t"),
    ).toBe(false);
    expect(await defaultJwtVerify(signJwt({ sub: "alice", exp: "soon" }, "s3cr3t"), "s3cr3t")).toBe(
      false,
    );
    // 载荷非 JSON 对象拒绝
    expect(await defaultJwtVerify(signJwt("just-a-string", "s3cr3t"), "s3cr3t")).toBe(false);
  });

  it("createIdentityFromConfig 默认接内置 JWT 校验：生产路径合法 token 放行、显式注入优先", async () => {
    const snap = snapshotConfig(["authEnabled", "authType", "jwtSecret", "authLogging"]);
    try {
      set("authEnabled", true);
      set("authType", "jwt");
      set("jwtSecret", "prod-secret");
      set("authLogging", false);
      // 形参是 CoreContext（三件套整体注入）而不是裸 ConfigAccessor：isOwnCredential 跑在
      // 出站头剥离热路径上，构造期持有比逐方法传参便宜。见 src/core/identity/factory.ts 文件头。
      const provider = createIdentityFromConfig(testContext) as IdentityProvider & {
        jwtVerify?: IdentityOptions["jwtVerify"];
      };
      const via = (authz: string): IdentityContext => ctxWith({ headers: { authorization: authz } });
      const now = Math.floor(Date.now() / 1000);

      // 回归护栏：jwtVerify 无人注入时 verifyJwt 恒抛错 -> AUTH_TYPE=jwt 生产恒 deny；
      // 修复后 createIdentityFromConfig 默认注入 defaultJwtVerify，合法 HS256 token 放行且回传用户名
      const good = signJwt({ sub: "alice", exp: now + 300 }, "prod-secret");
      const ok = await provider.identify(via(`Bearer ${good}`));
      expect(ok.passed).toBe(true);
      expect(ok.username).toBe("alice");

      // 错密钥签发 / 签名篡改 / 过期 / 缺 token 一律拒绝
      expect(
        (await provider.identify(via(`Bearer ${signJwt({ sub: "alice" }, "wrong")}`))).passed,
      ).toBe(false);
      expect(
        (await provider.identify(via(`Bearer ${good.slice(0, good.lastIndexOf("."))}.AAAA`)))
          .passed,
      ).toBe(false);
      expect(
        (
          await provider.identify(
            via(`Bearer ${signJwt({ sub: "alice", exp: now - 60 }, "prod-secret")}`),
          )
        ).passed,
      ).toBe(false);
      expect((await provider.identify(ctxWith({}))).passed).toBe(false);

      // 显式注入优先于内置：换成恒真校验器后非 JWT 形状 token 也放行
      provider.jwtVerify = async () => true;
      expect((await provider.identify(via("Bearer whatever"))).passed).toBe(true);
      // 注入位清空 = 回到未注入语义：verifyJwt 抛错被 catch 成拒绝（fail-closed）
      provider.jwtVerify = undefined;
      expect((await provider.identify(via(`Bearer ${good}`))).passed).toBe(false);
    } finally {
      restoreConfig(snap);
    }
  });
});