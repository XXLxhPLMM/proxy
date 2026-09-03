import { describe, expect, it } from "vitest";
import type http from "node:http";
import { getAuthority, getClientAddress } from "@/utils/ip.js";

function reqWith(headers: http.IncomingHttpHeaders = {}, socketIp = "9.9.9.9", url = "/"): http.IncomingMessage {
  return {
    headers,
    url,
    socket: { remoteAddress: socketIp },
  } as unknown as http.IncomingMessage;
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

  it("回退 socket.remoteAddress", () => {
    expect(getClientAddress(reqWith({}, "5.5.5.5"))).toBe("5.5.5.5");
  });

  it("getAuthority 优先 url", () => {
    expect(getAuthority(reqWith({ host: "h.example" }, "1.1.1.1", "example.com:443"))).toBe("example.com:443");
  });
});
