/**
 * @fileoverview 钉住**信封解包**：出参是领域值，不是服务端那层包装
 * @module tests/api/unwrap.test
 * @description
 * 这一档钉的是 `src/api/*.ts` 存在的**唯一理由**：服务端对单条用 `{account: X}`、对列表用
 * `{accounts: [...]}`，而这一层把信封剥掉。若哪天有人图省事直接返回整个 body，
 * 消费面拿到的对象形状会静默变一层 —— 那不会报任何错，只会让模型读到一堆 `undefined`。
 *
 * 反向也钉住：**写操作不解包**（回包本身就是 `ChangeBody`），全量 usage 也不解包。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  addAclEntry,
  createAccount,
  deleteAccount,
  getAccount,
  getAcl,
  getUsage,
  getUsageFor,
  listAccounts,
  removeAclEntry,
  updateAccount,
} from "../../src/api/index.js";
import { createClient, normalizeBaseUrl } from "../../src/utils/request.js";
import { startStub, type ControlPlaneStub } from "./stub.js";

const ACCOUNT = { username: "alice", password: { set: true }, disabled: false, expiresAtIso: null };

let stub: ControlPlaneStub | null = null;

afterEach(async () => {
  await stub?.close();
  stub = null;
});

async function withBody(body: unknown, act: (http: Http) => Promise<unknown>): Promise<unknown> {
  stub = await startStub(() => ({ status: 200, body }));
  return act(httpFor(stub.baseUrl));
}

type Http = ReturnType<typeof httpFor>;

function httpFor(baseUrl: string) {
  return createClient({ baseUrl: normalizeBaseUrl(baseUrl), key: "k", timeoutMs: 5_000 });
}

describe("解包：读端点交出领域值", () => {
  it("GET /api/users 返回 `accounts` 里的元素，而不是 `{accounts:[...]}`", async () => {
    const out = await withBody({ accounts: [ACCOUNT] }, (h) => listAccounts(h));

    expect(out).toEqual([ACCOUNT]);
    expect(Array.isArray(out)).toBe(true);
  });

  it("GET /api/users/:username 返回 `account` 里的对象，而不是 `{account:{...}}`", async () => {
    const out = await withBody({ account: ACCOUNT }, (h) => getAccount(h, "alice"));

    expect(out).toEqual(ACCOUNT);
    expect(Object.keys(out as object)).toContain("username");
  });

  it("GET /api/acl 返回 `acl` 里的对象", async () => {
    const acl = { clientIp: { whitelist: [], blacklist: [] }, target: { whitelist: ["e"], blacklist: [] }, upstream: { whitelist: [], blacklist: [] } };
    const out = await withBody({ acl }, (h) => getAcl(h));

    expect(out).toEqual(acl);
  });

  it("GET /api/usage/:username 返回 `usage` 对象（全量那条的 usage 是数组，两条不同形）", async () => {
    const usage = { user: "alice", windowKey: "2026-10-06", total: 123 };
    const out = await withBody({ usage, errors: [], lagMs: 0, sideEffect: "s", note: "n" }, (h) =>
      getUsageFor(h, "alice"),
    );

    expect(out).toEqual(usage);
    expect(Array.isArray(out)).toBe(false);
  });

  it("GET /api/usage 全量那条**不**解包（四段元信息与 usage 数组一并交出）", async () => {
    const body = { usage: [{ user: "alice", windowKey: "k", total: 1 }], errors: [], lagMs: 3, sideEffect: "s", note: "n" };
    const out = await withBody(body, (h) => getUsage(h));

    expect(out).toEqual(body);
  });
});

describe("解包：写操作的回包原样交出（它本身就是 ChangeBody）", () => {
  it("POST /api/users 回包不被再剥一层", async () => {
    const change = { changed: true, message: "已创建 alice", effective: "now" };
    const out = await withBody(change, (h) => createAccount(h, { username: "alice", password: "pw" }));

    expect(out).toEqual(change);
  });

  it("`changed: false` 是成功的 no-op，不翻成异常", async () => {
    const change = { changed: false, message: "无变化" };
    await expect(
      withBody(change, (h) => updateAccount(h, "alice", { disabled: false })),
    ).resolves.toEqual(change);
  });

  it("PUT / DELETE /api/users 与 POST|DELETE /api/acl 一律原样交出", async () => {
    const change = { changed: true, message: "ok" };
    expect(await withBody(change, (h) => updateAccount(h, "alice", { password: "p2" }))).toEqual(change);
    expect(await withBody(change, (h) => deleteAccount(h, "alice"))).toEqual(change);
    expect(
      await withBody(change, (h) => addAclEntry(h, { group: "upstream", list: "blacklist", entry: "e" })),
    ).toEqual(change);
    expect(
      await withBody(change, (h) =>
        removeAclEntry(h, { group: "upstream", list: "blacklist", entry: "e" }),
      ),
    ).toEqual(change);
  });
});
