import { describe, expect, it } from "vitest";
import { EventHub } from "@/core/events/hub.js";
import type { EventEnvelope } from "@/core/events/types.js";
import { DialTimeoutError } from "@/core/forward/upstream/dial.js";
import {
  DEFAULT_ERROR_CLASSIFIER,
  ErrorBoundary,
  classifyClientError,
  classifyError,
} from "@/core/error-boundary.js";
import type { ClassifiedError, ErrorClassifier } from "@/core/types/proxy.js";
import {
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_GATEWAY_TIMEOUT,
} from "@/utils/constants/index.js";
import { blockAfter, codeOf } from "../../helpers/source-scan.js";

/**
 * 错误分类真值表 + 脱敏契约 + `ErrorClassifier` 端口（可替换，且不许有直调后门）。
 *
 * 三条硬裁决：① 分类真值表（`DialTimeoutError` → timeout/504/expected、Node 网络错误码 →
 * upstream/502/expected、未知 → internal/502/unexpected、`SyntaxError` → protocol/502/expected），
 * 而 `classifyError` **不猜客户端 400**（那条由显式入口 `classifyClientError` 给）；② 504 只属于
 * timeout，其余一律 502（⚠️ 真写给客户端的状态码今天仍有 7 处手写逻辑不经它，见用例注释）；
 * ③ 消息遮蔽凭证后截断到 200 字符，原始值只留在 `cause`（载荷对库调用方可见，见用例注释）。
 * ⚠️ 最后两条是**源码级负向断言**，理由与锚点自查见 `AGENTS.md` 的不变量 ①。
 */

/** 一份**记账式**分类替身：把每次被问到的值记下来，并返回一个**故意不一样**的结果
 * @description 计数是必需的（同 `access-control-port.test.ts` 的 `countingAccess()` 纪律）：
 * 只断言「构造时传了它」证明的仅仅是**赋值发生**——一份没人调用的替身照样通过。真正要锁的是
 * 「收尾路径真的问过它」+「它的返回值原样透出」（后者是替换方今天唯一的可观测面）。 */
