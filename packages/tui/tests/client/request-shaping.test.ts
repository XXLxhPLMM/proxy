/**
 * 对外发出的那个请求长什么样：请求体、方法、`Content-Type`、请求行上的编码
 *
 * @description
 * 写面的请求体与幂等 no-op，加上 `:username` 怎么进请求行。
 *
 * - **`DELETE` 也带 body**：服务端 `routes/input.ts:aclMutationInput` 收请求体（并与查询串不一致时报错），
 *   而很多 HTTP 客户端会在 `DELETE` 上丢 body —— 改用查询串就得在客户端多写一条分支，而那正是「删了 A 实际
 *   删了 B」那条事故最容易长出来的地方。⚠️ 故**查询串那条通路一次都不许带**（带了就得在客户端与判据之间
 *   同步两份形态）。判据锚在 `seen[0].body` 的**长度与三键** —— 只断言方法与路径的话，改成查询串那条通路
 *   一样绿。
 * - **`changed: false` 不是错误**：名单写是幂等的，「加一条它已经有了的」是 200 + 一个字节都没动。抛了会让
 *   界面说「操作失败」，而用户已经达到目的了。⚠️ 故判据锚在 resolve 出来的那份 body（含 `message` 与
 *   `effective`），而不是断言「没抛」—— 抛了会红、改成 reject 一档也会红。
 * - **空 patch 在本地先判**：断言 `assertNonEmptyPatch` 抛错，**并**断言替身**一个请求都没收到**
 *   （那一次注定被拒的往返是白花的）。它同时是界面「保存」按钮可以在本地先禁用的那条判据。
 * - **`:username` 真的进了路径**（含 `/` 的用户名必须以 `%2F` 上线）：`%2F` 在 `req.url` 里仍然是 `%2F`，
 *   而裸 `/` 会把路径切成三段 ⇒ 请求落到另一个端点上。⚠️ mock 掉 fetch 时「服务端收到的 url」是测试自己
 *   编的，于是 `%2F` 变成裸 `/` 也照样绿 —— 故断言的是线上请求行。
 * - **含 `?` / `#` 的用户名不许改写请求行**（否则服务端**根本收不到**那段名字）。判据锚在**本次**那一条
 *   （`seen[before]`），而不是整段历史的第 0 条。
 *
 * 目录级不变量在 `AGENTS.md`。
 *
 * @module tests/client/request-shaping
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addAclEntry,
  assertNonEmptyPatch,
  removeAclEntry,
  updateAccount,
  usageFor,
  user,
} from "@/api/index.js";
import { CHANGE_BODY, caught, clientTo, startDouble, type Double } from "./_double.js";

/** 替身生命周期：每个用例自己起、自己关（不与别的用例共享端口或 token） */
let double: Double;

beforeEach(async () => {
  double = await startDouble();
});

afterEach(async () => {
  await double.close();
});

