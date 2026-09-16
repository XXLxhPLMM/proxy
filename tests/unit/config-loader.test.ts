import { describe, expect, it } from "vitest";
import { parseStartupArgs } from "@/config/loader.js";
import { parseUpstreamUrl, applyUpstreamUrl } from "@/utils/upstream-url.js";

describe("config/loader parseStartupArgs", () => {
  it("支持 --key value / --key=value / KEY=VALUE 三种写法", () => {
    expect(parseStartupArgs(["--port", "8080"]).port).toBe(8080);
    expect(parseStartupArgs(["--port=8081"]).port).toBe(8081);
    expect(parseStartupArgs(["PORT=8082"]).port).toBe(8082);
  });

  it("短横线归一为下划线大写，枚举大小写不敏感", () => {
    expect(parseStartupArgs(["--proxy-protocol", "SOCKS5"]).proxyProtocol).toBe("socks5");
    expect(parseStartupArgs(["--log-level=DEBUG"]).logLevel).toBe("debug");
  });

  it("无值 flag 视为 true", () => {
    expect(parseStartupArgs(["--auth-enabled"]).authEnabled).toBe(true);
  });

  it("别名首命中生效", () => {
    expect(parseStartupArgs(["--proxy-type", "sockss5"]).proxyProtocol).toBe("sockss5");
    expect(parseStartupArgs(["PROXY_TYPE=http"]).proxyProtocol).toBe("http");
  });

  it("显式给出的非法 CLI 值直接抛错，不静默回退", () => {
    expect(() => parseStartupArgs(["--port", "not-a-number"])).toThrow(/配置校验失败/);
    expect(() => parseStartupArgs(["--proxy-protocol", "banana"])).toThrow(/配置校验失败/);
    expect(() => parseStartupArgs(["--port", ""])).toThrow(/配置校验失败/);
  });

  it("布尔拼写错误不再静默当成 false（AUTH_ENABLED=treu 会关掉鉴权）", () => {
    expect(() => parseStartupArgs(["--auth-enabled", "treu"])).toThrow(/AUTH_ENABLED=treu/);
    expect(parseStartupArgs(["--auth-enabled", "yes"]).authEnabled).toBe(true);
    expect(parseStartupArgs(["--auth-enabled", "0"]).authEnabled).toBe(false);
  });

  it("--mode true/1 兼容为 client", () => {
    expect(parseStartupArgs(["--mode", "true"]).proxyMode).toBe("client");
    expect(parseStartupArgs(["--mode", "1"]).proxyMode).toBe("client");
    expect(parseStartupArgs(["--mode", "server"]).proxyMode).toBe("server");
  });

  it("未知 key 直接忽略", () => {
    expect(parseStartupArgs(["--whatever", "1"])).toEqual({});
  });

  it("--upstream-url 合法值保留原串，非法值抛错", () => {
    expect(parseStartupArgs(["--upstream-url", "https://u:p@h:8443"]).upstreamUrl).toBe(
      "https://u:p@h:8443",
    );
    expect(() => parseStartupArgs(["--upstream-url", "ftp://h"])).toThrow(/配置校验失败/);
    expect(() => parseStartupArgs(["--upstream-url", "not a url"])).toThrow(/配置校验失败/);
  });
});

describe("config/loader parseUpstreamUrl", () => {
  it("合法形式：scheme 白名单 + 缺省 host/port 均通过", () => {
    expect(parseUpstreamUrl("http://example.com")).toBe("http://example.com");
    expect(parseUpstreamUrl("https://uuuu:pppp@xxxx.xxxx:8443")).toBe(
      "https://uuuu:pppp@xxxx.xxxx:8443",
    );
    expect(parseUpstreamUrl("socks5://h:1080")).toBe("socks5://h:1080");
    expect(parseUpstreamUrl("TLS://h")).toBe("TLS://h");
    expect(parseUpstreamUrl("  http://h  ")).toBe("http://h");
  });

  it("非法形式：坏 scheme / 空 host / 携带 path/query/hash / 端口越界 / 非法 URL", () => {
    expect(parseUpstreamUrl("ftp://h")).toBeUndefined();
    expect(parseUpstreamUrl("http://")).toBeUndefined();
    expect(parseUpstreamUrl("http://h/path")).toBeUndefined();
    expect(parseUpstreamUrl("http://h?q=1")).toBeUndefined();
    expect(parseUpstreamUrl("http://h#frag")).toBeUndefined();
    expect(parseUpstreamUrl("http://h:0")).toBeUndefined();
    expect(parseUpstreamUrl("http://h:70000")).toBeUndefined();
    expect(parseUpstreamUrl("::::")).toBeUndefined();
    expect(parseUpstreamUrl("")).toBeUndefined();
  });
});

describe("config/loader applyUpstreamUrl", () => {
  it("拆项写回：scheme 映射协议/TLS/缺省端口，userinfo 百分号解码", () => {
    const r: Record<string, unknown> = {};
    applyUpstreamUrl(r, "https://u%40x:p%21@proxy.example.com:8443");
    expect(r).toEqual({
      upstreamProtocol: "https",
      upstreamSecure: true,
      upstreamHost: "proxy.example.com",
      upstreamPort: 8443,
      upstreamUsername: "u@x",
      upstreamPassword: "p!",
    });
  });

  it("缺省端口按 scheme 补齐（http:80 / socks5:1080 / tls:443）", () => {
    const http: Record<string, unknown> = {};
    applyUpstreamUrl(http, "http://h");
    expect(http.upstreamProtocol).toBe("http");
    expect(http.upstreamSecure).toBe(false);
    expect(http.upstreamPort).toBe(80);
    expect(http.upstreamUsername).toBe("");

    const socks: Record<string, unknown> = {};
    applyUpstreamUrl(socks, "socks5://h");
    expect(socks.upstreamProtocol).toBe("socks5");
    expect(socks.upstreamPort).toBe(1080);

    const tls: Record<string, unknown> = {};
    applyUpstreamUrl(tls, "tls://h");
    expect(tls.upstreamProtocol).toBe("sockss5");
    expect(tls.upstreamSecure).toBe(true);
    expect(tls.upstreamPort).toBe(443);
  });
});
