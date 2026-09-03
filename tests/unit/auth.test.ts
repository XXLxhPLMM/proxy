import { describe, expect, it } from "vitest";
import type http from "node:http";
import type { Duplex } from "node:stream";
import {
  Auth,
  CompositeTokenExtractor,
  CookieTokenExtractor,
  HeaderTokenExtractor,
  UrlTokenExtractor,
  createAuthProvider,
  getToken,
} from "@/core/auth.js";
import type { AuthContext } from "@/core/auth.js";

function ctxWith(over: {
  headers?: http.IncomingHttpHeaders;
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

describe("auth/extractors", () => {
  it("Header 优先 proxy-authorization，自动剥离 Basic/Bearer", () => {
    const h = new HeaderTokenExtractor();
    expect(h.extract(ctxWith({ headers: { "proxy-authorization": "Basic dGVzdDoxMjM=" } }))).toBe("dGVzdDoxMjM=");
    expect(h.extract(ctxWith({ headers: { authorization: "Bearer abc" } }))).toBe("abc");
    expect(h.extract(ctxWith({ headers: {} }))).toBeUndefined();
  });

  it("Cookie 解析 7 别名并 decode", () => {
    const c = new CookieTokenExtractor();
    const ctx = ctxWith({ headers: { cookie: "foo=1; token=Bearer%20abc123; bar=2" } });
    expect(c.extract(ctx)).toBe("abc123");
    expect(c.extract(ctxWith({ headers: {} }))).toBeUndefined();
  });

  it("URL 仅解析带 ? 与 = 的 token 系列键", () => {
    const u = new UrlTokenExtractor();
    expect(u.extract(ctxWith({ url: "/?token=xyz" }))).toBe("xyz");
    expect(u.extract(ctxWith({ url: "example.com:443" }))).toBeUndefined();
    expect(u.extract(ctxWith({ url: "http://example.com/?auth=q" }))).toBe("q");
  });

  it("Composite 按 Header > Cookie > URL 优先级", async () => {
    const chain = new CompositeTokenExtractor([
      new HeaderTokenExtractor(),
      new CookieTokenExtractor(),
      new UrlTokenExtractor(),
    ]);
    const ctx = ctxWith({
      headers: { cookie: "token=from-cookie" },
      url: "/?token=from-url",
    });
    expect(await chain.extract(ctx)).toBe("from-cookie");
    expect(await getToken(ctxWith({ url: "/?token=only-url" }))).toBe("only-url");
  });
});

describe("auth/Auth", () => {
  it("enabled=false 直接放行", async () => {
    const auth = new Auth({ enabled: false, enableLogging: false });
    expect(await auth.authenticate(ctxWith({}))).toBe(true);
  });

  it("basic 比对 Base64 与明文均通过", async () => {
    const auth = new Auth({ enabled: true, type: "basic", username: "u", password: "p", enableLogging: false });
    const b64 = Buffer.from("u:p").toString("base64");
    expect(await auth.authenticate(ctxWith({ headers: { "proxy-authorization": `Basic ${b64}` } }))).toBe(true);
    expect(await auth.authenticate(ctxWith({ headers: { "proxy-authorization": "u:p" } }))).toBe(true);
  });

  it("basic 无 token / 错密码拒绝", async () => {
    const auth = new Auth({ enabled: true, type: "basic", username: "u", password: "p", enableLogging: false });
    expect(await auth.authenticate(ctxWith({}))).toBe(false);
    expect(await auth.authenticate(ctxWith({ headers: { "proxy-authorization": "Basic d3Jvbmc=" } }))).toBe(false);
  });

  it("jwt 委托外部 verify", async () => {
    const auth = new Auth({
      enabled: true,
      type: "jwt",
      jwtSecret: "s",
      jwtVerify: async (t, s) => t === "good" && s === "s",
      enableLogging: false,
    });
    expect(await auth.authenticate(ctxWith({ headers: { authorization: "Bearer good" } }))).toBe(true);
    expect(await auth.authenticate(ctxWith({ headers: { authorization: "Bearer bad" } }))).toBe(false);
  });

  it("jwt 未注入 verify 直接抛错（由 BaseProxy.authorize 兜底为拒绝）", async () => {
    const auth = new Auth({ enabled: true, type: "jwt", jwtSecret: "s", enableLogging: false });
    await expect(auth.authenticate(ctxWith({ headers: { authorization: "Bearer x" } }))).rejects.toThrow();
  });

  it("createAuthProvider 工厂可用", async () => {
    const p = createAuthProvider({ enabled: false });
    expect(await p.authenticate(ctxWith({}))).toBe(true);
  });
});
