import { describe, expect, it } from "vitest";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { Auth, createAuthProvider } from "@/core/auth.js";
import type { AuthAccount, AuthContext } from "@/core/types/auth.js";
import type { ProxyAuthEvent } from "@/core/types/proxy.js";

/** base64 编码辅助：Basic 凭证的常见形态 */
function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

/** 构造账号 */
function acct(username: string, password: string): AuthAccount {
  return { username, password };
}

function ctxWith(over: {
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
  authority?: string;
  protocol?: string;
  method?: string;
  onAuthEvent?: (e: ProxyAuthEvent) => void;
}): AuthContext {
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

describe("auth/extractors (via Auth.authenticate)", () => {
  it("Header 优先 proxy-authorization，自动剥离 Basic/Bearer", async () => {
    const auth = new Auth({
      enabled: true,
      type: "basic",
      accounts: [acct("test", "123")],
      enableLogging: false,
    });
    expect(
      (
        await auth.authenticate(
          ctxWith({ headers: { "proxy-authorization": `Basic ${b64("test:123")}` } }),
        )
      ).passed,
    ).toBe(true);

    const jwt = new Auth({
      enabled: true,
      type: "jwt",
      jwtSecret: "s",
      jwtVerify: async (t) => t === "abc",
      enableLogging: false,
    });
    expect(
      (await jwt.authenticate(ctxWith({ headers: { authorization: "Bearer abc" } }))).passed,
    ).toBe(true);
    expect((await auth.authenticate(ctxWith({ headers: {} }))).passed).toBe(false);
  });

  it("头名大小写无关，数组值取首个非空", async () => {
    const auth = new Auth({
      enabled: true,
      type: "basic",
      accounts: [acct("test", "123")],
      enableLogging: false,
    });
    expect(
      (
        await auth.authenticate(
          ctxWith({ headers: { "Proxy-Authorization": `Basic ${b64("test:123")}` } }),
        )
      ).passed,
    ).toBe(true);
    expect(
      (
        await auth.authenticate(
          ctxWith({ headers: { "PROXY-AUTHORIZATION": ["", b64("test:123")] } }),
        )
      ).passed,
    ).toBe(true);
    expect((await auth.authenticate(ctxWith({ headers: { authorization: ["  "] } }))).passed).toBe(
      false,
    );
  });

  it("非标携带（Cookie/URL）不是 token", async () => {
    const auth = new Auth({
      enabled: true,
      type: "basic",
      accounts: [acct("u", "p")],
      enableLogging: false,
    });
    expect(
      (
        await auth.authenticate(
          ctxWith({ headers: { cookie: "token=abc123" }, url: "/?token=xyz" }),
        )
      ).passed,
    ).toBe(false);
  });
});

describe("auth/Auth", () => {
  it("enabled=false 直接放行且不带用户名", async () => {
    const auth = new Auth({ enabled: false, enableLogging: false });
    const r = await auth.authenticate(ctxWith({}));
    expect(r.passed).toBe(true);
    expect(r.username).toBeUndefined();
  });

  it("basic 比对 Base64 与明文均通过，并回传命中账号的用户名", async () => {
    const auth = new Auth({
      enabled: true,
      type: "basic",
      accounts: [acct("u", "p")],
      enableLogging: false,
    });
    expect(
      (
        await auth.authenticate(
          ctxWith({ headers: { "proxy-authorization": `Basic ${b64("u:p")}` } }),
        )
      ).username,
    ).toBe("u");
    expect(
      (await auth.authenticate(ctxWith({ headers: { "proxy-authorization": "u:p" } }))).passed,
    ).toBe(true);
  });

  it("basic 无 token / 错密码拒绝", async () => {
    const auth = new Auth({
      enabled: true,
      type: "basic",
      accounts: [acct("u", "p")],
      enableLogging: false,
    });
    expect((await auth.authenticate(ctxWith({}))).passed).toBe(false);
    expect(
      (
        await auth.authenticate(ctxWith({ headers: { "proxy-authorization": "Basic d3Jvbmc=" } }))
      ).passed,
    ).toBe(false);
  });

  it("多账号：任一账号命中即通过，且回传命中者（顺序无关）", async () => {
    const accounts = [acct("alice", "pw1"), acct("bob", "pw2"), acct("carol", "")];
    const auth = new Auth({ enabled: true, type: "basic", accounts, enableLogging: false });

    for (const a of accounts) {
      const r = await auth.authenticate(
        ctxWith({ headers: { "proxy-authorization": `Basic ${b64(`${a.username}:${a.password}`)}` } }),
      );
      expect(r.passed).toBe(true);
      expect(r.username).toBe(a.username);
    }

    // 密码不匹配：bob 的密码配 alice 的用户名必须拒
    expect(
      (
        await auth.authenticate(
          ctxWith({ headers: { "proxy-authorization": `Basic ${b64("alice:pw2")}` } }),
        )
      ).passed,
    ).toBe(false);
    // 不在表内的账号一律拒
    expect(
      (
        await auth.authenticate(
          ctxWith({ headers: { "proxy-authorization": `Basic ${b64("dave:pw")}` } }),
        )
      ).passed,
    ).toBe(false);
  });

  it("uid：命中任一账号用户名即通过（只比对用户名，密码忽略）", async () => {
    const auth = new Auth({
      enabled: true,
      type: "uid",
      accounts: [acct("alice", "pw1"), acct("bob", "")],
      enableLogging: false,
    });
    // 裸用户名 / user:pass / b64(user:pass) / b64(裸用户名) 四种形态；密码部分不参与判定
    const cases = ["alice", "bob", "alice:pw1", "alice:WRONGPASS", b64("alice"), b64("bob:")];
    for (const token of cases) {
      const r = await auth.authenticate(
        ctxWith({ headers: { "proxy-authorization": token }, protocol: "socks4" }),
      );
      expect(r.passed).toBe(true);
      expect(r.username === "alice" || r.username === "bob").toBe(true);
    }
    expect(
      (
        await auth.authenticate(
          ctxWith({ headers: { "proxy-authorization": "nobody" }, protocol: "socks4" }),
        )
      ).passed,
    ).toBe(false);
  });

  it("basic + socks4：USERID 承载裸用户名或 user:pass 时按 uid 形态放行", async () => {
    const auth = new Auth({
      enabled: true,
      type: "basic",
      accounts: [acct("alice", "pw1")],
      enableLogging: false,
    });
    expect(
      (
        await auth.authenticate(
          ctxWith({ headers: { "proxy-authorization": "alice" }, protocol: "socks4" }),
        )
      ).passed,
    ).toBe(true);
    // 明文/密文凭证同样放行
    expect(
      (
        await auth.authenticate(
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
        await auth.authenticate(
          ctxWith({ headers: { "proxy-authorization": "alice:anything" }, protocol: "socks4" }),
        )
      ).passed,
    ).toBe(true);
    // 用户名不在账号表内仍拒绝
    expect(
      (
        await auth.authenticate(
          ctxWith({ headers: { "proxy-authorization": "nobody:pw1" }, protocol: "socks4" }),
        )
      ).passed,
    ).toBe(false);
  });

  it("jwt 委托外部 verify，用户名取自 token 的 sub", async () => {
    const auth = new Auth({
      enabled: true,
      type: "jwt",
      jwtSecret: "s",
      jwtVerify: async (t, s) => t === "good" && s === "s",
      enableLogging: false,
    });
    const payload = Buffer.from(JSON.stringify({ sub: "alice" })).toString("base64url");
    const token = `header.${payload}.sig`;
    const ok = new Auth({
      enabled: true,
      type: "jwt",
      jwtSecret: "s",
      jwtVerify: async (t, s) => t === token && s === "s",
      enableLogging: false,
    });
    const r = await ok.authenticate(ctxWith({ headers: { authorization: `Bearer ${token}` } }));
    expect(r.passed).toBe(true);
    expect(r.username).toBe("alice");

    expect(
      (await auth.authenticate(ctxWith({ headers: { authorization: "Bearer bad" } }))).passed,
    ).toBe(false);
  });

  it("jwt 未注入 verify：按拒绝处理且审计 deny 照常落（异常不再逃逸 emit）", async () => {
    const events: ProxyAuthEvent[] = [];
    const auth = new Auth({ enabled: true, type: "jwt", jwtSecret: "s", enableLogging: true });

    expect(
      (
        await auth.authenticate(
          ctxWith({
            headers: { authorization: "Bearer x" },
            onAuthEvent: (e) => events.push(e),
          }),
        )
      ).passed,
    ).toBe(false);

    // verifyJwt 声明为 async，「未注入」的抛错转成 rejected Promise 后被 catch 成 false：
    // 审计事件必须仍然产生（此前同步抛错会越过 emit，整条 JWT 模式无任何审计）
    expect(events).toHaveLength(1);
    expect(events[0].passed).toBe(false);
    expect(events[0].reason).toBeUndefined();
  });

  it("createAuthProvider 工厂可用", async () => {
    const p = createAuthProvider({ enabled: false });
    expect((await p.authenticate(ctxWith({}))).passed).toBe(true);
  });

  it("scheme 大小写不敏感（RFC 7235）：basic/bearer 小写前缀同样剥离", async () => {
    const basic = new Auth({
      enabled: true,
      type: "basic",
      accounts: [acct("user", "pass")],
      enableLogging: false,
    });
    const token = b64("user:pass");
    expect(
      (
        await basic.authenticate(
          ctxWith({ headers: { "proxy-authorization": `basic ${token}` } }),
        )
      ).passed,
    ).toBe(true);
    expect(
      (
        await basic.authenticate(
          ctxWith({ headers: { "proxy-authorization": `BASIC ${token}` } }),
        )
      ).passed,
    ).toBe(true);

    const jwt = new Auth({
      enabled: true,
      type: "jwt",
      jwtSecret: "s",
      jwtVerify: async (t) => t === "abc",
      enableLogging: false,
    });
    expect(
      (await jwt.authenticate(ctxWith({ headers: { authorization: "bearer abc" } }))).passed,
    ).toBe(true);
  });

  it("空用户名账号不入索引：':','Og==','a','!' 等无意义向量一律拒绝", async () => {
    // 空用户名配置在 loader 层已被拦截；此处验证 Auth 侧的纵深防御：
    // 空用户名账号被跳过后索引为空，任何 token 都不可能命中
    const basic = new Auth({
      enabled: true,
      type: "basic",
      accounts: [acct("", "")],
      enableLogging: false,
    });
    for (const token of [":", "Og==", "a", "!"]) {
      expect(
        (await basic.authenticate(ctxWith({ headers: { "proxy-authorization": token } }))).passed,
      ).toBe(false);
    }

    const uid = new Auth({
      enabled: true,
      type: "uid",
      accounts: [acct("", "")],
      enableLogging: false,
    });
    for (const token of [":", "Og==", "a", "!"]) {
      expect(
        (await uid.authenticate(ctxWith({ headers: { "proxy-authorization": token } }))).passed,
      ).toBe(false);
    }

    // 空账号表同理：basic 一律拒（loader 会阻止这种配置启动）
    const empty = new Auth({ enabled: true, type: "basic", accounts: [], enableLogging: false });
    expect(
      (await empty.authenticate(ctxWith({ headers: { "proxy-authorization": "u:p" } }))).passed,
    ).toBe(false);
  });

  it("审计事件带 attempted（deny）/ user（allow），且不再有 expected", async () => {
    const events: ProxyAuthEvent[] = [];
    const auth = new Auth({
      enabled: true,
      type: "basic",
      accounts: [acct("alice", "pw1")],
      enableLogging: true,
    });
    const onAuthEvent = (e: ProxyAuthEvent): void => {
      events.push(e);
    };

    await auth.authenticate(
      ctxWith({ headers: { "proxy-authorization": b64("mallory:pw") }, onAuthEvent }),
    );
    expect(events[0].passed).toBe(false);
    expect(events[0].attempted).toBe("mallory");
    expect(events[0].user).toBeUndefined();
    expect("expected" in events[0]).toBe(false);

    await auth.authenticate(
      ctxWith({ headers: { "proxy-authorization": b64("alice:pw1") }, onAuthEvent }),
    );
    expect(events[1].passed).toBe(true);
    expect(events[1].user).toBe("alice");
  });

  it("tag 语义：仅 CONNECT 方法与 socks* 协议标 tunnel，普通带端口 Host 不误标", async () => {
    const auth = new Auth({
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
    await auth.authenticate(ctxWith({ method: "GET", authority: "example.com:8080", onAuthEvent }));
    // CONNECT 隧道
    await auth.authenticate(ctxWith({ method: "CONNECT", authority: "example.com:443", onAuthEvent }));
    // socks* 协议
    await auth.authenticate(
      ctxWith({ method: "GET", protocol: "socks5", authority: "socks5", onAuthEvent }),
    );
    expect(tags).toEqual(["", "tunnel", "tunnel"]);
  });
});
