/**
 * 成功路径：每个面回什么形状，端点函数就解出什么
 *
 * @description
 * 契约里五个读面 + 单条读面 + 写面的**成功解码**，以及「请求参数就是那三格普通数据」这一条
 * （⚠️ 没有「客户端对象」这一层，故没有 `info` / 端点表那种元信息可断言）。
 *
 * - **成功路径必须真的过鉴权**：替身默认要求 `Authorization` **逐字**等于 `Bearer <token>`，不匹配即回 401
 *   （复刻 `respond.ts:sendUnauthorized` 的响应体）。于是「客户端确实把凭据送到了」是成功路径的
 *   **前提**，而不是一条另写的断言。
 * - **用法各走各的解码器**：`/api/usage` 与 `/api/usage/:username` 两个形状不同，断言的是解出来的形状。
 * - **`GET` 请求不带 body 也不带 `Content-Type`**：带了会被读成空 patch 之类的怪事。
 * - **带 body 的那几次必须带 `Content-Type: application/json`**（服务端对非 JSON 体一律 400）。
 *   ⚠️ 判据逐条点名而不是 `every`：无 body 的 `DELETE` 没有这个头，`every` 会误伤。
 * - ⚠️ **axios 的调用点恒等于空集**（除了 `api/send.ts` 那一处）：`(method, path)` 是手抄的弱耦合，
 *   而「谁有资格发请求」这条纪律只能靠源码级判据守。
 *
 * 目录级不变量（替身是什么、为什么必须起真服务器、防假绿的位置、替身生命周期归谁）在 `AGENTS.md`。
 *
 * @module tests/client/success-paths
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acl,
  config,
  createAccount,
  deleteAccount,
  status,
  updateAccount,
  usage,
  usageFor,
  user,
  users,
} from "@/api/index.js";
import { codeOnly, sourceFilesUnder } from "../_source.js";
import { CHANGE_BODY, STATUS_BODY, clientTo, startDouble, type Double } from "./_double.js";

/** 替身生命周期：每个用例自己起、自己关（不与别的用例共享端口或 token） */
let double: Double;

beforeEach(async () => {
  double = await startDouble();
});

afterEach(async () => {
  await double.close();
});

