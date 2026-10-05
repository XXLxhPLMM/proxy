/**
 * @fileoverview 钉住**写操作的请求体**：逐字段只含白名单里的键，没给的不出现
 * @module tests/api/request-body.test
 * @description
 * `POST /api/users` 的服务端对**未知键直接 400**（根仓 `src/manager/routes/users.ts`），
 * 而模型给的参数常常带着服务端不认的额外键。故这一层挑白名单而不是整体转发 —— 这条护栏
 * 钉的就是「挑」这个动作本身：白名单里的键逐个都该在，白名单外的键一个都不该在。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  addAclEntry,
  createAccount,
  removeAclEntry,
  updateAccount,
  type AccountCreateInput,
} from "../../src/api/index.js";
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

async function bodyOf(act: (http: ReturnType<typeof httpFor>) => Promise<unknown>): Promise<Record<string, unknown>> {
  stub = await startStub(() => ({ status: 200, body: { changed: true, message: "ok" } }));
  await act(httpFor(stub.baseUrl));
  const body = stub.last().body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(`请求体不是一个 JSON 对象：${JSON.stringify(body)}`);
  }
  return body as Record<string, unknown>;
}

const ACL_INPUT = { group: "clientip", list: "whitelist", entry: "10.0.0.0/8" } as const;

describe("POST /api/users：请求体逐字段只含白名单里的键", () => {
  it("只给必填两项时，体里就只有这两项", async () => {
    const body = await bodyOf((h) => createAccount(h, { username: "alice", password: "pw" }));

    expect(Object.keys(body).sort()).toEqual(["password", "username"]);
    expect(body["username"]).toBe("alice");
  });

  it("七个可选键全给时，逐个都进体里", async () => {
    const body = await bodyOf((h) =>
      createAccount(h, {
        username: "alice",
        password: "pw",
        quotaBytes: 1024,
        quotaWindow: "day",
        expiresAt: "2027-01-01T00:00:00Z",
        disabled: false,
        targetWhitelist: ["a.example"],
        targetBlacklist: ["b.example"],
      }),
    );

    expect(Object.keys(body).sort()).toEqual([
      "disabled",
      "expiresAt",
      "password",
      "quotaBytes",
      "quotaWindow",
      "targetBlacklist",
      "targetWhitelist",
      "username",
    ]);
  });

  it("没给的键**不出现**在体里（不是出现且值为 null/undefined）", async () => {
    const body = await bodyOf((h) => createAccount(h, { username: "alice", password: "pw" }));

    expect(Object.prototype.hasOwnProperty.call(body, "quotaBytes")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, "disabled")).toBe(false);
    expect(JSON.stringify(body)).not.toContain("quotaBytes");
  });

  it("`disabled: false` 是**有意义的值**（要能关掉账号），不许被 `undefined` 那条过滤吃掉", async () => {
    const body = await bodyOf((h) => createAccount(h, { username: "alice", password: "pw", disabled: false }));

    expect(body["disabled"]).toBe(false);
  });

  it("`quotaBytes: 0`（= 不限流）同样要发得出去", async () => {
    const body = await bodyOf((h) => createAccount(h, { username: "alice", password: "pw", quotaBytes: 0 }));

    expect(body["quotaBytes"]).toBe(0);
  });

  it("显式清空走专属字面量而不是缺省：清零 / 清过期时间各归各的键", async () => {
    const body = await bodyOf((h) =>
      createAccount(h, { username: "alice", password: "pw", quotaWindow: "clear", expiresAt: "clear" }),
    );

    expect(body["quotaWindow"]).toBe("clear");
    expect(body["expiresAt"]).toBe("clear");
  });

  it("模型多给的未知键被这一层丢掉（否则服务端 400，而模型看不出是哪一项多余）", async () => {
    // 走变量而非字面量：模型给的参数在类型上就该是多出来的键，故这里不能被 excess property check 拦住
    const fromModel: AccountCreateInput & { nickName?: string; role?: string } = {
      username: "alice",
      password: "pw",
      nickName: "爱丽丝",
      role: "admin",
    };
    const body = await bodyOf((h) => createAccount(h, fromModel));

    expect(Object.keys(body).sort()).toEqual(["password", "username"]);
    expect(JSON.stringify(body)).not.toContain("nickName");
  });
});

describe("PUT /api/users/:username：同样的白名单，不含 username", () => {
  it("patch 里的键逐个进体，且不带 username（用户名在路径上，重复发会被服务端当成改名字）", async () => {
    const body = await bodyOf((h) =>
      updateAccount(h, "alice", { password: "pw2", quotaBytes: 2048, targetWhitelist: ["c.example"] }),
    );

    expect(Object.keys(body).sort()).toEqual(["password", "quotaBytes", "targetWhitelist"]);
  });

  it("空 patch 也照发（⚠️ 服务端会 400 —— 本层不替调用方兜，那会掩盖「压根没说要改什么」）", async () => {
    const body = await bodyOf((h) => updateAccount(h, "alice", {}));

    expect(body).toEqual({});
    expect(stub?.last().rawBody).toBe("{}");
  });
});

describe("acl 的加与删：同一个入参整体转发（三个字段全必填，没有白名单可挑）", () => {
  it("POST /api/acl 的体是 `{group,list,entry}`", async () => {
    const body = await bodyOf((h) => addAclEntry(h, ACL_INPUT));

    expect(body).toEqual({ group: "clientip", list: "whitelist", entry: "10.0.0.0/8" });
  });

  it("DELETE /api/acl 的体与 POST 完全一致（能定位到同一条目的方式必须相同）", async () => {
    const post = await bodyOf((h) => addAclEntry(h, ACL_INPUT));
    const del = await bodyOf((h) => removeAclEntry(h, ACL_INPUT));

    expect(del).toEqual(post);
    expect(stub?.last().method).toBe("DELETE");
  });
});
