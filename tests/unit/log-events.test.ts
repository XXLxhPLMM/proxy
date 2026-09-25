import { describe, expect, it } from "vitest";
import {
  LogEvent,
  logBadRequest,
  logClientError,
  logClientTimeout,
  logIpDenied,
  logLoopDetected,
  logTargetDenied,
  logTargetUnresolved,
  logTlsClientError,
  logUpstreamError,
  logUpstreamRefused,
  logUpstreamTimeout,
} from "@/core/log-events.js";
import type { EventLog } from "@/core/log-events.js";

function fakeLog(): EventLog & { warns: unknown[][]; errors: unknown[][] } {
  return {
    warns: [],
    errors: [],
    warn(...args: unknown[]): void {
      this.warns.push(args);
    },
    error(...args: unknown[]): void {
      this.errors.push(args);
    },
  };
}

describe("core/log-events", () => {
  it("目标解析失败记 warn 且 code 可 grep", () => {
    const log = fakeLog();
    logTargetUnresolved(log, "http://[::1");
    expect(log.warns).toHaveLength(1);
    expect(String(log.warns[0][0])).toContain(`[${LogEvent.TargetUnresolved}]`);
  });

  it("环路记 error", () => {
    const log = fakeLog();
    logLoopDetected(log, "GET http://x/ -> 127.0.0.1:8080");
    expect(log.errors).toHaveLength(1);
    expect(String(log.errors[0][0])).toContain(`[${LogEvent.LoopDetected}]`);
  });

  it("上游拒绝去首尾空且 code 可 grep", () => {
    const log = fakeLog();
    logUpstreamRefused(log, "HTTP/1.1 407 Proxy Auth Required  \r\n");
    expect(log.warns).toHaveLength(1);
    const line = String(log.warns[0][0]);
    expect(line).toContain(`[${LogEvent.UpstreamRefused}]`);
    expect(line).not.toContain("  \r\n");
  });

  it("新增事件 code 可 grep 且 extra 透传", () => {
    const log = fakeLog();
    logBadRequest(log, "[tls] bad header 1.2.3.4 -> FOO");
    logClientTimeout(log, "[socks] 1.2.3.4");
    logClientError(log, "[socks] 1.2.3.4", "ECONNRESET");
    logUpstreamTimeout(log, "[tls-http] 1.2.3.4 -> example.com");
    logUpstreamError(log, "[tls-http] 1.2.3.4 -> example.com", "ECONNREFUSED");
    const lines = log.warns.map((a) => String(a[0]));
    expect(lines).toContain("[bad-request] [tls] bad header 1.2.3.4 -> FOO");
    expect(lines).toContain("[client-timeout] [socks] 1.2.3.4");
    expect(lines).toContain("[client-error] [socks] 1.2.3.4:");
    expect(lines).toContain("[upstream-timeout] [tls-http] 1.2.3.4 -> example.com");
    expect(lines).toContain("[upstream-error] [tls-http] 1.2.3.4 -> example.com:");
    expect(log.warns[2][1]).toBe("ECONNRESET");
    expect(log.warns[4][1]).toBe("ECONNREFUSED");
  });

  it("logIpDenied / logTargetDenied 均为 warn 级且 code 可 grep", () => {
    const log = fakeLog();
    logIpDenied(log, "socks5 客户端 1.2.3.4 拒绝 reason=blocked");
    logTargetDenied(log, "evil.com 拒绝 reason=blocked-target");
    expect(log.errors).toHaveLength(0);
    expect(log.warns).toHaveLength(2);
    const lines = log.warns.map((a) => String(a[0]));
    expect(lines[0]).toBe("[ip-denied] socks5 客户端 1.2.3.4 拒绝 reason=blocked");
    expect(lines[1]).toBe("[target-denied] evil.com 拒绝 reason=blocked-target");
    expect(lines[0]).toContain(`[${LogEvent.IpDenied}]`);
    expect(lines[1]).toContain(`[${LogEvent.TargetDenied}]`);
  });

  it("logIpDenied / logTargetDenied 透传 fields；不传时不追加 undefined", () => {
    const log = fakeLog();
    logIpDenied(log, "detail-a", { client: "1.2.3.4", reason: "blocked" });
    logTargetDenied(log, "detail-b");
    // fields 作为末位参数透传
    expect(log.warns[0]).toHaveLength(2);
    expect(log.warns[0][1]).toEqual({ client: "1.2.3.4", reason: "blocked" });
    // 不传 fields 时绝不追加 undefined 参数
    expect(log.warns[1]).toHaveLength(1);
  });

  it("空 fields 对象不作为参数透传", () => {
    const log = fakeLog();
    logIpDenied(log, "detail", {});
    logTargetDenied(log, "detail", {});
    expect(log.warns[0]).toHaveLength(1);
    expect(log.warns[1]).toHaveLength(1);
  });

  it("logTlsClientError 为 warn 级且 code 可 grep，extra/fields 透传", () => {
    const log = fakeLog();
    logTlsClientError(log, "sockss5 客户端 TLS 握手失败", "EPROTO", { code: "ERR_SSL_X" });
    logTlsClientError(log, "sockss5 客户端证书未通过校验", undefined, {
      authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    expect(log.errors).toHaveLength(0);
    expect(log.warns[0]).toEqual([
      "[tls-client-error] sockss5 客户端 TLS 握手失败:",
      "EPROTO",
      { code: "ERR_SSL_X" },
    ]);
    expect(log.warns[1]).toEqual([
      "[tls-client-error] sockss5 客户端证书未通过校验",
      { authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
    ]);
    expect(String(log.warns[0][0])).toContain(`[${LogEvent.TlsClientError}]`);
  });

  it("现有 helper 透传 fields，且 undefined 时走无参分支", () => {
    const log = fakeLog();
    logBadRequest(log, "d1", { client: "c1" });
    logClientTimeout(log, "d2"); // 无 fields -> 单参数
    logClientError(log, "d3", undefined, { client: "c3" }); // extra 空、fields 有 -> fields 顶到第二位
    logClientError(log, "d4", "E1", { client: "c4" }); // extra + fields
    logClientError(log, "d5", "E2"); // 仅 extra
    logLoopDetected(log, "d6", { target: "t6" }); // error 通道 fields

    expect(log.warns[0]).toEqual(["[bad-request] d1", { client: "c1" }]);
    expect(log.warns[1]).toHaveLength(1);
    expect(log.warns[2]).toEqual(["[client-error] d3", { client: "c3" }]);
    expect(log.warns[3]).toEqual(["[client-error] d4:", "E1", { client: "c4" }]);
    expect(log.warns[4]).toEqual(["[client-error] d5:", "E2"]);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toEqual(["[loop-detected] loop detected: d6", { target: "t6" }]);
  });
});
