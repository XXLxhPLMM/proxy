/**
 * @fileoverview 钉住**信封层校验**：2xx 但形状不对时落 `wire` 档；深字段缺失**不**拦
 * @module tests/api/decode.test
 * @description
 * 这一档钉 `src/api/decode.ts` 的取舍边界。上界是「信封字段变了就要响」——那才是真的崩，
 * 静默返回 `undefined` 会让模型编出不存在的事实。下界是「信封之内一律不响」——消费面是
 * 模型而不是终端 UI，某个可选字段对不上时它看得懂「没有这个字段」，而一个 TypeError 只会
 * 让整个工具调用失败、把其余信息一起带走。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  addAclEntry,
  asArray,
  asRecord,
  getAccount,
  getAcl,
  getStatus,
  getUsage,
  getUsageFor,
  listAccounts,
} from "../../src/api/index.js";
import { McpError } from "../../src/utils/errors.js";
import { createClient, normalizeBaseUrl } from "../../src/utils/request.js";
import { startStub, type ControlPlaneStub } from "./stub.js";

let stub: ControlPlaneStub | null = null;

afterEach(async () => {
  await stub?.close();
  stub = null;
});

function httpFor(baseUrl: string) {
  return createClient({ baseUrl: normalizeBaseUrl(baseUrl), key: "k", timeoutMs: 5_000 });
}

async function call(body: unknown, act: (http: ReturnType<typeof httpFor>) => Promise<unknown>): Promise<unknown> {
  stub = await startStub(() => ({ status: 200, body }));
  return act(httpFor(stub.baseUrl));
}

async function catchWire(act: (http: ReturnType<typeof httpFor>) => Promise<unknown>): Promise<McpError> {
  const err = await act(httpFor(stub?.baseUrl ?? "")).then(
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

describe("信封层：2xx 但形状不对 ⇒ wire 档", () => {
  it("顶层响应体是数组：不被 2xx 蒙过去（服务端所有端点都回对象）", async () => {
    stub = await startStub(() => ({ status: 200, body: [1, 2, 3] }));
    const err = await catchWire((h) => getStatus(h));

    expect(err.code).toBe("wire");
    expect(err.status).toBeNull();
  });

  it("顶层响应体是字符串：wire 档", async () => {
    stub = await startStub(() => ({ status: 200, body: "ok", contentType: "text/plain" }));
    const err = await catchWire((h) => getStatus(h));

    expect(err.code).toBe("wire");
  });

  it("`accounts` 不在响应里（信封字段被改名/删掉）：wire 档而不是 `undefined`", async () => {
    stub = await startStub(() => ({ status: 200, body: { items: [] } }));
    const err = await catchWire((h) => listAccounts(h));

    expect(err.code).toBe("wire");
    expect(err.message).toContain("GET /api/users 的 accounts");
  });

  it("`accounts` 是对象而不是数组：wire 档", async () => {
    stub = await startStub(() => ({ status: 200, body: { accounts: { a: 1 } } }));
    const err = await catchWire((h) => listAccounts(h));

    expect(err.code).toBe("wire");
  });

  it("`account` 不是对象：wire 档", async () => {
    stub = await startStub(() => ({ status: 200, body: { account: "alice" } }));
    const err = await catchWire((h) => getAccount(h, "alice"));

    expect(err.code).toBe("wire");
    expect(err.message).toContain("GET /api/users/:username 的 account");
  });

  it("`acl` 不是对象：wire 档", async () => {
    stub = await startStub(() => ({ status: 200, body: { acl: [] } }));
    const err = await catchWire((h) => getAcl(h));

    expect(err.code).toBe("wire");
    expect(err.message).toContain("GET /api/acl 的 acl");
  });

  it("`usage` 在单用户那条是数组（旧版服务端的形状）：wire 档，且错误文案说明它不是对象", async () => {
    stub = await startStub(() => ({ status: 200, body: { usage: [] } }));
    const err = await catchWire((h) => getUsageFor(h, "alice"));

    expect(err.code).toBe("wire");
    expect(err.message).toContain("GET /api/usage/:username 的 usage");
  });

  it("定位串写明「哪条端点的哪个字段」——它逐字进模型上下文，只有这句话可诊断", async () => {
    stub = await startStub(() => ({ status: 200, body: {} }));
    const err = await catchWire((h) => getUsageFor(h, "alice"));

    expect(err.message).toMatch(/GET \/api\/usage\/:username/);
  });
});

describe("信封层之内：深字段缺失不拦（消费面是模型，不是终端 UI）", () => {
  it("账号缺可选的 `quota` / `acl`：照样交出，模型自己看得懂「没有这个字段」", async () => {
    const out = await call({ accounts: [{ username: "alice", password: { set: false }, disabled: false, expiresAtIso: null }] }, (h) =>
      listAccounts(h),
    );

    expect(out).toEqual([{ username: "alice", password: { set: false }, disabled: false, expiresAtIso: null }]);
  });

  it("账号的 `password` 形状也不校验：深层失配不该让整个工具调用失败", async () => {
    const out = await call({ accounts: [{ username: "alice", password: "!!!" }] }, (h) => listAccounts(h));

    expect(out).toEqual([{ username: "alice", password: "!!!" }]);
  });

  it("名单少一个组：交出，缺哪个组由消费面看", async () => {
    const out = await call({ acl: { target: { whitelist: [], blacklist: [] } } }, (h) => getAcl(h));

    expect(out).toEqual({ target: { whitelist: [], blacklist: [] } });
  });

  it("全量 usage 的四段元信息缺三段：仍然交出（那一层只校验自己那个信封字段）", async () => {
    const body = { usage: [] };
    const out = await call(body, (h) => getUsage(h));

    expect(out).toEqual(body);
  });
});

describe("两个助手自身", () => {
  it("asRecord 接受普通对象，拒绝 null / 数组 / 标量", () => {
    expect(asRecord({ a: 1 }, "w")).toEqual({ a: 1 });

    for (const bad of [null, [], "x", 1, true, undefined]) {
      expect(() => asRecord(bad, "w")).toThrowError(McpError);
    }
  });

  it("asArray 接受数组，拒绝对象 / null / 标量", () => {
    expect(asArray([1], "w")).toEqual([1]);

    for (const bad of [null, {}, "x", 1, undefined]) {
      expect(() => asArray(bad, "w")).toThrowError(McpError);
    }
  });

  it("助手抛的是 `wire` 档且 `status` 为 `null`（请求已成功，只是格式变了；编个状态码会让模型以为被拒）", () => {
    for (const fn of [asRecord, asArray]) {
      try {
        fn(null, "GET /api/x 的 y");
        throw new Error("这一档本该失败，却成功了");
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe("wire");
        expect((err as McpError).status).toBeNull();
        expect((err as McpError).message).toContain("GET /api/x 的 y");
      }
    }
  });

  it("写操作的回包不走助手（它是 ChangeBody 本身，没有信封可剥）", async () => {
    const change = { changed: true, message: "ok" };
    const out = await call(change, (h) =>
      addAclEntry(h, { group: "clientip", list: "whitelist", entry: "10.0.0.0/8" }),
    );

    expect(out).toEqual(change);
  });
});