function countingClassifier(): { classifier: ErrorClassifier; calls: unknown[] } {
  const calls: unknown[] = [];
  const one = (error: unknown, class_: ClassifiedError["class"], status: number): ClassifiedError => {
    calls.push(error);
    return { class: class_, status, expected: true, cause: error, message: "substituted" };
  };
  return {
    calls,
    classifier: {
      classify: (error) => one(error, "internal", 599),
      classifyClient: (error) => one(error, "client", STATUS_BAD_REQUEST),
    },
  };
}

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

  it("状态码映射：只有 timeout 是 504，其余一律 502（统一收尾不许出现双轨）", () => {
    // 保护：统一收尾不能出现「分类说 504、协议建议却回 502」的双轨语义。
    //
    // ⚠️ **原判据是同义反复，本档把它换掉了**：原文是 `statusForCause(e) === classifyError(e).status`
    // ——`statusForCause` 的实现**就是** `classifyError(error).status`，所以那条断言证明的只是
    // 「别名没走样」。而双轨真正要防的是**有人绕过分类器自己判 504**（`forward/base.ts:436` 与
    // `channel/upgrade.ts:477` 今天各有一处，见 `ErrorClassifier` 的注释）。别名已删
    // （`classify(e).status` 就是它），故判据换成不变式**本身**。
    const samples: ReadonlyArray<readonly [string, unknown, number]> = [
      ["DialTimeoutError", new DialTimeoutError("timeout"), STATUS_GATEWAY_TIMEOUT],
      ["ECONNREFUSED", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), STATUS_BAD_GATEWAY],
      ["SyntaxError", new SyntaxError("bad request"), STATUS_BAD_GATEWAY],
      ["unknown", new Error("other"), STATUS_BAD_GATEWAY],
    ];
    for (const [label, error, expected] of samples) {
      expect(classifyError(error).status, `${label} 的状态码`).toBe(expected);
    }
  });

  it("消息脱敏并截断：不泄漏 Basic/Bearer/cookie 明文", () => {
    // 保护：错误消息可能携带请求头，事件/日志消费方不能看到任何凭证明文。
    // 被否掉的是「把原始 message 带上」：分类结果会进**公共事件载荷**（`request.failed` 的
    // `data.error`），而事件总线对**库调用方**可见 —— 原始 message 可能整段带着请求头。
    // 丢 `cause` 也不行：那条链要一路流到 `forward.error`，静默降级直连 = 流量旁路。
    // 代价方向是「宁可遮多了」：遮多了目标站少收一条头，遮漏了就是凭证明文外泄。
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

    // 定长封顶：500 字符的 message 被截到 200，免得一条畸形输入把整条事件流撑爆
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

describe("ErrorClassifier 端口：可替换，且不许有直调后门", () => {
  it("注入的分类策略真的被问，且它的返回值原样透出", () => {
    const { classifier, calls } = countingClassifier();
    const hub = new EventHub({ onListenerError: () => undefined });
    const boundary = new ErrorBoundary({ hub, classifier });
    const error = new Error("boom");

    const result = boundary.failRequest(error, "dial");

    expect(calls, "收尾路径真的问了注入的分类器").toEqual([error]);
    // 替换方今天唯一的可观测面就是返回值（`bridge.ts` 丢弃它、事件载荷带原始 error），
    // 所以这条断言是「替换生效」的**全部**证据——它不成立就等于端口是死的
    expect(result).toMatchObject({ class: "internal", status: 599, message: "substituted" });
  });

  it("failRuntime 与 failRequest 走同一个分类器（不留第二条路）", () => {
    const { classifier, calls } = countingClassifier();
    const boundary = new ErrorBoundary({ classifier });
    const requestError = new Error("request side");
    const runtimeError = new Error("runtime side");

    boundary.failRequest(requestError, "dial");
    const fromRuntime = boundary.failRuntime(runtimeError);

    expect(calls).toEqual([requestError, runtimeError]);
    expect(fromRuntime.message).toBe("substituted");
  });

  it("不注入 → 走默认实现，且默认实现是**单例**、`classify` 就是 `classifyError` 本身", () => {
    // 对象身份而非深比较：深比较证明不了「注入没生效时拿到的是同一个对象」，而那正是
    // `BaseProxy` 里 `NONE_IDENTITY` / `INERT_TRAFFIC_ACCOUNT` 记下的同一条纪律
    expect(DEFAULT_ERROR_CLASSIFIER.classify).toBe(classifyError);
    expect(DEFAULT_ERROR_CLASSIFIER.classifyClient).toBe(classifyClientError);

    const boundary = new ErrorBoundary();
    const error = new Error("boom");
    expect(boundary.failRequest(error, "dial")).toEqual(classifyError(error));
  });

  it("分类器抛错不得反噬协议收尾：异常照常向上抛（core 不吞）", () => {
    // 保护：这条与「观察面抛错必须被吞」是**两条不同的纪律**——事件总线抛错由 `ErrorBoundary`
    // 吞掉（它只发可观测性副作用），而分类器是**返回值来源**，它抛错时本档刻意不吞：
    // 一个连分类都做不出来的替换方，静默降级成「什么类别都不是」比抛错更危险。
    const boundary = new ErrorBoundary({
      classifier: {
        classify: () => {
          throw new Error("classifier exploded");
        },
        classifyClient: classifyClientError,
      },
    });
    expect(() => boundary.failRequest(new Error("boom"), "dial")).toThrow("classifier exploded");
  });

  it("源码级：`ErrorBoundary` 类体里不许直调 `classifyError`（否则注入悄悄失效而全部用例照绿）", () => {
    // ⚠️ **本档最重要的一条**。上面那些行为断言只证明「构造时存下了它」；把
    // `this.classifier.classify(error)` 改回 `classifyError(error)` 之后，**所有行为断言
    // 仍然全绿**（它们问的是「分类结果对不对」，而默认实现给出的结果恰好是对的），
    // 而注入从此静默失效。这是本仓「负向断言点名已删符号会恒真」的**镜像**形态：
    // 这次锚点必须钉在**今天仍然存在**的调用形状上。
    const cls = blockAfter(codeOf("core", "error-boundary.ts"), "export class ErrorBoundary");
    expect(cls, "锚点失效：没切到 ErrorBoundary 的类体").toContain("this.classifier");

    // 走端口：两个分类入口都必须经 `this.classifier`
    expect((cls.match(/this\.classifier\.classify\(/g) ?? []).length, "两个入口都走端口").toBe(2);
    // 反向：类体里**不许**出现任何直调（`DEFAULT_ERROR_CLASSIFIER` 是大写常量名，
    // 不含 `classifyError(` 这个形状，故这个计数不会被它误伤）
    expect(cls.match(/classifyError\(/g) ?? [], "类体里不许直调 classifyError").toHaveLength(0);
    expect(cls.match(/classifyClientError\(/g) ?? [], "类体里不许直调 classifyClientError").toHaveLength(
      0,
    );
  });

  it("源码级：`RuntimeServices.errorClassification` 是必填（缺席 = 用默认分类，不是「忘了注入」）", () => {
    // 对齐 `access` 那条必填裁决：它的缺席没有一条独立于默认实现的路，缺席时唯一发生的事
    // 就是用内置真值表——那条路是安全的，故用「必填 + 组装点解析」而不是「可选 + core 兜底」。
    const decl = codeOf("runtime", "types.ts")
      .split("\n")
      .filter((line) => /^\s*readonly\s+errorClassification\s*:/.test(line));
    expect(decl, "runtime/types.ts 必须恰好一处 `errorClassification:` 顶层声明").toHaveLength(1);
    expect(decl[0], "`errorClassification` 不许带 `?`（缺席 = 用默认分类，必须由组装点显式落值）").not.toContain(
      "?",
    );

    // 正向：runtime 那一侧的接线真的把它送到了 `ErrorBoundary`
    expect(codeOf("runtime", "bridge.ts"), "bridge 必须把分类策略原样递给 ErrorBoundary").toContain(
      "classifier: options.classifier",
    );
    expect(codeOf("runtime", "runtime.ts"), "runtime 必须从 services 取到它").toContain(
      "classifier: this.services.errorClassification",
    );
  });
});