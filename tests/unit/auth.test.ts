import { describe, expect, it } from "vitest";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { Auth, createAuthProvider } from "@/core/auth.js";
import type { AuthContext } from "@/core/types/auth.js";
import type { ProxyAuthEvent } from "@/core/types/proxy.js";

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
      username: "test",
      password: "123",
      enableLogging: false,
    });
    const b64 = Buffer.from("test:123").toString("base64");
    expect(
      await auth.authenticate(ctxWith({ headers: { "proxy-authorization": `Basic ${b64}` } })),
    ).toBe(true);
    const auth2 = new Auth({
      enabled: true,
      type: "jwt",
      jwtSecret: "s",
      jwtVerify: async (t) => t === "abc",
      enableLogging: false,
    });
    expect(await auth2.authenticate(ctxWith({ headers: { authorization: "Bearer abc" } }))).toBe(
      true,
    );
    expect(await auth.authenticate(ctxWith({ headers: {} }))).toBe(false);
  });

  it("头名大小写无关，数组值取首个非空", async () => {
    const auth = new Auth({
      enabled: true,
      type: "basic",
      username: "test",
      password: "123",
      enableLogging: false,
    });
    const b64 = Buffer.from("test:123").toString("base64");
    expect(
      await auth.authenticate(ctxWith({ headers: { "Proxy-Authorization": `Basic ${b64}` } })),
    ).toBe(true);
    const auth2 = new Auth({
      enabled: true,
      type: "jwt",
      jwtSecret: "s",
      jwtVerify: async (t) => t === "abc",
      enableLogging: false,
    });
    expect(await auth2.authenticate(ctxWith({ headers: { Authorization: "Bearer abc" } }))).toBe(
      true,
    );
    // 数组值取首个非空：proxy-authorization ["", "xyz"] 应提取 xyz，但与 expected 不匹配则拒绝
    const auth3 = new Auth({
      enabled: true,
      type: "basic",
      username: "xyz",
      password: "",
      enableLogging: false,
    });
    void auth3;
    // token "xyz" base64 为空密码场景，验证大小写/数组处理已在 Auth 内
    expect(
      await auth.authenticate(
        ctxWith({
          headers: { "PROXY-AUTHORIZATION": ["", Buffer.from("test:123").toString("base64")] },
        }),
      ),
    ).toBe(true);
    expect(await auth.authenticate(ctxWith({ headers: { authorization: ["  "] } }))).toBe(false);
  });

  it("非标携带（Cookie/URL）不是 token", async () => {
    const auth = new Auth({
      enabled: true,
      type: "basic",
      username: "u",
      password: "p",
      enableLogging: false,
    });
    expect(
      await auth.authenticate(ctxWith({ headers: { cookie: "token=abc123" }, url: "/?token=xyz" })),
    ).toBe(false);
  });
});

