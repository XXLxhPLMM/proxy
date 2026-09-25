import { describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { ConfigStore } from "@/config/index.js";
import { get, set, testConfig } from "../helpers/config.js";
import { restoreConfig, snapshotConfig } from "../helpers/config.js";
import { configAccessorFromStore } from "@/config/index.js";
import {
  absoluteFormAuthority,
  buildConnectRequest,
  encodeBasicCredentials,
  formatAuthority,
  isJwtShape,
  isProxyCredentialValue,
  isSelfLoop,
  isStrippableOutboundHeader,
  isValidTargetHost,
  parseAuthority,
  parseTargetParts,
  resolveForwardTargets,
  resolveRoute,
  sanitizeHeaders,
  stripProxyHeaders,
  verifyHs256Jwt,
} from "@/core/helpers/index.js";
import { guardDialing } from "@/core/guard.js";
import { Dialer } from "@/core/forward/dial.js";

/** 签发 HS256 JWT（测试用最小签发器，与内置校验器 verifyHs256Jwt 共用 node:crypto HMAC） */
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

describe("core/proxy-helpers", () => {
  it("buildConnectRequest 拼出标准 CONNECT 报文", () => {
    const raw = buildConnectRequest("example.com", 443).toString();
    expect(raw).toContain("CONNECT example.com:443 HTTP/1.1\r\n");
    expect(raw).toContain("Host: example.com:443\r\n");
    expect(raw.endsWith("\r\n\r\n")).toBe(true);
  });

  it("buildConnectRequest 透传额外鉴权头", () => {
    const raw = buildConnectRequest(
      "example.com",
      443,
      "Proxy-Authorization: Basic dTpw",
    ).toString();
    expect(raw).toContain("Proxy-Authorization: Basic dTpw\r\n");
  });

  it("stripProxyHeaders 大小写无关去代理头，原地修改", () => {
    const headers = {
      host: "a.com",
      "Proxy-Authorization": "Basic x",
      "PROXY-CONNECTION": "keep-alive",
      "proxy-authenticate": "Basic realm=x",
      cookie: "a=1",
    };
    expect(stripProxyHeaders(headers, testConfig)).toBe(headers);
    expect(headers).toEqual({ host: "a.com", cookie: "a=1" });
  });

  it("sanitizeHeaders 洗掉 hop-by-hop 头并固定 connection", () => {
    const out = sanitizeHeaders(
      {
        host: "a.com",
        "proxy-authorization": "Basic x",
        "proxy-connection": "keep-alive",
        "Proxy-Authenticate": "Basic realm=x",
      },
      testConfig,
    );
    expect(out["proxy-authorization"]).toBeUndefined();
    expect(out["proxy-connection"]).toBeUndefined();
    expect(out["Proxy-Authenticate"]).toBeUndefined();
    expect(out.connection).toBe("close");
    expect(out.host).toBe("a.com");
  });

  it("parseTargetParts 绝对与相对写法", () => {
    expect(parseTargetParts("http://example.com/a?b=1", undefined)).toEqual({
      host: "example.com",
      port: 80,
      path: "/a?b=1",
    });
    expect(parseTargetParts("https://example.com:8443/x", undefined)).toEqual({
      host: "example.com",
      port: 8443,
      path: "/x",
    });
    expect(parseTargetParts("https://example.com", undefined)).toEqual({
      host: "example.com",
      port: 443,
      path: "/",
    });
    expect(parseTargetParts("/p", "example.com:9000")).toEqual({
      host: "example.com",
      port: 9000,
      path: "/p",
    });
    expect(parseTargetParts("/p", "example.com", "https:")).toEqual({
      host: "example.com",
      port: 443,
      path: "/p",
    });
    expect(parseTargetParts("/p")).toBeNull();
    expect(parseTargetParts("http://[::1", undefined)).toBeNull();
  });

  it("parseTargetParts 支持方括号 IPv6 与非法 authority", () => {
    // origin-form：方括号 IPv6 剥括号取裸地址，供 net.connect 直用
    expect(parseTargetParts("/p", "[::1]:8080")).toEqual({
      host: "::1",
      port: 8080,
      path: "/p",
    });
    expect(parseTargetParts("/p", "[::1]")).toEqual({ host: "::1", port: 80, path: "/p" });
    // 绝对 URL：u.hostname 带方括号也要剥掉
    expect(parseTargetParts("http://[2001:db8::1]:8080/x", undefined)).toEqual({
      host: "2001:db8::1",
      port: 8080,
      path: "/x",
    });
    expect(parseTargetParts("http://[2001:db8::1]/x", undefined)).toEqual({
      host: "2001:db8::1",
      port: 80,
      path: "/x",
    });
    // RFC 7230 §5.4：absolute-form 忽略 Host 头，缺显式端口按 scheme 默认（不从 Host 补端口）
    expect(parseTargetParts("http://example.com/x", "[2001:db8::1]:8443")).toEqual({
      host: "example.com",
      port: 80,
      path: "/x",
    });
    // 非法 Host 端口：非数字 / 空端口 / 越界 / 未闭合括号 → null（不静默回落默认端口）
    expect(parseTargetParts("/p", "example.com:abc")).toBeNull();
    expect(parseTargetParts("/p", "example.com:")).toBeNull();
    expect(parseTargetParts("/p", "example.com:0")).toBeNull();
    expect(parseTargetParts("/p", "example.com:65536")).toBeNull();
    expect(parseTargetParts("/p", "[::1")).toBeNull();
    // absolute-form 分支不再读 Host：非法 Host 也不影响解析结果
    expect(parseTargetParts("http://example.com/x", "example.com:abc")).toEqual({
      host: "example.com",
      port: 80,
      path: "/x",
    });
  });

  it("isValidTargetHost 白名单：拒绝 CRLF/空白/超长/分隔符主机", () => {
    expect(isValidTargetHost("example.com")).toBe(true);
    expect(isValidTargetHost("2001:db8::1")).toBe(true);
    expect(isValidTargetHost("::ffff:127.0.0.1")).toBe(true);
    expect(isValidTargetHost("")).toBe(false);
    expect(isValidTargetHost("example.com\r\nX-Injected: 1")).toBe(false);
    expect(isValidTargetHost("exa mple.com")).toBe(false);
    expect(isValidTargetHost("a".repeat(256))).toBe(false);
    expect(isValidTargetHost("example.com/evil")).toBe(false);
    expect(isValidTargetHost("user@host")).toBe(false);
  });

  it("buildConnectRequest 对注入/超长主机名抛错，不拼出畸形报文", () => {
    expect(() => buildConnectRequest("evil.com\r\nX-Injected: 1", 443)).toThrow();
    expect(() => buildConnectRequest("evil.com evil", 443)).toThrow();
    expect(() => buildConnectRequest("a".repeat(256), 443)).toThrow();
  });

  it("formatAuthority 拼装 authority，IPv6 补方括号", () => {
    expect(formatAuthority("example.com", 443)).toBe("example.com:443");
    expect(formatAuthority("127.0.0.1", 8080)).toBe("127.0.0.1:8080");
    expect(formatAuthority("::1", 443)).toBe("[::1]:443");
    expect(formatAuthority("2001:db8::1", 80)).toBe("[2001:db8::1]:80");
    // 已带方括号的输入原样保留（兼容手工配置 UPSTREAM_HOST=[::1]）
    expect(formatAuthority("[::1]", 443)).toBe("[::1]:443");
  });

  it("buildConnectRequest IPv6 目标：请求行与 Host 均为 [v6]:port", () => {
    const raw = buildConnectRequest("::1", 443).toString();
    expect(raw).toContain("CONNECT [::1]:443 HTTP/1.1\r\n");
    expect(raw).toContain("Host: [::1]:443\r\n");
    expect(raw.endsWith("\r\n\r\n")).toBe(true);
  });

  it("absoluteFormAuthority 只认 absolute-form，IPv6 保留方括号", () => {
    expect(absoluteFormAuthority("http://example.com:8080/x")).toBe("example.com:8080");
    expect(absoluteFormAuthority("https://[::1]:8443/x")).toBe("[::1]:8443");
    expect(absoluteFormAuthority("http://example.com/x")).toBe("example.com");
    expect(absoluteFormAuthority("/x")).toBeNull();
    expect(absoluteFormAuthority("ftp://example.com/x")).toBeNull();
  });

  it("sanitizeHeaders 剥离命中代理凭证的 Authorization，其余原样保留", () => {
    // 账号表改由 AUTH_USERS_FILE 指向的 users.json 承载（多账号），需临时造一份
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-helpers-users-"));
    const usersFile = path.join(dir, "users.json");
    fs.writeFileSync(
      usersFile,
      JSON.stringify([
        { username: "alice", password: "pw1" },
        { username: "bob", password: "pw2" },
      ]),
    );
    const prev = snapshotConfig(["authEnabled", "authType", "authUsersFile"]);
    try {
      set("authEnabled", true);
      set("authType", "basic");
      set("authUsersFile", usersFile);

      const aliceB64 = encodeBasicCredentials("alice", "pw1");
      const bobB64 = encodeBasicCredentials("bob", "pw2");

      // 多账号：每个账号的 Basic 凭证都必须被识别为代理自身凭证（只比对一个会泄漏其余账号）
      expect(isProxyCredentialValue(`Basic ${aliceB64}`, testConfig)).toBe(true);
      expect(isProxyCredentialValue(`Basic ${bobB64}`, testConfig)).toBe(true);
      expect(
        isProxyCredentialValue(`Basic ${Buffer.from("carol:pw3").toString("base64")}`, testConfig),
      ).toBe(false);
      expect(isProxyCredentialValue("Bearer target-token", testConfig)).toBe(false);

      expect(
        sanitizeHeaders({ host: "a.com", authorization: `Basic ${aliceB64}` }, testConfig)
          .authorization,
      ).toBeUndefined();
      expect(
        sanitizeHeaders({ host: "a.com", authorization: `Basic ${bobB64}` }, testConfig)
          .authorization,
      ).toBeUndefined();
      expect(
        sanitizeHeaders({ host: "a.com", authorization: "Bearer target-token" }, testConfig)
          .authorization,
      ).toBe("Bearer target-token");
    } finally {
      restoreConfig(prev);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("jwt 模式剥离：正确密钥的代理 JWT 视为代理凭证，错密钥/非三段/目标 token 保留", () => {
    // jwt 模式允许空账号表：把 AUTH_USERS_FILE 指向不存在的文件，验证剥离判据不依赖账号表
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-helpers-jwt-"));
    const prev = snapshotConfig(["authEnabled", "authType", "jwtSecret", "authUsersFile"]);
    try {
      set("authEnabled", true);
      set("authType", "jwt");
      set("jwtSecret", "proxy-secret");
      set("authUsersFile", path.join(dir, "missing.json"));

      const jwt = signJwt({ sub: "alice" }, "proxy-secret");
      const wrong = signJwt({ sub: "alice" }, "wrong-secret");

      // 命中：Bearer / 裸 JWT / 其他 scheme 前缀（Auth 侧同样剥 scheme 后验签）；空表也照样剥离
      expect(isProxyCredentialValue(`Bearer ${jwt}`, testConfig)).toBe(true);
      expect(isProxyCredentialValue(jwt, testConfig)).toBe(true);
      expect(isProxyCredentialValue(`Basic ${jwt}`, testConfig)).toBe(true);
      // 未命中：错密钥 / 非三段 / 三段但非合法 JWT / 目标站自己的 Bearer token
      expect(isProxyCredentialValue(`Bearer ${wrong}`, testConfig)).toBe(false);
      expect(isProxyCredentialValue("Bearer a.b", testConfig)).toBe(false);
      expect(isProxyCredentialValue("Bearer a.b.c", testConfig)).toBe(false);
      expect(isProxyCredentialValue("Bearer target-token", testConfig)).toBe(false);

      // sanitizeHeaders：命中的 Authorization 剥掉，未命中的原样保留
      expect(
        sanitizeHeaders({ host: "a.com", authorization: `Bearer ${jwt}` }, testConfig)
          .authorization,
      ).toBeUndefined();
      expect(
        sanitizeHeaders({ host: "a.com", authorization: `Bearer ${wrong}` }, testConfig)
          .authorization,
      ).toBe(`Bearer ${wrong}`);
      expect(
        sanitizeHeaders({ host: "a.com", authorization: "Bearer target-token" }, testConfig)
          .authorization,
      ).toBe("Bearer target-token");
      // Proxy-Authorization 始终剥离（任意 proxy- 前缀），与 jwt 判据无关
      expect(isStrippableOutboundHeader("Proxy-Authorization", `Bearer ${wrong}`, testConfig)).toBe(
        true,
      );
      expect(
        sanitizeHeaders({ host: "a.com", "proxy-authorization": `Bearer ${wrong}` }, testConfig)[
          "proxy-authorization"
        ],
      ).toBeUndefined();
    } finally {
      restoreConfig(prev);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isJwtShape / verifyHs256Jwt：形状判定与 HS256 同步验签（fail-closed、永不抛）", () => {
    const now = Math.floor(Date.now() / 1000);
    // 形状：恰三段
    expect(isJwtShape("a.b.c")).toBe(true);
    expect(isJwtShape("a.b")).toBe(false);
    expect(isJwtShape("abc")).toBe(false);
    expect(isJwtShape("a.b.c.d")).toBe(false);
    // 同步验签：签名正确且未过期放行（无 exp 也放行）
    const good = signJwt({ sub: "alice" }, "s3cr3t");
    expect(verifyHs256Jwt(good, "s3cr3t")).toBe(true);
    expect(verifyHs256Jwt(signJwt({ sub: "alice", exp: now + 60 }, "s3cr3t"), "s3cr3t")).toBe(true);
    // 空密钥 / 错密钥 / 签名篡改 / 过期 / 非有限 exp 一律拒绝
    expect(verifyHs256Jwt(good, "")).toBe(false);
    expect(verifyHs256Jwt(good, "other")).toBe(false);
    expect(verifyHs256Jwt(`${good}x`, "s3cr3t")).toBe(false);
    expect(verifyHs256Jwt(signJwt({ sub: "alice", exp: now - 60 }, "s3cr3t"), "s3cr3t")).toBe(
      false,
    );
    expect(verifyHs256Jwt(signJwt({ sub: "alice", exp: "soon" }, "s3cr3t"), "s3cr3t")).toBe(false);
    // 错算法 / 载荷非对象 / 垃圾字节 → false 且永不抛出
    expect(verifyHs256Jwt(signJwt({ sub: "alice" }, "s3cr3t", { alg: "RS256" }), "s3cr3t")).toBe(
      false,
    );
    expect(verifyHs256Jwt(signJwt("just-a-string", "s3cr3t"), "s3cr3t")).toBe(false);
    expect(verifyHs256Jwt("!!!.???.###", "s3cr3t")).toBe(false);
    expect(() => verifyHs256Jwt("a..b", "s3cr3t")).not.toThrow();
  });

  it("parseAuthority 支持 host / host:port / [v6] / [v6]:port", () => {
    expect(parseAuthority("example.com:443")).toEqual({ hostname: "example.com", port: 443 });
    expect(parseAuthority("example.com")).toEqual({ hostname: "example.com", port: 443 });
    expect(parseAuthority("example.com:8443")).toEqual({ hostname: "example.com", port: 8443 });
    expect(parseAuthority("[::1]:8443")).toEqual({ hostname: "::1", port: 8443 });
    expect(parseAuthority("[::1]")).toEqual({ hostname: "::1", port: 443 });
    expect(parseAuthority("[2001:db8::1]:80")).toEqual({ hostname: "2001:db8::1", port: 80 });
  });

  it("parseAuthority 非法形态返回 null", () => {
    // 显式空端口不再被 Number("")=0 误判为合法
    expect(parseAuthority("example.com:")).toBeNull();
    expect(parseAuthority(":443")).toBeNull();
    expect(parseAuthority("")).toBeNull();
    // 非数字 / 越界端口
    expect(parseAuthority("example.com:abc")).toBeNull();
    expect(parseAuthority("example.com:0")).toBeNull();
    expect(parseAuthority("example.com:65536")).toBeNull();
    // 裸 IPv6（无方括号）按文档不支持
    expect(parseAuthority("2001:db8::1")).toBeNull();
    // 未闭合方括号
    expect(parseAuthority("[::1")).toBeNull();
  });

  it("isSelfLoop 端口不同直接放行", () => {
    const prev = snapshotConfig(["host", "port"]);
    try {
      set("host", "127.0.0.1");
      set("port", 10001);
      expect(isSelfLoop("127.0.0.1", 10002, testConfig)).toBe(false);
      expect(isSelfLoop("127.0.0.1", 10001, testConfig)).toBe(true);
      expect(isSelfLoop("localhost", 10001, testConfig)).toBe(true);
    } finally {
      restoreConfig(prev);
    }
  });

  it("Dialer.bridge 双向透传且一端关闭带走另一端", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
    const a = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => a.once("connect", resolve));
    const b = await accepted;
    for (const s of [a, b]) s.on("error", () => {});
    new Dialer(testConfig).bridge(
      a as unknown as import("node:stream").Duplex,
      b as unknown as import("node:stream").Duplex,
    );

    const gotA = new Promise<string>((resolve) => a.once("data", (c) => resolve(c.toString())));
    b.write("hi-a");
    await expect(gotA).resolves.toContain("hi-a");

    const closedB = new Promise<void>((resolve) => b.once("close", resolve));
    a.destroy();
    await closedB;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // 双连接：c1<->s1（客户端腿），c2<->s2（上游腿）；guardDialing(c1, s2)
  // 兜底写进 c1，读端是 s1，避免 RST 竞态
  const mkLegs = async (): Promise<{
    c1: net.Socket;
    s1: net.Socket;
    s2: net.Socket;
    close: () => Promise<void>;
  }> => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const conns: net.Socket[] = [];
    server.on("connection", (s) => {
      s.on("error", () => {});
      conns.push(s);
    });
    const c1 = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => c1.once("connect", resolve));
    const c2 = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => c2.once("connect", resolve));
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (conns.length >= 2) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    const [s1, s2] = conns;
    for (const s of [c1, c2]) s.on("error", () => {});
    c2.destroy(); // c2 只用来占出第二条腿
    return {
      c1,
      s1,
      s2,
      close: () =>
        new Promise<void>((resolve) => {
          for (const s of [c1, s1, s2]) if (!s.destroyed) s.destroy();
          server.close(() => resolve());
        }),
    };
  };

  it("guardDialing 建链失败写兜底、建链后只断不断写", async () => {
    // 建链期上游 error -> 客户端腿收到兜底
    {
      const { c1, s1, s2, close } = await mkLegs();
      guardDialing(c1, s2, { logPrefix: "test", errorReply: "ERR-BOOM" });
      const data = new Promise<string>((resolve) => s1.once("data", (c) => resolve(c.toString())));
      s2.destroy(new Error("boom"));
      await expect(data).resolves.toContain("ERR-BOOM");
      await close();
    }

    // established 后上游 error -> 只断不断写
    {
      const { c1, s1, s2, close } = await mkLegs();
      const dial = guardDialing(c1, s2, { logPrefix: "test", errorReply: "ERR-BOOM" });
      dial.established();
      let leaked = "";
      s1.on("data", (c) => (leaked += c.toString()));
      const closedC1 = new Promise<void>((resolve) => c1.once("close", resolve));
      s2.destroy(new Error("boom"));
      await closedC1;
      expect(leaked).not.toContain("ERR-BOOM");
      await close();
    }
  });

  it("guardDialing keepClientOnFailure：失败只断上游，客户端留给调用方应答", async () => {
    // 置位：客户端必须存活且可写，否则调用方的 SOCKS 失败应答 / 502 写不出去
    {
      const { c1, s1, s2, close } = await mkLegs();
      guardDialing(c1, s2, {
        logPrefix: "test",
        timeoutReply: "",
        errorReply: "",
        keepClientOnFailure: true,
      });
      let got = "";
      s1.on("data", (c) => (got += c.toString()));
      s2.destroy(new Error("boom"));
      await new Promise((r) => setTimeout(r, 50));
      expect(c1.destroyed).toBe(false);
      c1.write("SOCKS-FAIL");
      await new Promise((r) => setTimeout(r, 50));
      expect(got).toBe("SOCKS-FAIL");
      await close();
    }

    // 未置位：空 reply 仍是连带销毁（Upgrade 等无报文可回场景），客户端应被关闭
    {
      const { c1, s2, close } = await mkLegs();
      guardDialing(c1, s2, { logPrefix: "test", timeoutReply: "", errorReply: "" });
      const closed = new Promise<void>((resolve) => c1.once("close", resolve));
      s2.destroy(new Error("boom"));
      await closed;
      expect(c1.destroyed).toBe(true);
      await close();
    }
  });
});

// ── ConfigAccessor 注入（core 配置读取端口）护栏 ──
// 追加于既有断言之后，不改动任何原有断言：证明 resolveRoute 真的读了注入的
// proxyMode 与名单，而不是全局值 —— 这是「多 Runtime 隔离」的最小可验证单元。
describe("proxy-helpers 注入 ConfigAccessor 后的路由判定", () => {
  it("resolveRoute 走注入的 proxyMode：私有 store 声明 client 即走上游分支", () => {
    const prev = snapshotConfig(["proxyMode"]);
    try {
      // 全局维持 server：不传访问器时必得直连（缺省行为与改造前一致）
      set("proxyMode", "server");
      expect(resolveRoute({ host: "a.example.com", port: 443 }, testConfig)).toEqual({
        mode: "server",
        route: "direct",
      });

      // 私有 store：proxyMode=client + aclFile 指向不存在路径（名单全空 → 走上游）
      const store = new ConfigStore({
        proxyMode: "client",
        upstreamHost: "10.9.9.9",
        upstreamPort: 8123,
        aclFile: path.join(os.tmpdir(), "proxy-helpers-missing-acl.json"),
      });
      const accessor = configAccessorFromStore(store);
      expect(resolveRoute({ host: "a.example.com", port: 443 }, accessor)).toEqual({
        mode: "client",
        route: "upstream",
      });

      // 同一判定经 resolveForwardTargets：dial 应指向该 store 的上游，dest 仍是真实目标
      const t = resolveForwardTargets("http://a.example.com/x", "a.example.com", accessor);
      expect(t?.dial).toEqual({ host: "10.9.9.9", port: 8123, path: "http://a.example.com/x" });
      expect(t?.dest).toEqual({ host: "a.example.com", port: 80, path: "/x" });
      expect(t?.route).toEqual({ mode: "client", route: "upstream" });

      // 关键：全局 proxyMode 全程未被改写，路由确实读了注入值
      expect(get("proxyMode")).toBe("server");
    } finally {
      restoreConfig(prev);
    }
  });

  it("isSelfLoop 走注入的监听地址：私有 store 换端口后自环判定随之改变", () => {
    const prev = snapshotConfig(["host", "port"]);
    try {
      set("host", "127.0.0.1");
      set("port", 10001);
      // 全局监听 127.0.0.1:10001 → 指回自己是自环
      expect(isSelfLoop("127.0.0.1", 10001, testConfig)).toBe(true);
      expect(isSelfLoop("127.0.0.1", 10002, testConfig)).toBe(false);

      // 私有 store 监听 127.0.0.1:20001：同一对地址的判定整个反过来
      const accessor = configAccessorFromStore(new ConfigStore({ host: "127.0.0.1", port: 20001 }));
      expect(isSelfLoop("127.0.0.1", 10001, accessor)).toBe(false);
      expect(isSelfLoop("127.0.0.1", 20001, accessor)).toBe(true);

      // 全局判定未被改写
      expect(get("port")).toBe(10001);
    } finally {
      restoreConfig(prev);
    }
  });
});
