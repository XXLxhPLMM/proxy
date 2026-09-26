import { describe, expect, it } from "vitest";
import type http from "node:http";
import type { Duplex } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import {
  FileAccountIdentity,
  createIdentity,
  createIdentityFromConfig,
  defaultJwtVerify,
} from "@/core/identity.js";
import { ConfigStore } from "@/config/index.js";
import { get, set, testConfig, testContext, testContextFor } from "../helpers/config.js";
import { configAccessorFromStore } from "@/config/index.js";
import type {
  AuthAccount,
  IdentityContext,
  IdentityOptions,
  IdentityProvider,
} from "@/core/types/identity.js";
import type { ProxyAuthEvent } from "@/core/types/proxy.js";
import { restoreConfig, snapshotConfig } from "../helpers/config.js";

/** base64 编码辅助：Basic 凭证的常见形态 */
function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

/** 构造账号 */
function acct(username: string, password: string): AuthAccount {
  return { username, password };
}

/** 签发 HS256 JWT（测试用最小签发器，与内置校验器 defaultJwtVerify 共用 node:crypto HMAC） */
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

function ctxWith(over: {
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
  authority?: string;
  protocol?: string;
  method?: string;
  onAuthEvent?: (e: ProxyAuthEvent) => void;
}): IdentityContext {
  return {
    protocol: over.protocol ?? "http",
    req: {
      method: over.method,
      headers: over.headers ?? {},
      url: over.url ?? "/",
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage,
    socket: {} as unknown as Duplex,
    authority: over.authority ?? "example.com:80",
    onAuthEvent: over.onAuthEvent,
  };
}

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

  it("createIdentity 工厂可用", async () => {
    const p = createIdentity({ enabled: false }, testConfig);
    expect((await p.identify(ctxWith({}))).passed).toBe(true);
  });

  it("scheme 大小写不敏感（RFC 7235）：basic/bearer 小写前缀同样剥离", async () => {
    const basic = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [acct("user", "pass")],
      enableLogging: false,
    });
    const token = b64("user:pass");
    expect(
      (await basic.identify(ctxWith({ headers: { "proxy-authorization": `basic ${token}` } })))
        .passed,
    ).toBe(true);
    expect(
      (await basic.identify(ctxWith({ headers: { "proxy-authorization": `BASIC ${token}` } })))
        .passed,
    ).toBe(true);

    const jwt = new FileAccountIdentity({
      enabled: true,
      type: "jwt",
      jwtSecret: "s",
      jwtVerify: async (t) => t === "abc",
      enableLogging: false,
    });
    expect(
      (await jwt.identify(ctxWith({ headers: { authorization: "bearer abc" } }))).passed,
    ).toBe(true);
  });

  it("空用户名账号不入索引：':','Og==','a','!' 等无意义向量一律拒绝", async () => {
    // 空用户名配置在 loader 层已被拦截；此处验证身份门面侧的纵深防御：
    // 空用户名账号被跳过后索引为空，任何 token 都不可能命中
    const basic = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [acct("", "")],
      enableLogging: false,
    });
    for (const token of [":", "Og==", "a", "!"]) {
      expect(
        (await basic.identify(ctxWith({ headers: { "proxy-authorization": token } }))).passed,
      ).toBe(false);
    }

    const uid = new FileAccountIdentity({
      enabled: true,
      type: "uid",
      accounts: [acct("", "")],
      enableLogging: false,
    });
    for (const token of [":", "Og==", "a", "!"]) {
      expect(
        (await uid.identify(ctxWith({ headers: { "proxy-authorization": token } }))).passed,
      ).toBe(false);
    }

    // 空账号表同理：basic 一律拒（loader 会阻止这种配置启动）
    const empty = new FileAccountIdentity({ enabled: true, type: "basic", accounts: [], enableLogging: false });
    expect(
      (await empty.identify(ctxWith({ headers: { "proxy-authorization": "u:p" } }))).passed,
    ).toBe(false);
  });

  it("审计事件带 attempted（deny）/ user（allow），且不再有 expected", async () => {
    const events: ProxyAuthEvent[] = [];
    const id = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [acct("alice", "pw1")],
      enableLogging: true,
    });
    const onAuthEvent = (e: ProxyAuthEvent): void => {
      events.push(e);
    };

    await id.identify(
      ctxWith({ headers: { "proxy-authorization": b64("mallory:pw") }, onAuthEvent }),
    );
    expect(events[0].passed).toBe(false);
    expect(events[0].attempted).toBe("mallory");
    expect(events[0].user).toBeUndefined();
    expect("expected" in events[0]).toBe(false);

    await id.identify(
      ctxWith({ headers: { "proxy-authorization": b64("alice:pw1") }, onAuthEvent }),
    );
    expect(events[1].passed).toBe(true);
    expect(events[1].user).toBe("alice");
  });

  it("tag 语义：仅 CONNECT 方法与 socks* 协议标 tunnel，普通带端口 Host 不误标", async () => {
    const id = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [acct("u", "p")],
      enableLogging: true,
    });
    const tags: string[] = [];
    const onAuthEvent = (e: ProxyAuthEvent): void => {
      tags.push(e.tag);
    };
    // 普通请求：Host 带端口（authority 含 ":"）不得标 tunnel
    await id.identify(ctxWith({ method: "GET", authority: "example.com:8080", onAuthEvent }));
    // CONNECT 隧道
    await id.identify(
      ctxWith({ method: "CONNECT", authority: "example.com:443", onAuthEvent }),
    );
    // socks* 协议
    await id.identify(
      ctxWith({ method: "GET", protocol: "socks5", authority: "socks5", onAuthEvent }),
    );
    expect(tags).toEqual(["", "tunnel", "tunnel"]);
  });
});

// ── CoreContext 注入（core 依赖端口）护栏 ──
// 追加于既有断言之后，不改动任何原有断言：证明身份链路经注入的 context 读配置与账号表，
// 而不是全局单例 —— 「多 Runtime 隔离」在身份侧的最小可验证单元。
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
