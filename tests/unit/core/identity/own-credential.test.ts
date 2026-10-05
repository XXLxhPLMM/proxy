/**
 * 判据与识别同源 + 内置四插件的 `isOwnCredential` 真值表
 *
 * @description
 * 两条：`FileAccountIdentity` 的判据与 `identify` 读**同一份**事实（`jwtSecret` / `jwtVerify`
 * 各只读一处、`isEnabled` 是同一个开关、动态门面共用同一个 `live()` 闭包），以及四个内置模式
 * 插件各自的判据真值表。
 *
 * ⚠️ 「两份真相 = 凭证泄漏」是这一族的主论断，故同源那几条与真值表那几条**必须同档**。
 * 端口形状的必填性由 `@ts-expect-error` 在**编译期**钉（`typecheck` 那一关）。见 `AGENTS.md`。
 */

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  FileAccountIdentity,
  basicIdentity,
  createIdentityFromConfig,
  jwtIdentity,
  noneIdentity,
  uidIdentity,
} from "@/core/identity.js";
import type { IdentityProvider } from "@/core/types/identity.js";
import { codeOnly, offendingLines, sourceOf } from "../../../helpers/source-scan.js";
import { testContext } from "../../../helpers/config.js";

/** 签发 HS256 JWT（与内置 `verifyHs256Jwt` 共用 node:crypto HMAC，锁的是同一条验签路径） */
function signJwt(
  payload: unknown,
  secret: string,
  header: { alg: string; typ?: string } = { alg: "HS256", typ: "JWT" },
): string {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

// ---------------------------------------------------------------------------
// 判据与识别同源
// ---------------------------------------------------------------------------

describe("FileAccountIdentity：isOwnCredential 与 identify 同源（两份真相 = 凭证泄漏）", () => {
  it("jwtSecret 只读一份：判据与识别用同一个 `this.jwtSecret`", () => {
    // 旧判据读的是 `config.get("jwtSecret")`，而 `Auth` 的验签走**注入的** `this.jwtVerify`
    // ——两条路径读**两份真相**。注入的校验器一旦不用配置里那个 JWT_SECRET（密钥轮换中的
    // 旧密钥、公钥验签），判据就会拿错密钥去验。现在判据读本实例的 `this.jwtSecret`。
    const token = signJwt({ sub: "alice" }, "s3cr3t");
    const id = new FileAccountIdentity({
      enabled: true,
      type: "jwt",
      jwtSecret: "s3cr3t",
      // 注入一个恒真的校验器：识别侧会放行**任何**东西
      jwtVerify: async () => true,
    });

    // 判据只认本实例的密钥签名出来的 token
    expect(id.isOwnCredential("authorization", `Bearer ${token}`)).toBe(true);
    expect(id.isOwnCredential("authorization", `Bearer ${signJwt({ sub: "x" }, "other")}`)).toBe(
      false,
    );
    // 而 `jwtVerify` 注入位只有一处：`createIdentityFromConfig` 的动态代理经它回写
    expect(id.jwtVerify).toBeTypeOf("function");
  });

  it("isEnabled 与识别的早退是同一个开关（消费方只读这一个字段）", () => {
    // 端口口径是「本实例会不会拒绝任何人」，故 `type === "none"` 已并进 `isEnabled`。
    // 若这两处不是同一个事实，症状是「isEnabled 说判人、而识别模板方法放行」。
    const off = new FileAccountIdentity({ enabled: false, type: "basic" });
    const on = new FileAccountIdentity({ enabled: true, type: "basic" });
    const none = new FileAccountIdentity({ enabled: true, type: "none" });

    expect(off.isEnabled).toBe(false);
    expect(on.isEnabled).toBe(true);
    // `AUTH_ENABLED=true` + `AUTH_TYPE=none` 从此只有一个答案
    expect(none.isEnabled).toBe(false);
  });

  it("isOwnCredential 的 `enabled` 门禁与 identify 的早退是同一行（源码级）", () => {
    // 防「判据放行、识别拒绝」或反过来的分叉：两条路径都读 `this.isEnabled`，
    // 而不是各写一份 `enabled && type !== "none"`。
    const code = codeOnly(sourceOf("core", "identity", "file-account.ts"));

    expect(code).toMatch(/isOwnCredential\([^)]*\)\s*:\s*boolean\s*\{\s*if\s*\(\s*!this\.isEnabled\s*\)/);
    // 且全文只有一处 isEnabled 的 getter 定义（不存在「第二个真相」的写法）
    expect((code.match(/get\s+isEnabled\s*\(\)/g) ?? []).length).toBe(1);
  });

  it("FileAccountIdentity 零配置读取（不 import @/config/index.js、零 config.get）", () => {
    const code = codeOnly(sourceOf("core", "identity", "file-account.ts"));

    expect(code).not.toMatch(/@\/config\//);
    expect(offendingLines(code, /\.get\s*\(/)).toEqual([]);
    // 读配置是 `createIdentityFromConfig` 的活（配置驱动的动态门面），不是本类的
    expect(code).not.toContain("loadAuthUsers");
  });

  it("动态门面：isOwnCredential 与 identify 共用同一个 live 闭包（热改配置同步生效）", () => {
    // `createIdentityFromConfig` 每次判定现造一份 FileAccountIdentity 快照，
    // `isOwnCredential` 与 `identify` 都要走那个**同一个** `live()` 闭包。
    // 若两者各读一份，「能过鉴权的凭证没被剥」的老问题就回来了。
    const code = codeOnly(sourceOf("core", "identity", "factory.ts"));
    const live = code.slice(code.indexOf("const live = (): FileAccountIdentity =>"));
    const liveBody = live.slice(0, live.indexOf("});"));

    for (const key of ["authEnabled", "authType", "jwtSecret", "loadAuthUsers"]) {
      expect(liveBody, `live() 闭包必须现读 ${key}`).toContain(key);
    }
    // 判据与识别都经 live()（而不是快照 snap）
    expect(code).toMatch(/isOwnCredential\([^)]*\)\s*:\s*boolean\s*\{\s*return\s+live\(\)\.isOwnCredential/);
    expect(code).toMatch(/async\s+identify\([^)]*\)\s*\{[\s\S]{0,80}return\s+live\(\)\.identify/);
  });

  it("createIdentityFromConfig 的 jwtVerify 注入位透传（动态代理上有同名单的 getter/setter）", () => {
    const code = codeOnly(sourceOf("core", "identity", "factory.ts"));

    expect(code).toMatch(/get\s+jwtVerify\s*\(\)/);
    expect(code).toMatch(/set\s+jwtVerify\s*\(/);
    // 缺省观察面经形参注入（不塞进 CoreContext：那是只读三件套视图，不是订阅注册表）
    expect(code).toContain("onFileEvent");
  });

  it("端口形状本身：isOwnCredential 是必填成员（漏实现编译期红）", () => {
    // 这条是**编译期**断言：`IdentityProvider` 上没有默认实现，替身少写一个成员就红。
    // 上面 apiKeyIdentity / 内置插件都实现了它，缺一个都过不了 typecheck。
    const provider: IdentityProvider = {
      kind: "minimal",
      isEnabled: true,
      isOwnCredential: () => false,
      identify: async () => ({ passed: true }),
    };
    expect(provider.isOwnCredential("authorization", "x")).toBe(false);

    // @ts-expect-error isOwnCredential 是必填：默认实现必然是「恒 false = 永不剥离」，
    // 那正是凭证泄漏的形态，宁可编译期红。
    const missing: IdentityProvider = {
      kind: "incomplete",
      isEnabled: true,
      identify: async () => ({ passed: true }),
    };
    expect(missing).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 内置四个模式插件的判据真值表
// ---------------------------------------------------------------------------

describe("内置四个模式插件的 isOwnCredential 真值表", () => {
  it("noneIdentity：恒 false（从不校验凭证就没有「自己的凭证」）", () => {
    const none = noneIdentity();

    expect(none.kind).toBe("none");
    expect(none.isEnabled).toBe(false);
    for (const [name, value] of [
      ["authorization", "Basic YWxpY2U6cHcx"],
      ["authorization", "Bearer eyJ..."],
      ["x-api-key", "anything"],
    ] as const) {
      expect(none.isOwnCredential(name, value), `none 对 ${name} 恒不剥离`).toBe(false);
    }
  });

  it("basicIdentity：与**整份**账号表比对（多账号下只比一个 = 其余账号凭证泄漏）", () => {
    const basic = basicIdentity({
      accounts: [
        { username: "alice", password: "pw1" },
        { username: "bob", password: "pw2" },
        { username: "carol", password: "" },
      ],
    });

    // 每个账号都要命中
    for (const [u, p] of [
      ["alice", "pw1"],
      ["bob", "pw2"],
      ["carol", ""],
    ]) {
      expect(basic.isOwnCredential("authorization", `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`)).toBe(
        true,
      );
    }
    // 密码错配 / 不在表内 / 目标的 Bearer 一律不命中
    expect(basic.isOwnCredential("authorization", `Basic ${Buffer.from("alice:pw2").toString("base64")}`)).toBe(
      false,
    );
    expect(basic.isOwnCredential("authorization", `Basic ${Buffer.from("dave:pw").toString("base64")}`)).toBe(
      false,
    );
    expect(basic.isOwnCredential("authorization", "Bearer target-token")).toBe(false);
    // 非 authorization 头名恒 false（`proxy-` 前缀由独立宽规则处理，不归本方法）
    expect(basic.isOwnCredential("Proxy-Authorization", `Basic ${Buffer.from("alice:pw1").toString("base64")}`)).toBe(
      false,
    );
  });

  it("basicIdentity：空账号表恒判否（显式失败，而不是「碰巧没匹配上」）", () => {
    const empty = basicIdentity({ accounts: [] });
    const b64 = Buffer.from("alice:pw1").toString("base64");

    expect(empty.isOwnCredential("authorization", `Basic ${b64}`)).toBe(false);
    expect(empty.isOwnCredential("authorization", b64)).toBe(false);
  });

  it("uidIdentity：四形态都命中，密码不参与判定", () => {
    const uid = uidIdentity({ accounts: [{ username: "test", password: "ignored" }] });
    const b64 = Buffer.from("test:whatever").toString("base64");
    const b64User = Buffer.from("test").toString("base64");

    // 裸用户名 / user:pass / b64(user:pass) / b64(裸用户名)
    for (const token of ["test", "test:whatever", "test:WRONGPASS", b64, b64User]) {
      expect(
        uid.isOwnCredential("authorization", token),
        `uid 四形态之一：${token}`,
      ).toBe(true);
    }
    expect(uid.isOwnCredential("authorization", "nobody")).toBe(false);
    expect(uid.isOwnCredential("authorization", "Bearer target-token")).toBe(false);
  });

  it("uidIdentity：空账号表恒判否", () => {
    const empty = uidIdentity({ accounts: [] });

    expect(empty.isOwnCredential("authorization", "test")).toBe(false);
    expect(empty.isOwnCredential("authorization", Buffer.from("test:pw").toString("base64"))).toBe(
      false,
    );
  });

  it("jwtIdentity：正确密钥的 token 命中（含空账号表）；错密钥/非三段/目标 token 不命中", () => {
    // jwt 允许空账号表：判据走内置 HS256 验签形状判定，不查账号表
    const secret = "proxy-secret";
    const jwt = jwtIdentity({ secret, verify: async () => true });
    const good = signJwt({ sub: "alice" }, secret);
    const wrong = signJwt({ sub: "alice" }, "wrong-secret");

    expect(jwt.isOwnCredential("authorization", `Bearer ${good}`)).toBe(true);
    expect(jwt.isOwnCredential("authorization", good)).toBe(true);
    expect(jwt.isOwnCredential("authorization", `Basic ${good}`)).toBe(true);
    expect(jwt.isOwnCredential("authorization", `Bearer ${wrong}`)).toBe(false);
    expect(jwt.isOwnCredential("authorization", "Bearer a.b")).toBe(false);
    expect(jwt.isOwnCredential("authorization", "Bearer a.b.c")).toBe(false);
    expect(jwt.isOwnCredential("authorization", "Bearer target-token")).toBe(false);
  });

  it("jwtIdentity：判据**不调用**注入的异步 verify（同步判据 await 不了 Promise）", () => {
    // 这是端口形状的账，必须被写下来：注入别的校验器（RS256 / 远端 JWKS）时，
    // 「它放行但内置 HS256 不认」的 token 不会被剥离。方向是「宁可多剥不泄漏」，
    // 不是「绝不误剥」。真要修得让端口另给剥离路径一个**同步**结论（形状变更）。
    let verifyCalls = 0;
    const jwt = jwtIdentity({
      secret: "proxy-secret",
      verify: async () => {
        verifyCalls += 1;
        return true;
      },
    });

    expect(jwt.isOwnCredential("authorization", `Bearer ${signJwt({ sub: "a" }, "proxy-secret")}`)).toBe(
      true,
    );
    expect(verifyCalls, "同步判据绝不许调异步校验器（否则返回值只能是恒 false）").toBe(0);
  });

  it("jwtIdentity：空账号表照样剥离（jwt 分支必须先于空表早退）", () => {
    // 顺序反了的后果：客户端用 `Authorization: Bearer <代理JWT>` 认证时，
    // 该 JWT 会被原样转发给目标站（`extractToken` 的 Authorization 回退正是这么取的）。
    const jwt = jwtIdentity({ secret: "s", verify: async () => true });
    const good = signJwt({ sub: "alice" }, "s");

    expect(jwt.isOwnCredential("authorization", `Bearer ${good}`)).toBe(true);
  });

  it("四个插件的 kind 各自透出（消费方只读 isEnabled，kind 供展示/审计）", () => {
    expect(noneIdentity().kind).toBe("none");
    expect(basicIdentity({ accounts: [] }).kind).toBe("basic");
    expect(uidIdentity({ accounts: [] }).kind).toBe("uid");
    expect(jwtIdentity({ secret: "s", verify: async () => true }).kind).toBe("jwt");
  });

  it("配置驱动的动态门面：空账号表 + authType=basic 时判否，authType=none 时恒判否", () => {
    // 缺省档在 setup-env 里是 AUTH_ENABLED=false，故这里只断言「type=none 一律不剥离」
    // 这条不依赖任何临时状态的事实（配置驱动门面每次现读 live store）。
    const live = createIdentityFromConfig(testContext);

    expect(live.isEnabled).toBe(false);
    expect(live.isOwnCredential("authorization", `Basic ${Buffer.from("alice:pw1").toString("base64")}`)).toBe(
      false,
    );
  });
});