/**
 * @fileoverview 钉住**失败分档**：对面答了但答案是失败 ⇒ `wire` 档，且它自己的错误体被原样带走
 * @module tests/api/wire-errors.test
 * @description
 * 这一档钉的是 `src/utils/request.ts` 的失败翻译 + 本层不吞错。模型据此决定「重试」还是
 * 「改参数」，所以三样东西都必须对得上：`code`（档位）、`status`（HTTP 码）、`message`
 * （对面那句人话）。`requestId` 是第四样 —— 它是拿去 grep 服务端日志的关联 id。
 *
 * ⚠️ 断的是「本层把 `wire` 吞掉换成别的档」：4xx 是对面**明确**的答复，不是本机问题，
 * 也不是连不上。
 */

import { afterEach, describe, expect, it } from "vitest";
import { createAccount, getAccount, getStatus } from "../../src/api/index.js";
import { McpError } from "../../src/utils/errors.js";
import { createClient, normalizeBaseUrl } from "../../src/utils/request.js";
import { startStub, type ControlPlaneStub, type StubReply } from "./stub.js";

let stub: ControlPlaneStub | null = null;

afterEach(async () => {
  await stub?.close();
  stub = null;
});

function httpFor(baseUrl: string) {
  return createClient({ baseUrl: normalizeBaseUrl(baseUrl), key: "k", timeoutMs: 5_000 });
}

async function fails(reply: StubReply, act: (http: ReturnType<typeof httpFor>) => Promise<unknown>): Promise<McpError> {
  stub = await startStub(() => reply);
  const err = await act(httpFor(stub.baseUrl)).then(
    () => {
      throw new Error("这一档本该失败，却成功了");
    },
    (caught: unknown) => caught,
  );
  if (!(err instanceof McpError)) {
    throw new Error(`抛的不是 McpError：${String(err)}`);
  }
  return err;
}

describe("wire 档：对面答了，而答案是失败", () => {
  it("4xx 带上服务端自己的 `{error:{code,message,requestId}}`：档位、状态码、requestId、对面那句原样带出", async () => {
    const err = await fails(
      {
        status: 400,
        body: { error: { code: "bad_request", message: "quotaBytes 必须是数字", requestId: "req-7" } },
      },
      (h) => createAccount(h, { username: "alice", password: "pw" }),
    );

    expect(err.code).toBe("wire");
    expect(err.status).toBe(400);
    expect(err.requestId).toBe("req-7");
    expect(err.message).toBe("quotaBytes 必须是数字");
  });

  it("401 是 `wire` 档而不是 `transport`（对面确实答了，答的是「令牌不对」）", async () => {
    const err = await fails(
      { status: 401, body: { error: { code: "unauthorized", message: "令牌无效", requestId: "req-1" } } },
      (h) => getStatus(h),
    );

    expect(err.code).toBe("wire");
    expect(err.status).toBe(401);
    expect(err.message).toBe("令牌无效");
  });

  it("401 即使没有 requestId，`requestId` 也只是 `null` 而不是编一个", async () => {
    const err = await fails({ status: 401, body: { error: { message: "令牌无效" } } }, (h) => getStatus(h));

    expect(err.code).toBe("wire");
    expect(err.requestId).toBeNull();
  });

  it("404 带自己的错误体时，message 是对面那句而不是我们自己编的兜底", async () => {
    const err = await fails(
      { status: 404, body: { error: { code: "not_found", message: "账号 bob 不存在", requestId: "req-9" } } },
      (h) => getAccount(h, "bob"),
    );

    expect(err.status).toBe(404);
    expect(err.message).toBe("账号 bob 不存在");
  });

  it("5xx 同样走 wire 档（对面答了，只是它自己炸了）", async () => {
    const err = await fails(
      { status: 500, body: { error: { code: "internal", message: "账本文件读不出来", requestId: "req-3" } } },
      (h) => getStatus(h),
    );

    expect(err.code).toBe("wire");
    expect(err.status).toBe(500);
  });

  it("错误体不像它自己的格式时，只给状态码 + 中性说法，不编一句「服务异常」", async () => {
    const err = await fails({ status: 502, body: "<html>bad gateway</html>", contentType: "text/html" }, (h) =>
      getStatus(h),
    );

    expect(err.code).toBe("wire");
    expect(err.status).toBe(502);
    expect(err.requestId).toBeNull();
    expect(err.message).toContain("502");
  });

  it("错误体是空体时同样落 wire 档（有状态码就有对面答复）", async () => {
    const err = await fails({ status: 403 }, (h) => getStatus(h));

    expect(err.code).toBe("wire");
    expect(err.status).toBe(403);
  });

  it("报错文案里绝不含凭据（key 等价于 root shell）", async () => {
    stub = await startStub(() => ({
      status: 401,
      body: { error: { code: "unauthorized", message: "令牌无效", requestId: "req-1" } },
    }));
    const err = await getStatus(
      createClient({ baseUrl: normalizeBaseUrl(stub.baseUrl), key: "tok_secret_value", timeoutMs: 5_000 }),
    ).then(
      () => {
        throw new Error("这一档本该失败，却成功了");
      },
      (caught: unknown) => caught as McpError,
    );

    expect(err.toReport()).not.toContain("tok_secret_value");
  });
});