describe("auth/Auth", () => {
  it("enabled=false 直接放行", async () => {
    const auth = new Auth({ enabled: false, enableLogging: false });
    expect(await auth.authenticate(ctxWith({}))).toBe(true);
  });

  it("basic 比对 Base64 与明文均通过", async () => {
    const auth = new Auth({
      enabled: true,
      type: "basic",
      username: "u",
      password: "p",
      enableLogging: false,
    });
    const b64 = Buffer.from("u:p").toString("base64");
    expect(
      await auth.authenticate(ctxWith({ headers: { "proxy-authorization": `Basic ${b64}` } })),
    ).toBe(true);
    expect(await auth.authenticate(ctxWith({ headers: { "proxy-authorization": "u:p" } }))).toBe(
      true,
    );
  });

  it("basic 无 token / 错密码拒绝", async () => {
    const auth = new Auth({
      enabled: true,
      type: "basic",
      username: "u",
      password: "p",
      enableLogging: false,
    });
    expect(await auth.authenticate(ctxWith({}))).toBe(false);
    expect(
      await auth.authenticate(ctxWith({ headers: { "proxy-authorization": "Basic d3Jvbmc=" } })),
    ).toBe(false);
  });

  it("jwt 委托外部 verify", async () => {
    const auth = new Auth({
      enabled: true,
      type: "jwt",
      jwtSecret: "s",
      jwtVerify: async (t, s) => t === "good" && s === "s",
      enableLogging: false,
    });
    expect(await auth.authenticate(ctxWith({ headers: { authorization: "Bearer good" } }))).toBe(
      true,
    );
    expect(await auth.authenticate(ctxWith({ headers: { authorization: "Bearer bad" } }))).toBe(
      false,
    );
  });

  it("jwt 未注入 verify 直接抛错（由 BaseProxy.authorize 兜底为拒绝）", async () => {
    const auth = new Auth({ enabled: true, type: "jwt", jwtSecret: "s", enableLogging: false });
    await expect(
      auth.authenticate(ctxWith({ headers: { authorization: "Bearer x" } })),
    ).rejects.toThrow();
  });

  it("createAuthProvider 工厂可用", async () => {
    const p = createAuthProvider({ enabled: false });
    expect(await p.authenticate(ctxWith({}))).toBe(true);
  });

  it("scheme 大小写不敏感（RFC 7235）：basic/bearer 小写前缀同样剥离", async () => {
    const basic = new Auth({
      enabled: true,
      type: "basic",
      username: "user",
      password: "pass",
      enableLogging: false,
    });
    const b64 = Buffer.from("user:pass").toString("base64"); // dXNlcjpwYXNz
    expect(
      await basic.authenticate(ctxWith({ headers: { "proxy-authorization": `basic ${b64}` } })),
    ).toBe(true);
    expect(
      await basic.authenticate(ctxWith({ headers: { "proxy-authorization": `BASIC ${b64}` } })),
    ).toBe(true);

    const jwt = new Auth({
      enabled: true,
      type: "jwt",
      jwtSecret: "s",
      jwtVerify: async (t) => t === "abc",
      enableLogging: false,
    });
    expect(await jwt.authenticate(ctxWith({ headers: { authorization: "bearer abc" } }))).toBe(true);
  });

  it("空用户名不得通过：basic 的 ':' / 'Og==' 与 uid 的非法 base64 向量一律拒绝", async () => {
    const basic = new Auth({
      enabled: true,
      type: "basic",
      username: "",
      password: "",
      enableLogging: false,
    });
    // 空凭证默认：expectedPlain=":"、expectedB64="Og=="（修复前发 ':' 即通过）
    for (const token of [":", "Og==", "a", "!"]) {
      expect(
        await basic.authenticate(ctxWith({ headers: { "proxy-authorization": token } })),
      ).toBe(false);
    }

    const uid = new Auth({
      enabled: true,
      type: "uid",
      username: "",
      enableLogging: false,
    });
    // 非 base64 单字符解码为空串，会命中空 username（修复前 'a'/'!' 即通过）
    for (const token of [":", "Og==", "a", "!"]) {
      expect(
        await uid.authenticate(ctxWith({ headers: { "proxy-authorization": token } })),
      ).toBe(false);
    }

    // 空用户名但密码非空同样拒绝（真实用户名不应为空）
    const basicPw = new Auth({
      enabled: true,
      type: "basic",
      username: "",
      password: "p",
      enableLogging: false,
    });
    expect(
      await basicPw.authenticate(ctxWith({ headers: { "proxy-authorization": ":p" } })),
    ).toBe(false);
  });

  it("tag 语义：仅 CONNECT 方法与 socks* 协议标 tunnel，普通带端口 Host 不误标", async () => {
    const auth = new Auth({
      enabled: true,
      type: "basic",
      username: "u",
      password: "p",
      enableLogging: true,
    });
    const tags: string[] = [];
    const onAuthEvent = (e: ProxyAuthEvent): void => {
      tags.push(e.tag);
    };
    // 普通请求：Host 带端口（authority 含 ":"）不得标 tunnel
    await auth.authenticate(
      ctxWith({ method: "GET", authority: "example.com:8080", onAuthEvent }),
    );
    // CONNECT 隧道
    await auth.authenticate(
      ctxWith({ method: "CONNECT", authority: "example.com:443", onAuthEvent }),
    );
    // socks* 协议
    await auth.authenticate(
      ctxWith({ method: "GET", protocol: "socks5", authority: "socks5", onAuthEvent }),
    );
    expect(tags).toEqual(["", "tunnel ", "tunnel "]);
  });
});
