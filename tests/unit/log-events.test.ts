import { describe, expect, it } from "vitest";
import { LogEvent, logBadRequest, logClientError, logClientTimeout, logLoopDetected, logTargetUnresolved, logUpstreamError, logUpstreamRefused, logUpstreamTimeout } from "@/server/log/events-log.js";
import type { EventLog } from "@/server/log/events-log.js";

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

describe("utils/log-events", () => {
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
});
