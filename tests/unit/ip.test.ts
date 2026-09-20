import { describe, expect, it } from "vitest";
import type http from "node:http";
import { getAuthority, getClientAddress, isSelfLoopAddr } from "@/utils/ip.js";

function reqWith(
  headers: http.IncomingHttpHeaders = {},
  socketIp = "9.9.9.9",
  url = "/",
): http.IncomingMessage {
  return {
    headers,
    url,
    socket: { remoteAddress: socketIp },
  } as unknown as http.IncomingMessage;
}

/** getAuthority 只依赖最小形状；直接构造以显式携带 method */
function authReq(fields: {
  method?: string;
  url?: string;
  host?: string | string[];
}): { headers: Record<string, string | string[] | undefined>; url?: string; method?: string } {
  return {
    headers: { host: fields.host },
    url: fields.url,
    method: fields.method,
  };
}

describe("utils/ip", () => {
  it("X-Forwarded-For 优先级最高，取首个", () => {
    expect(getClientAddress(reqWith({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("1.1.1.1");
  });

  it("X-Real-IP 其次", () => {
    expect(getClientAddress(reqWith({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
  });

  it("Forwarded 头解析 for=", () => {
    expect(getClientAddress(reqWith({ forwarded: "for=4.4.4.4;proto=http" }))).toBe("4.4.4.4");
  });

  it("Forwarded 带端口的方括号 IPv6 归一为裸地址", () => {
    expect(getClientAddress(reqWith({ forwarded: 'for="[2001:db8::1]:5678";proto=https' }))).toBe(
      "2001:db8::1",
    );
  });

  it("Forwarded 方括号 IPv6（无端口）归一为裸地址", () => {
    expect(getClientAddress(reqWith({ forwarded: 'for="[2001:db8::1]"' }))).toBe("2001:db8::1");
  });

  it("Forwarded 裸 IPv4 去尾部端口", () => {
    expect(getClientAddress(reqWith({ forwarded: "for=192.0.2.43:5678" }))).toBe("192.0.2.43");
  });

  it("Forwarded 裸 IPv6（多冒号）原样保留", () => {
    expect(getClientAddress(reqWith({ forwarded: "for=2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("回退 socket.remoteAddress", () => {
    expect(getClientAddress(reqWith({}, "5.5.5.5"))).toBe("5.5.5.5");
  });

  it("getClientAddress 取不到时回退哨兵 unknown", () => {
    const req = { headers: {}, socket: {} } as unknown as http.IncomingMessage;
    expect(getClientAddress(req)).toBe("unknown");
  });

  it("getAuthority：CONNECT 用 url（Host 不可信）", () => {
    expect(getAuthority(authReq({ method: "CONNECT", url: "example.com:443", host: "h.example" }))).toBe(
      "example.com:443",
    );
  });

  it("getAuthority：普通请求 Host 优先，而非 path 形态的 url", () => {
    expect(getAuthority(authReq({ method: "GET", url: "/x", host: "h.example" }))).toBe("h.example");
  });

  it("getAuthority：普通请求缺 Host 时回退 url", () => {
    expect(getAuthority(authReq({ method: "GET", url: "http://a.example/p" }))).toBe(
      "http://a.example/p",
    );
  });

  it("getAuthority：Host 头为数组时取首个", () => {
    expect(getAuthority(authReq({ method: "GET", host: ["a.example", "b.example"] }))).toBe(
      "a.example",
    );
  });

  it("getAuthority：全缺失时回退空串", () => {
    expect(getAuthority(authReq({ method: "GET" }))).toBe("");
  });
});

describe("utils/ip isSelfLoopAddr 通配监听", () => {
  it("0.0.0.0 视为监听所有接口", () => {
    expect(isSelfLoopAddr("example.com", 8080, "0.0.0.0", 8080)).toBe(true);
  });

  it(":: 与 0.0.0.0 同等（HOST=:: 场景）", () => {
    expect(isSelfLoopAddr("example.com", 8080, "::", 8080)).toBe(true);
  });

  it("0:0:0:0:0:0:0:0 展开形态同等处理", () => {
    expect(isSelfLoopAddr("example.com", 8080, "0:0:0:0:0:0:0:0", 8080)).toBe(true);
  });

  it("端口不同直接放行", () => {
    expect(isSelfLoopAddr("example.com", 8081, "::", 8080)).toBe(false);
  });

  it("具体监听地址需完全匹配（含 localhost 等价）", () => {
    expect(isSelfLoopAddr("127.0.0.1", 8080, "127.0.0.1", 8080)).toBe(true);
    expect(isSelfLoopAddr("localhost", 8080, "127.0.0.1", 8080)).toBe(true);
    expect(isSelfLoopAddr("example.com", 8080, "127.0.0.1", 8080)).toBe(false);
  });
});
