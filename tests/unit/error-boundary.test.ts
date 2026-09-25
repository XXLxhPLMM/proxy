import { describe, expect, it } from "vitest";
import { EventHub } from "@/core/events/hub.js";
import type { EventEnvelope } from "@/core/events/types.js";
import { DialTimeoutError } from "@/core/forward/dial.js";
import {
  ErrorBoundary,
  classifyClientError,
  classifyError,
  statusForCause,
} from "@/core/error-boundary.js";
import {
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_GATEWAY_TIMEOUT,
} from "@/utils/constants/index.js";

describe("core/error-boundary", () => {
  it("DialTimeoutError 固定分类为 timeout/504/expected", () => {
    // 保护：拨号超时是唯一可安全映射到 504 的显式错误，不能被普通 Error 兜底吞成 502。
    const error = new DialTimeoutError("dial timeout example.com:443");
    const result = classifyError(error);

    expect(result).toMatchObject({
      class: "timeout",
      status: STATUS_GATEWAY_TIMEOUT,
      expected: true,
    });
    expect(result.cause).toBe(error);
  });

  it("Node 网络错误码归为 upstream/502/expected", () => {
    // 保护：连接拒绝和 DNS 失败都是预期的上游故障，不应升级成内部错误告警。
    for (const code of ["ECONNREFUSED", "ENOTFOUND"]) {
      const error = Object.assign(new Error(`network ${code}`), { code });
      expect(classifyError(error)).toMatchObject({
        class: "upstream",
        status: STATUS_BAD_GATEWAY,
        expected: true,
      });
    }
  });

  it("未知错误保守归为 internal/502/unexpected", () => {
    // 保护：无法识别的异常必须保留内部故障语义，供上层决定是否告警。
    const result = classifyError(new Error("unexpected failure"));

    expect(result).toMatchObject({
      class: "internal",
      status: STATUS_BAD_GATEWAY,
      expected: false,
    });
  });

  it("statusForCause 与 classifyError 的状态码保持一致", () => {
    // 保护：统一收尾不能出现“分类说 504、协议建议却回 502”的双轨语义。
    const timeout = new DialTimeoutError("timeout");
    const upstream = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    const protocol = new SyntaxError("bad request");

    expect(statusForCause(timeout)).toBe(classifyError(timeout).status);
    expect(statusForCause(upstream)).toBe(classifyError(upstream).status);
    expect(statusForCause(protocol)).toBe(classifyError(protocol).status);
    expect(statusForCause(new Error("other"))).toBe(STATUS_BAD_GATEWAY);
  });

  it("消息脱敏并截断：不泄漏 Basic/Bearer/cookie 明文", () => {
    // 保护：错误消息可能携带请求头，事件/日志消费方不能看到任何凭证明文。
    const cases: readonly [string, string][] = [
      ["Proxy-Authorization: Basic abc123", "abc123"],
      ["Authorization: Bearer xxx", "xxx"],
      ["Cookie: session=secret", "secret"],
      ['{"cookie":"json-secret"}', "json-secret"],
      ["Basic inline-secret", "inline-secret"],
    ];
    for (const [message, secret] of cases) {
      const result = classifyError(new Error(message));
      expect(result.message).not.toContain(secret);
    }

    const long = classifyError(new Error("x".repeat(500)));
    expect(long.message).toHaveLength(200);
  });

  it("边界按阶段发布 request.failed/rejected/runtime.error 并合并 context", () => {
    // 保护：事件是收尾事实的可观测出口，stage/status/context 不能在边界层丢失。
    const hub = new EventHub({ runtimeId: "runtime-test", onListenerError: () => {} });
    let failed: EventEnvelope<"request.failed"> | undefined;
    let rejected: EventEnvelope<"request.rejected"> | undefined;
    let runtime: EventEnvelope<"runtime.error"> | undefined;
    hub.subscribe("request.failed", (event) => {
      failed = event;
    });
    hub.subscribe("request.rejected", (event) => {
      rejected = event;
    });
    hub.subscribe("runtime.error", (event) => {
      runtime = event;
    });

    const boundary = new ErrorBoundary({
      hub,
      context: { requestId: "request-base", protocol: "http" },
    });
    const requestError = new Error("upstream exploded");
    const classifiedRequest = boundary.failRequest(requestError, "dial", {
      requestId: "request-local",
      client: "127.0.0.1",
    });
    const status = boundary.rejectRequest("target denied", "access", 403, {
      target: "example.com:443",
    });
    const runtimeError = new Error("runtime exploded");
    const classifiedRuntime = boundary.failRuntime(runtimeError, { protocol: "https" });

    expect(classifiedRequest).toMatchObject({ class: "internal", status: STATUS_BAD_GATEWAY });
    expect(status).toBe(403);
    expect(classifiedRuntime).toMatchObject({ class: "internal", status: STATUS_BAD_GATEWAY });
    expect(failed?.data).toEqual({ stage: "dial", error: requestError });
    expect(failed?.context).toMatchObject({
      runtimeId: "runtime-test",
      requestId: "request-local",
      protocol: "http",
      client: "127.0.0.1",
    });
    expect(rejected?.data).toEqual({ stage: "access", status: 403, reason: "target denied" });
    expect(rejected?.context).toMatchObject({
      requestId: "request-base",
      target: "example.com:443",
    });
    expect(runtime?.data).toEqual({ error: runtimeError });
    expect(runtime?.context).toMatchObject({ protocol: "https" });
  });

  it("观察者抛错时 failRequest 不抛且分类结果照常返回", () => {
    // 保护：观察者不是控制流参与者；坏订阅不能打断请求失败收尾。
    const hub = new EventHub({ onListenerError: () => {} });
    hub.subscribe("request.failed", () => {
      throw new Error("observer exploded");
    });
    const boundary = new ErrorBoundary({ hub });
    const error = new Error("request failed");

    expect(() => boundary.failRequest(error, "stream")).not.toThrow();
    expect(boundary.failRequest(error, "stream")).toMatchObject({
      class: "internal",
      status: STATUS_BAD_GATEWAY,
      expected: false,
    });
  });

  it("不注入 hub 时只分类和返回状态，不发布也不抛", () => {
    // 保护：纯库消费者可以只使用分类结果，不被事件基础设施绑死。
    const boundary = new ErrorBoundary();
    const error = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });

    expect(boundary.failRequest(error, "dial")).toMatchObject({
      class: "upstream",
      status: STATUS_BAD_GATEWAY,
      expected: true,
    });
    expect(boundary.rejectRequest("denied", "access", STATUS_BAD_REQUEST)).toBe(STATUS_BAD_REQUEST);
    expect(boundary.failRuntime(error)).toMatchObject({ class: "upstream" });
  });

  it("协议错误和显式客户端错误保持各自语义", () => {
    // 保护：解析/协议失败默认 502；客户端拒绝必须由显式 client 入口给 400。
    expect(classifyError(new SyntaxError("bad request"))).toMatchObject({
      class: "protocol",
      status: STATUS_BAD_GATEWAY,
      expected: true,
    });
    expect(classifyClientError(new Error("malformed client input"))).toMatchObject({
      class: "client",
      status: STATUS_BAD_REQUEST,
      expected: true,
    });
  });
});