describe("成功路径：五个读面 + 单条读面 + 写面", () => {
  it("`GET /api/status`", async () => {
    double.route("GET /api/status", { json: STATUS_BODY });
    const body = await status(clientTo(double));
    expect(body.proxy.mode).toBe("running");
    expect(body.data.usage.dir).toBe("/srv/proxy/cfg/usage");
    expect(double.seen).toHaveLength(1);
    expect(double.seen[0].method).toBe("GET");
    expect(double.seen[0].path).toBe("/api/status");
  });

  it("`GET /api/config`", async () => {
    double.route("GET /api/config", {
      json: {
        configDir: "/srv/proxy",
        envFiles: [],
        keys: [],
        summary: { total: 0, startup: 0, runtime: 0, secrets: [] },
      },
    });
    const body = await config(clientTo(double));
    expect(body.configDir).toBe("/srv/proxy");
    expect(double.seen[0].path).toBe("/api/config");
  });

  it("`GET /api/users`", async () => {
    double.route("GET /api/users", {
      json: {
        accounts: [
          { username: "alice", password: { set: true }, disabled: false, expiresAtIso: null },
        ],
      },
    });
    const body = await users(clientTo(double));
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].password).toEqual({ set: true });
  });

  it("`GET /api/users/:username`：解码后交出**账号本身**（不是 `{account}` 那层包装）", async () => {
    double.route("GET /api/users/alice", {
      json: {
        account: {
          username: "alice",
          password: { set: true },
          disabled: false,
          expiresAtIso: null,
        },
      },
    });
    const account = await user(clientTo(double), "alice");
    expect(account.username).toBe("alice");
    expect(account.expiresAtIso).toBeNull();
    expect(double.seen[0].path).toBe("/api/users/alice");
  });

  it("`GET /api/acl`", async () => {
    double.route("GET /api/acl", {
      json: {
        acl: {
          clientIp: { whitelist: [], blacklist: [] },
          target: { whitelist: ["ok.test"], blacklist: [] },
          upstream: { whitelist: [], blacklist: [] },
        },
      },
    });
    const body = await acl(clientTo(double));
    expect(body.acl.target.whitelist).toEqual(["ok.test"]);
  });

  it("`GET /api/usage` 与 `GET /api/usage/:username`（两个形状不同，各走各的解码器）", async () => {
    const row = { user: "alice", windowKey: "2026-10", total: 12_345 };
    const tail = { errors: [], lagMs: 60_000, sideEffect: "物化", note: "不能清账" };
    double.route("GET /api/usage", { json: { usage: [row], ...tail } });
    double.route("GET /api/usage/alice", { json: { usage: row, ...tail } });
    const client = clientTo(double);
    expect((await usage(client)).usage).toHaveLength(1);
    expect((await usageFor(client, "alice")).usage).toEqual(row);
  });

  it("`POST /api/users`（201）与 `PUT` / `DELETE /api/users/:username`", async () => {
    double.route("POST /api/users", {
      status: 201,
      json: { changed: true, message: "已新建账号 bob" },
    });
    double.route("PUT /api/users/bob", { json: CHANGE_BODY });
    double.route("DELETE /api/users/bob", { json: CHANGE_BODY });
    const client = clientTo(double);
    expect((await createAccount(client, { username: "bob", password: "pw1" })).message).toBe(
      "已新建账号 bob",
    );
    expect((await updateAccount(client, "bob", { disabled: true })).changed).toBe(true);
    expect((await deleteAccount(client, "bob")).changed).toBe(true);
    expect(double.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/users",
      "PUT /api/users/bob",
      "DELETE /api/users/bob",
    ]);
    // 带 body 的那两次必须带 `Content-Type: application/json`（服务端对非 JSON 体一律 400）；
    // ⚠️ 判据逐条点名而不是 `every`：无 body 的 DELETE 没有这个头，`every` 会误伤
    expect(double.seen[0].contentType).toBe("application/json");
    expect(double.seen[1].contentType).toBe("application/json");
    expect(double.seen[2].body).toBe("");
  });

  it("`GET` 请求**不带** body 也不带 `Content-Type`（带了会被读成空 patch 之类的怪事）", async () => {
    double.route("GET /api/status", { json: STATUS_BODY });
    await status(clientTo(double));
    expect(double.seen[0].body).toBe("");
    expect(double.seen[0].contentType).toBeUndefined();
  });
});

describe("请求参数本身就是全部（⚠️ 没有「客户端对象」这一层）", () => {
  it("`clientTo` 给的就是那三格普通数据（**端点函数自己 axios**）", () => {
    const target = clientTo(double);
    expect(target.baseUrl).toBe(double.baseUrl);
    expect(target.token).toBe(double.token);
    expect(target.timeoutMs).toBe(5000);
    // ⚠️ **正向对照**：这三格真的够发一次请求（上面那些断言只是「造得对」，这条是「用得了」）
    expect(Object.keys(target).sort()).toEqual(["baseUrl", "timeoutMs", "token"]);
  });

  it("⚠️ axios 是**唯一**那扇门，而只有 `@/api/send.ts` 走它", () => {
    // ⚠️ 契约是手抄的弱耦合 ⇒ `axios` 一旦在别处被调，就是一个**没有任何东西会红**的
    // `(method, path)`。判据是「`src/` 里 axios 的调用点集合」而不是「某个客户端对象上有没有那一格」
    // —— 后者随 `ManagerTarget` 的形状一起变，而本条要护的是「谁有资格发请求」。
    const SRC_SEND = [...sourceFilesUnder()].find(([name]) => name === "api/send.ts")![1];
    const callers = [...sourceFilesUnder()]
      .filter(([name, text]) => name !== "api/send.ts" && codeOnly(text).includes("axios."))
      .map(([name]) => name)
      .sort();
    // ⚠️ **空集**：端点函数自己 axios，而它们全部经 `sendDecoded` → `send`，故拨号只有 `api/send.ts`
    // 一处。多一条 ⇒ 有人绕过那四条纪律（`validateStatus` / 环境代理 / 超时判据 / 不重试）自己拨号。
    expect(callers).toEqual([]);
    // ⚠️ **防假绿**：拨号那一格**确实**在拨号（否则上面那条是「探测器什么词都认不出」）
    expect(codeOnly(SRC_SEND)).toContain("axios.request(");
  });
});
