import { describe, expect, it } from "vitest";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { Auth, createAuthProvider } from "@/core/auth.js";
import type { AuthContext } from "@/core/types/auth.js";

function ctxWith(over: {
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
  authority?: string;
}): AuthContext {
  return {
    protocol: "http",
    req: {
      headers: over.headers ?? {},
      url: over.url ?? "/",
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage,
    socket: {} as unknown as Duplex,
    authority: over.authority ?? "example.com:80",
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
});
