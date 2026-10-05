/**
 * @fileoverview 钉住**端点寻址**：每个函数的 `(method, path)` 与 `:username` 的编码代入
 * @module tests/api/routing.test
 * @description
 * 十二个 `(method, path)` 逐条钉住，理由是它们与根仓 `src/manager/routes/*.ts` 是手抄的弱耦合：
 * 一旦服务端改了路径而这边没跟上，得到的是 404 而不是编译错误。
 *
 * `:username` 那三条额外钉住**逐段 `encodeURIComponent`** —— 用户名里带一个 `/` 若被原样拼进
 * 路径，读会打到另一个账号上（404 或更糟：命中了别人的账号），写则会改错对象。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  addAclEntry,
  createAccount,
  deleteAccount,
  getAccount,
  getAcl,
  getConfig,
  getStatus,
  getUsage,
  getUsageFor,
  listAccounts,
  removeAclEntry,
  updateAccount,
} from "../../src/api/index.js";
import { createClient, normalizeBaseUrl } from "../../src/utils/request.js";
import { startStub, type ControlPlaneStub } from "./stub.js";

const OK: Record<string, unknown> = { accounts: [], account: {}, acl: {}, usage: {} };

let stub: ControlPlaneStub | null = null;

afterEach(async () => {
  await stub?.close();
  stub = null;
});

/** 一次调用 + 打桩收到的那条 `(method, path)`；只关心寻址，故回包一律 200 + 一个够解包的信封 */
async function call(
  act: (http: ReturnType<typeof httpFor>) => Promise<unknown>,
): Promise<{ method: string; path: string; url: string }> {
  stub = await startStub(() => ({ status: 200, body: OK }));
  await act(httpFor(stub.baseUrl));
  const last = stub.last();
  return { method: last.method, path: last.path, url: last.url };
}

function httpFor(baseUrl: string) {
  return createClient({ baseUrl: normalizeBaseUrl(baseUrl), key: "k", timeoutMs: 5_000 });
}

describe("端点寻址：静态六条", () => {
  it("GET /api/status", async () => {
    expect(await call((h) => getStatus(h))).toMatchObject({
      method: "GET",
      path: "/api/status",
    });
  });

  it("GET /api/config", async () => {
    expect(await call((h) => getConfig(h))).toMatchObject({
      method: "GET",
      path: "/api/config",
    });
  });

  it("GET /api/users", async () => {
    expect(await call((h) => listAccounts(h))).toMatchObject({
      method: "GET",
      path: "/api/users",
    });
  });

  it("POST /api/users", async () => {
    expect(await call((h) => createAccount(h, { username: "a", password: "p" }))).toMatchObject({
      method: "POST",
      path: "/api/users",
    });
  });

  it("GET /api/acl", async () => {
    expect(await call((h) => getAcl(h))).toMatchObject({ method: "GET", path: "/api/acl" });
  });

  it("POST /api/acl", async () => {
    expect(
      await call((h) => addAclEntry(h, { group: "target", list: "whitelist", entry: "e" })),
    ).toMatchObject({ method: "POST", path: "/api/acl" });
  });

  it("DELETE /api/acl", async () => {
    expect(
      await call((h) => removeAclEntry(h, { group: "target", list: "whitelist", entry: "e" })),
    ).toMatchObject({ method: "DELETE", path: "/api/acl" });
  });

  it("GET /api/usage", async () => {
    expect(await call((h) => getUsage(h))).toMatchObject({
      method: "GET",
      path: "/api/usage",
    });
  });
});

describe("端点寻址：`:username` 三条走模板代入", () => {
  it("GET /api/users/:username", async () => {
    expect(await call((h) => getAccount(h, "alice"))).toMatchObject({
      method: "GET",
      path: "/api/users/alice",
    });
  });

  it("PUT /api/users/:username", async () => {
    expect(await call((h) => updateAccount(h, "alice", { disabled: true }))).toMatchObject({
      method: "PUT",
      path: "/api/users/alice",
    });
  });

  it("DELETE /api/users/:username", async () => {
    expect(await call((h) => deleteAccount(h, "alice"))).toMatchObject({
      method: "DELETE",
      path: "/api/users/alice",
    });
  });

  it("GET /api/usage/:username", async () => {
    expect(await call((h) => getUsageFor(h, "alice"))).toMatchObject({
      method: "GET",
      path: "/api/usage/alice",
    });
  });

  it("用户名里的 `/` 被逐段编码，不改路径结构（打到的是那个账号自己，不是另一个路由）", async () => {
    const hit = await call((h) => getAccount(h, "team/ops"));
    expect(hit.path).toBe("/api/users/team%2Fops");
  });

  it("用户名里的 `?` / `#` / 空格同样被编码（否则 query 与 fragment 会改语义）", async () => {
    const hit = await call((h) => getUsageFor(h, "a b?c#d"));
    expect(hit.path).toBe("/api/usage/a%20b%3Fc%23d");
    expect(hit.url).not.toContain("?c");
  });

  it("编码对写操作同样生效（否则 PUT 会改到被截断出来的那个名字上）", async () => {
    const hit = await call((h) => deleteAccount(h, "x/y"));
    expect(hit.path).toBe("/api/users/x%2Fy");
  });
});