describe("写面：请求体、方法与幂等 no-op", () => {
  it("**`DELETE /api/acl` 确实带 body**，且是 `group` / `list` / `entry` 三键", async () => {
    // 服务端 `routes/input.ts:aclMutationInput` 收请求体（并与查询串不一致时报错）。
    // 很多 HTTP 客户端会在 DELETE 上丢 body —— 改用查询串就得在客户端多写一条分支，
    // 而那正是「删了 A 实际删了 B」那条事故最容易长出来的地方。
    double.route("DELETE /api/acl", { json: CHANGE_BODY });
    await removeAclEntry(clientTo(double), {
      group: "target",
      list: "whitelist",
      entry: "ok.test",
    });
    const sent = double.seen[0];
    expect(sent.method).toBe("DELETE");
    expect(sent.path).toBe("/api/acl");
    expect(sent.body.length, "DELETE 丢了 body").toBeGreaterThan(0);
    expect(sent.contentType).toBe("application/json");
    expect(Object.keys(JSON.parse(sent.body) as object).sort()).toEqual(["entry", "group", "list"]);
    expect(JSON.parse(sent.body)).toEqual({
      group: "target",
      list: "whitelist",
      entry: "ok.test",
    });
    // 查询串那条通路**一次都不许带**（带了就得在客户端与判据之间同步两份形态）
    expect(sent.query).toBe("");
  });

  it("`POST /api/acl` 同样带这三个键（两个方法共用一份入参）", async () => {
    double.route("POST /api/acl", { json: CHANGE_BODY });
    await addAclEntry(clientTo(double), {
      group: "clientip",
      list: "blacklist",
      entry: "10.0.0.0/8",
    });
    expect(JSON.parse(double.seen[0].body)).toEqual({
      group: "clientip",
      list: "blacklist",
      entry: "10.0.0.0/8",
    });
  });

  it("**`changed: false` 不是错误**：`addAclEntry` 正常 resolve，`message` 逐字保留", async () => {
    double.route("POST /api/acl", {
      json: {
        changed: false,
        message: "target.whitelist 里已经有 ok.test，没动",
        effective: null,
      },
    });
    const change = await addAclEntry(clientTo(double), {
      group: "target",
      list: "whitelist",
      entry: "ok.test",
    });
    expect(change.changed).toBe(false);
    // 「一个字节都没动」这件事必须原样传上去：界面上要能说「没动」而不是说「已改」
    expect(change.message).toBe("target.whitelist 里已经有 ok.test，没动");
    expect(change.effective).toBeNull();
  });

  it("`removeAclEntry` 的 no-op 同样 resolve（移一条本来就没有的也是 200）", async () => {
    double.route("DELETE /api/acl", {
      json: {
        changed: false,
        message: "target.whitelist 里没有 never.test，没动",
        effective: null,
      },
    });
    const change = await removeAclEntry(clientTo(double), {
      group: "target",
      list: "whitelist",
      entry: "never.test",
    });
    expect(change.changed).toBe(false);
    expect(change.message).toContain("没动");
  });

  it("空 patch 在**本地**先判：抛 `wire`/`invalid`，且一个请求都没发出去", async () => {
    const err = await caught(() => updateAccount(clientTo(double), "alice", {}));
    expect(err.kind).toBe("wire");
    expect(err.code).toBe("invalid");
    expect(err.request).toBe("(未发出)");
    // 那一次注定被拒的往返是白花的：替身一个请求都没收到
    expect(double.seen).toHaveLength(0);
  });

  it("`assertNonEmptyPatch` 是可直接调的纯判据（界面上「保存」按钮可以在本地先禁用）", () => {
    expect(() => assertNonEmptyPatch({})).toThrow();
    expect(() => assertNonEmptyPatch({ disabled: false })).not.toThrow();
  });
});

describe("`:username` 真的进了路径", () => {
  it("含 `/` 的用户名以 `%2F` 上线，服务端看到的是**一个**路径段", async () => {
    // 本档最有价值的一条：mock 掉 fetch 时「服务端收到的 url」是测试自己编的，
    // 于是 `%2F` 变成裸 `/`（多切一段 → 请求打到另一个端点）也照样绿。
    double.route("GET /api/users/a%2Fb", {
      json: {
        account: {
          username: "a/b",
          password: { set: true },
          disabled: false,
          expiresAtIso: null,
        },
      },
    });
    const account = await user(clientTo(double), "a/b");
    expect(account.username).toBe("a/b");
    expect(double.seen[0].url).toBe("/api/users/a%2Fb");
    expect(double.seen[0].path).toBe("/api/users/a%2Fb");
    // 裸 `/` 会把路径切成三段 ⇒ 请求落到另一个端点上
    expect(double.seen[0].path.split("/")).toHaveLength(4);
  });

  it("含 `?` / `#` 的用户名不会改写请求行（否则服务端**根本收不到**那段名字）", async () => {
    const cases: Array<[string, string]> = [
      ["a?b", "/api/users/a%3Fb"],
      ["a#b", "/api/users/a%23b"],
    ];
    for (const [name, expected] of cases) {
      double.route(`GET ${expected}`, {
        json: {
          account: { username: name, password: { set: true }, disabled: false, expiresAtIso: null },
        },
      });
      const before = double.seen.length;
      const account = await user(clientTo(double), name);
      expect(account.username).toBe(name);
      // 取**本次**那一条：判据锚在「刚刚发出去的那个请求」上，而不是整段历史的第 0 条
      const sent = double.seen[before];
      expect(sent.url, `${name} 改写了请求行`).toBe(expected);
      expect(sent.query, `${name} 起了一段查询串`).toBe("");
    }
  });

  it("`usageFor` 走同一套编码（读面与写面的穿越边界一样宽）", async () => {
    double.route("GET /api/usage/a%2Fb", {
      json: {
        usage: { user: "a/b", windowKey: "2026-10", total: 1 },
        errors: [],
        lagMs: 0,
        sideEffect: "物化",
        note: "不能清账",
      },
    });
    const body = await usageFor(clientTo(double), "a/b");
    expect(body.usage.user).toBe("a/b");
    expect(double.seen[0].url).toBe("/api/usage/a%2Fb");
  });
});
