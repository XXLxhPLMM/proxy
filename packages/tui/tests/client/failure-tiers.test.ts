/**
 * 失败必须分成三档：`wire` / `transport` / `shape`
 *
 * @description
 * 一次调用失败时客户端**怎么分类**，以及每档的 `status` 到底取什么。
 *
 * - **三档不许混成一类**：混了界面只能说「出错了」。把「服务没起来」显示成「token 不对」会把人带去改一份
 *   完全正确的凭据；把「对面版本对不上」显示成「内部错误」会让人去翻服务端日志里一行根本不存在的东西。
 *   `shape` 与「错误体不是它自己的错误格式」是两回事：前者多半是对面版本比本包新/旧，后者多半是对面根本
 *   不是控制面，而两者的处置动作不同。
 * - **`transport` 档的 `status` 恒为 `null`**，不许拿 `0` 冒充 —— 没收到响应就没有状态码。
 *   ⚠️ 这是本档最容易被写成 `0` 的一处：界面会显示「HTTP 0 失败」。
 * - **超时与连不上分开**（`timeout` / `unreachable`）：前者多半是对面在忙（重试有意义），后者多半是
 *   地址/网络错了（重试没意义）。「服务已关」那条**先确认连它必然失败**，再断言客户端给出的分类。
 * - ⚠️ **重试判定必须按 `code` 而不是 `kind`**：只看 `kind` 会把「服务没起 / 地址敲错 / 网络断了」也算成
 *   可重试，于是界面对着一个明显不对的地址提示「重试」，教人反复按一个不可能成功的按钮。
 *   `client.ts:transportFailure` 的函数头说的正是这件事（「重试没意义」）。唯一值得重试的是 `timeout`。
 * - **错误体不是错误形状时**只能给状态码一个中性说法，**不许编**一句「服务异常」——判据扫的是
 *   「异常 / 崩溃 / 超时 / 数据库 / OOM」这些**编出来**的原因。
 * - **`shape` 档的文案不转述对面的 body**（那串字节可能是凭据也可能是名单），而文案变成空串也得红
 *   （故同时要求它真的说了点东西）。
 * - **状态码兜底只对传输层自造的四档做映射**，`5xx` 一律 `internal`；状态码来自响应行，不来自 body。
 *
 * 目录级不变量在 `AGENTS.md`。
 *
 * @module tests/client/failure-tiers
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { status } from "@/api/index.js";
import { isRetryable } from "@/lib/index.js";
import { STATUS_BODY, caught, clientTo, startDouble, type Double } from "./_double.js";

/** 替身生命周期：每个用例自己起、自己关（不与别的用例共享端口或 token） */
let double: Double;

beforeEach(async () => {
  double = await startDouble();
});

afterEach(async () => {
  await double.close();
});

