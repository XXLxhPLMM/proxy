import { describe, expect, it } from "vitest";
import net from "node:net";
import { get, set } from "@/config/store.js";
import { buildConnectRequest, guardDialing, isSelfLoop, parseTargetParts, sanitizeHeaders, stripProxyHeaders } from "@/core/proxy-helpers.js";
import { Dialer } from "@/core/forward/dial.js";

describe("core/proxy-helpers", () => {
  it("buildConnectRequest 拼出标准 CONNECT 报文", () => {
    const raw = buildConnectRequest("example.com", 443).toString();
    expect(raw).toContain("CONNECT example.com:443 HTTP/1.1\r\n");
    expect(raw).toContain("Host: example.com:443\r\n");
    expect(raw.endsWith("\r\n\r\n")).toBe(true);
  });

  it("buildConnectRequest 透传额外鉴权头", () => {
    const raw = buildConnectRequest("example.com", 443, "Proxy-Authorization: Basic dTpw").toString();
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
    expect(stripProxyHeaders(headers)).toBe(headers);
    expect(headers).toEqual({ host: "a.com", cookie: "a=1" });
  });

  it("sanitizeHeaders 洗掉 hop-by-hop 头并固定 connection", () => {
    const out = sanitizeHeaders({
      host: "a.com",
      "proxy-authorization": "Basic x",
      "proxy-connection": "keep-alive",
      "Proxy-Authenticate": "Basic realm=x",
    });
    expect(out["proxy-authorization"]).toBeUndefined();
    expect(out["proxy-connection"]).toBeUndefined();
    expect(out["Proxy-Authenticate"]).toBeUndefined();
    expect(out.connection).toBe("close");
    expect(out.host).toBe("a.com");
  });

  it("parseTargetParts 绝对与相对写法", () => {
    expect(parseTargetParts("http://example.com/a?b=1", undefined)).toEqual({ host: "example.com", port: 80, path: "/a?b=1" });
    expect(parseTargetParts("https://example.com:8443/x", undefined)).toEqual({ host: "example.com", port: 8443, path: "/x" });
    expect(parseTargetParts("https://example.com", undefined)).toEqual({ host: "example.com", port: 443, path: "/" });
    expect(parseTargetParts("/p", "example.com:9000")).toEqual({ host: "example.com", port: 9000, path: "/p" });
    expect(parseTargetParts("/p", "example.com", "https:")).toEqual({ host: "example.com", port: 443, path: "/p" });
    expect(parseTargetParts("/p")).toBeNull();
    expect(parseTargetParts("http://[::1", undefined)).toBeNull();
  });

  it("isSelfLoop 端口不同直接放行", () => {
    const prevHost = get("host");
    const prevPort = get("port");
    try {
      set("host", "127.0.0.1");
      set("port", 10001);
      expect(isSelfLoop("127.0.0.1", 10002)).toBe(false);
      expect(isSelfLoop("127.0.0.1", 10001)).toBe(true);
      expect(isSelfLoop("localhost", 10001)).toBe(true);
    } finally {
      set("host", prevHost);
      set("port", prevPort);
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
    new Dialer().bridge(a as unknown as import("node:stream").Duplex, b as unknown as import("node:stream").Duplex);

    const gotA = new Promise<string>((resolve) => a.once("data", (c) => resolve(c.toString())));
    b.write("hi-a");
    await expect(gotA).resolves.toContain("hi-a");

    const closedB = new Promise<void>((resolve) => b.once("close", resolve));
    a.destroy();
    await closedB;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("guardDialing 建链失败写兜底、建链后只断不断写", async () => {
    // 双连接：c1<->s1（客户端腿），c2<->s2（上游腿）；guardDialing(c1, s2)
    // 兜底写进 c1，读端是 s1，避免 RST 竞态
    const mkLegs = async (): Promise<{ c1: net.Socket; s1: net.Socket; s2: net.Socket; close: () => Promise<void> }> => {
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
        c1, s1, s2,
        close: () => new Promise<void>((resolve) => {
          for (const s of [c1, s1, s2]) if (!s.destroyed) s.destroy();
          server.close(() => resolve());
        }),
      };
    };

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
});