describe("传输层失败：`status` 恒为 `null`（没收到响应就没有状态码）", () => {
  it("**超时** ⇒ `transport` / `timeout`", async () => {
    double.route("GET /api/status", { json: STATUS_BODY, delayMs: 400 });
    const err = await caught(() => status(clientTo(double, { timeoutMs: 50 })));
    expect(err.kind).toBe("transport");
    expect(err.code).toBe("timeout");
    // ⚠️ 这是本档最容易被写成 `0` 的那一处：拿 0 冒充状态码，界面就会显示「HTTP 0 失败」
    expect(err.status).toBeNull();
    expect(err.request).toBe("GET /api/status");
    // 超时多半是对面在忙 ⇒ 重试有意义
    expect(isRetryable(err)).toBe(true);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("**连不上**（服务已关）⇒ `transport` / `unreachable`", async () => {
    const baseUrl = double.baseUrl;
    await double.close();
    // 防假绿：端口必须真的关了，故先确认连它必然失败，再断言客户端给出的分类
    const err = await caught(() =>
      status({ baseUrl, token: "t", timeoutMs: 5000 }),
    );
    expect(err.kind).toBe("transport");
    expect(err.code).toBe("unreachable");
    expect(err.status).toBeNull();
    // ⚠️ **重试判定必须按 `code` 而不是 `kind`**：只看 `kind` 会把「服务没起 / 地址敲错 /
    // 网络断了」也算成可重试，于是界面对着一个明显不对的地址提示「重试」，教人反复按一个
    // 不可能成功的按钮。`client.ts:transportFailure` 的函数头说的正是这件事（「重试没意义」）。
    // 唯一值得重试的是 `timeout`（对面在忙）。
    expect(isRetryable(err)).toBe(false);
    // 错误文案不许带上凭据：用一条不会与文案里任何词撞上的 canary
    const canaryToken = "tui-token-canary-4f1c9a";
    const withCanary = await caught(() =>
      status({ baseUrl, token: canaryToken, timeoutMs: 5000 }),
    );
    expect(withCanary.message).not.toContain(canaryToken);
    expect(withCanary.message).toContain("连不上");
  });

  it("**连接被掐**（服务端中途 destroy）⇒ `transport`，且不是超时", async () => {
    double.route("GET /api/status", { destroy: true });
    const err = await caught(() => status(clientTo(double, { timeoutMs: 5000 })));
    expect(err.kind).toBe("transport");
    expect(err.code).toBe("unreachable");
    expect(err.status).toBeNull();
  });
});

describe("形状不对：`shape` 档（多半是对面版本与本包不一致）", () => {
  it('200 + `{"foo":1}` ⇒ `shape`，且文案点名缺的那个字段', async () => {
    double.route("GET /api/status", { json: { foo: 1 } });
    const err = await caught(() => status(clientTo(double)));
    expect(err.kind).toBe("shape");
    expect(err.code).toBe("bad-shape");
    expect(err.message).toContain("process");
    // 「答了但不像本包声明的形状」没有 HTTP 状态码可言
    expect(err.status).toBeNull();
    expect(err.request).toBe("GET /api/status");
  });

  it("200 + **非 JSON 文本** ⇒ 同样 `shape`（对面根本不是控制面时也走这一档）", async () => {
    double.route("GET /api/status", { raw: "<!doctype html><title>nginx</title>" });
    const err = await caught(() => status(clientTo(double)));
    expect(err.kind).toBe("shape");
    expect(err.message).toContain("GET /api/status");
  });

  it("200 + **空响应体** ⇒ `shape`（空不是「合法的空配置」）", async () => {
    double.route("GET /api/status", { raw: "" });
    const err = await caught(() => status(clientTo(double)));
    expect(err.kind).toBe("shape");
  });

  it("`shape` 的文案**不转述**对面的 body（那串字节可能是凭据也可能是名单）", async () => {
    const canary = "s3cr3t-token-value-in-a-wrong-body";
    double.route("GET /api/status", { raw: canary });
    const err = await caught(() => status(clientTo(double)));
    expect(err.message).not.toContain(canary);
    // 防假绿：文案变成空串也会绿 —— 故同时要求它真的说了点东西
    expect(err.message.length).toBeGreaterThan(0);
  });
});

describe("错误体不是错误形状：只给状态码一个中性说法", () => {
  it("500 + `{}` ⇒ `internal`，且**不编**具体原因", async () => {
    double.route("GET /api/status", { status: 500, json: {} });
    const err = await caught(() => status(clientTo(double)));
    expect(err.kind).toBe("wire");
    expect(err.code).toBe("internal");
    expect(err.status).toBe(500);
    expect(err.requestId).toBeNull();
    expect(err.message).toContain("响应体不是它自己的错误格式");
    // 那句话里不许出现「异常 / 崩溃 / 超时 / 数据库」这类**编出来**的原因
    for (const invented of ["异常", "崩溃", "数据库", "超时", "OOM"]) {
      expect(err.message, `不许编「${invented}」`).not.toContain(invented);
    }
  });

  it("500 + 非 JSON ⇒ 同样只说「响应体不是它自己的错误格式」", async () => {
    double.route("GET /api/status", { status: 502, raw: "<html>Bad Gateway</html>" });
    const err = await caught(() => status(clientTo(double)));
    expect(err.code).toBe("internal");
    expect(err.status).toBe(502);
    expect(err.message).toContain("响应体不是它自己的错误格式");
  });

  it("连错误体都**不是** JSON 时 `status` 仍是真的状态码（状态码来自响应行，不来自 body）", async () => {
    double.route("GET /api/status", { status: 503, raw: "upstream connect error" });
    const err = await caught(() => status(clientTo(double)));
    expect(err.status).toBe(503);
    expect(err.code).toBe("internal");
  });

  it("状态码兜底只对**传输层自造**的四档做映射，5xx 一律 `internal`", async () => {
    for (const [httpStatus, code] of [
      [401, "unauthorized"],
      [403, "unauthorized"],
      [404, "not-found"],
      [405, "method-not-allowed"],
      [400, "bad-request"],
      [500, "internal"],
      [501, "internal"],
      [502, "internal"],
      [503, "internal"],
    ] as Array<[number, string]>) {
      double.route("GET /api/status", { status: httpStatus, json: {} });
      const err = await caught(() => status(clientTo(double)));
      expect(err.code, `${httpStatus} 的兜底分类不对`).toBe(code);
    }
  });
});
