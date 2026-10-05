/**
 * @fileoverview 十二个操作类工具的**扇出**语义 —— 串行 / 部分失败 / 逐台点名
 * @module tests/tools/manager-tools
 * @description
 * 这一档断 `@/tools/batch.js` 的三个决定。它们各自独立成立，少一条的后果都是**一次写打在
 * 计划外的机器上**，或者「模型不知道自己刚刚改了什么」：
 *
 * ① **串行**，不并发 —— 写操作序列的顺序是它的语义的一部分
 * ② **一台失败不停整批** —— 3 台成功 2 台失败是一个**成功**的结果
 * ③ 每台的结果**独立**记，且**逐台点名**（名字 + id）
 *
 * 打桩是真 `node:http`（复用 `tests/api/stub.ts`）—— 扇出的正确性依赖「真的连出去了几台」，
 * 而 mock 掉传输层就数不出来。
 *
 * ⚠️ **id 一律读回来用**，不写死：`id` 由名字的 slug 避让产生（`@/store/managers.js:slugify`），
 * 而中文名落不到 ASCII slug 时退化成 `m`。写死 `["m"]` 的那一版在换成 ASCII 名字后
 * 静默指向了另一条 —— 而 `account_list` 照样回一份成功结果。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startStub, type ControlPlaneStub } from "../api/stub.js";
import { activateEnv, addManager, createEnv, deactivateEnv } from "../../src/store/index.js";
import { cleanupHomes, callTool, tempHome } from "../shared.js";

let home = "";
let stubs: ControlPlaneStub[] = [];

beforeEach(() => {
  home = tempHome();
  stubs = [];
});

afterEach(() => {
  cleanupHomes();
  for (const stub of stubs) {
    void stub.close();
  }
});

type Handler = Parameters<typeof startStub>[0];

/** 起一个打桩控制面并登记进清单，返回真 id */
async function register(
  name: string,
  reply?: Handler,
): Promise<{ readonly stub: ControlPlaneStub; readonly id: string }> {
  const stub = await startStub(reply ?? (() => ({ status: 200, body: { accounts: [] } })));
  stubs.push(stub);
  const record = addManager(home, { name, baseUrl: stub.baseUrl, key: `key-${name}` });
  return { stub, id: record.id };
}

const OK_ACCOUNTS: Handler = (req) =>
  req.path === "/api/users"
    ? { status: 200, body: { accounts: [{ username: "someone" }] } }
    : { status: 404, body: { error: { code: "not-found", message: "没有这个账号" } } };

/** `/api/status` 的一个最小合法体（⚠️ 只需要过信封层，而信封就是整个顶层对象） */
const OK_STATUS: Handler = () => ({ status: 200, body: { process: { pid: 1 } } });

describe("① 显式 managers 决定打哪几台", () => {
  it("只打到指定的那台，另一台一个请求都没收到", async () => {
    const a = await register("甲", OK_ACCOUNTS);
    const b = await register("乙", OK_ACCOUNTS);
    const result = await callTool("account_list", { managers: [a.id] });
    expect(result.error).toBeNull();
    expect(a.stub.requests).toHaveLength(1);
    expect(b.stub.requests).toHaveLength(0);
  });

  it("两台都打", async () => {
    const a = await register("甲", OK_ACCOUNTS);
    const b = await register("乙", OK_ACCOUNTS);
    await callTool("account_list", { managers: [a.id, b.id] });
    expect(a.stub.requests).toHaveLength(1);
    expect(b.stub.requests).toHaveLength(1);
  });

  it("每一台带的是**自己那份** key（不是清单第一条的）", async () => {
    const a = await register("first", OK_ACCOUNTS);
    const b = await register("second", OK_ACCOUNTS);
    await callTool("account_list", { managers: [a.id, b.id] });
    expect(a.stub.requests[0]?.headers["authorization"]).toBe("Bearer key-first");
    expect(b.stub.requests[0]?.headers["authorization"]).toBe("Bearer key-second");
  });

  it("⚠️ 串行：第二台开始时第一台已经收完（并发会把这个顺序变成不确定的）", async () => {
    const order: string[] = [];
    const a = await register("甲", async () => {
      order.push("甲:进");
      await delay(20);
      order.push("甲:出");
      return { status: 200, body: { accounts: [] } };
    });
    const b = await register("乙", () => {
      order.push("乙:进");
      return { status: 200, body: { accounts: [] } };
    });
    await callTool("account_list", { managers: [a.id, b.id] });
    expect(order).toEqual(["甲:进", "甲:出", "乙:进"]);
  });
});

describe("② 一台失败不停整批", () => {
  it("⚠️ 3 台成功 1 台 401 ⇒ 仍然是成功的结果，且逐台点名带状态码与 requestId", async () => {
    const a = await register("甲", OK_ACCOUNTS);
    const b = await register("乙", OK_ACCOUNTS);
    const c = await register("丙", OK_ACCOUNTS);
    const d = await register("丁", () => ({
      status: 401,
      body: {
        error: { code: "unauthorized", message: "缺少或错误的 Bearer 凭据", requestId: "r-1" },
      },
    }));
    const result = await callTool("account_list", {
      managers: [a.id, b.id, c.id, d.id],
    });
    expect(result.error).toBeNull();
    expect(result.text).toContain("共 4 台 · 失败 1 台");
    expect(result.text).toContain("丁");
    expect(result.text).toContain("wire");
    expect(result.text).toContain("401");
    expect(result.text).toContain("r-1");
    expect(result.text).toContain("甲");
  });

  it("⚠️ 失败排在成功前面（模型的注意力先落在没成的事上）", async () => {
    const a = await register("甲", OK_ACCOUNTS);
    const b = await register("乙", () => ({
      status: 500,
      body: { error: { code: "internal", message: "炸了" } },
    }));
    const result = await callTool("account_list", { managers: [a.id, b.id] });
    expect(result.text.indexOf("失败：")).toBeGreaterThan(0);
    expect(result.text.indexOf("成功：")).toBeGreaterThan(result.text.indexOf("失败："));
  });

  it("⚠️ 写操作里一台失败不阻止其余台落地（那是它的语义，不是一次全或全无）", async () => {
    const a = await register("甲", OK_ACCOUNTS);
    const b = await register("乙", () => ({
      status: 500,
      body: { error: { code: "internal", message: "x" } },
    }));
    const result = await callTool("acl_add", {
      managers: [a.id, b.id],
      group: "target",
      list: "blacklist",
      entry: "evil.com",
    });
    expect(result.error).toBeNull();
    expect(a.stub.requests[0]?.method).toBe("POST");
    expect(a.stub.requests[0]?.path).toBe("/api/acl");
    expect(b.stub.requests).toHaveLength(1);
  });

  it("连不上（传输层失败）也归「失败」那一档，不抛出去", async () => {
    // ⚠️ 打桩必须给 `/api/status` 一个真答案：`OK_ACCOUNTS` 只认 `/api/users`，
    // 而这一档调的是 status —— 打桩回 404 的话，「甲」也会被算进失败里，于是断言的
    // 「失败 1 台」变成「失败 2 台」，而症状是**多了一台失败**，与被测的那台无关
    const a = await register("甲", OK_STATUS);
    // ⚠️ 指向 `127.0.0.1:1`（永远没人监听的那个端口）。⚠️ **不能**用 `baseUrl: "not-a-url"` ——
    // 那种地址在 `@/utils/request.js` 的归一那一步就拒了，压根到不了连接层
    const ghost = addManager(home, { name: "ghost", baseUrl: "http://127.0.0.1:1", key: "k" });
    const result = await callTool("status", { managers: [a.id, ghost.id] });
    expect(result.error).toBeNull();
    expect(result.text).toContain("共 2 台 · 失败 1 台");
    expect(result.text).toContain("transport");
    expect(a.stub.requests).toHaveLength(1);
  });

  it("⚠️ 全部台都失败时，聚合体仍回**成功**结果（模型要看到「都失败了」这个事实）", async () => {
    const a = await register("甲", () => ({ status: 500, body: { error: { code: "internal", message: "x" } } }));
    const result = await callTool("status", { managers: [a.id] });
    expect(result.error).toBeNull();
    expect(result.text).toContain("共 1 台 · 失败 1 台");
    expect(result.text).not.toContain("成功：");
  });
});

describe("③ 逐台点名", () => {
  it("每条结果带名字与 id 两样", async () => {
    const a = await register("prod-one", OK_ACCOUNTS);
    const result = await callTool("account_list", { managers: [a.id] });
    expect(result.text).toContain("prod-one");
    expect(result.text).toContain(`(${a.id})`);
  });

  it("⚠️ 报错的文案里不含 baseUrl 与 key（它们逐字进模型的上下文）", async () => {
    const stub = await startStub(() => ({
      status: 500,
      body: { error: { code: "internal", message: "炸了" } },
    }));
    stubs.push(stub);
    const record = addManager(home, {
      name: "leaky",
      baseUrl: stub.baseUrl,
      key: "top-secret-key",
    });
    const result = await callTool("status", { managers: [record.id] });
    expect(result.text).not.toContain("top-secret-key");
    expect(result.text).not.toContain(stub.baseUrl);
  });

  it("聚合体带一句「这次为什么动了这几台」", async () => {
    const a = await register("甲", OK_ACCOUNTS);
    const explicit = await callTool("account_list", { managers: [a.id] });
    expect(explicit.text).toContain("指定了 1 个 manager");

    createEnv(home, { name: "prod", managers: [a.id] });
    activateEnv("prod");
    const viaEnv = await callTool("account_list");
    expect(viaEnv.text).toContain("当前激活的环境 prod");
  });
});

describe("激活的环境驱动缺省", () => {
  it("环境里有两台就两台都打", async () => {
    const b = await register("乙", OK_ACCOUNTS);
    const a = await register("甲", OK_ACCOUNTS);
    createEnv(home, { name: "prod", managers: [b.id, a.id] });
    activateEnv("prod");
    const result = await callTool("account_list");
    expect(result.text).toContain("共 2 台");
    expect(a.stub.requests).toHaveLength(1);
    expect(b.stub.requests).toHaveLength(1);
  });

  it("⚠️ deactivate 之后不给 managers ⇒ 一个请求都不发，报错给模型", async () => {
    const a = await register("甲", OK_ACCOUNTS);
    createEnv(home, { name: "prod", managers: [a.id] });
    activateEnv("prod");
    deactivateEnv();
    const result = await callTool("account_list");
    expect(result.error).toMatch(/没有激活的环境/);
    expect(a.stub.requests).toHaveLength(0);
  });
});

describe("写操作真的打到了对应的端点", () => {
  it("account_update ⇒ PUT /api/users/:username，且路径段被编码", async () => {
    const a = await register("甲", OK_ACCOUNTS);
    await callTool("account_update", {
      managers: [a.id],
      username: "we ird/name",
      disabled: true,
    });
    expect(a.stub.requests[0]?.method).toBe("PUT");
    expect(a.stub.requests[0]?.path).toBe(`/api/users/${encodeURIComponent("we ird/name")}`);
    expect(a.stub.requests[0]?.body).toEqual({ disabled: true });
  });

  it("account_delete ⇒ DELETE，且不带请求体", async () => {
    const a = await register("甲", OK_ACCOUNTS);
    await callTool("account_delete", { managers: [a.id], username: "bob" });
    expect(a.stub.requests[0]?.method).toBe("DELETE");
    expect(a.stub.requests[0]?.rawBody).toBe("");
  });

  it("config 带 key 时只回那一个键，并**点名**键不存在", async () => {
    const a = await register("甲", () => ({
      status: 200,
      body: {
        configDir: "/tmp/x",
        envFiles: [],
        keys: [
          { key: "PROXY_PORT", env: "PROXY_PORT", phase: "startup", restartRequired: true, secret: false, value: 8080, fromEnv: false, fromArgv: false },
        ],
        summary: { total: 1, startup: 1, runtime: 0, secrets: [] },
      },
    }));
    const hit = await callTool("config", { managers: [a.id], key: "PROXY_PORT" });
    expect(hit.error).toBeNull();
    expect(hit.text).toContain("PROXY_PORT");
    expect(hit.text).not.toContain("PROXY_HOST");

    // ⚠️ 键不存在是**那一台**的失败，不是整个调用的失败：它是 per-target 的判定，
    // 于是走聚合体的「失败」那一档（模型要看到「这一台没成」而不是整次调用崩掉）
    const miss = await callTool("config", { managers: [a.id], key: "NOPE" });
    expect(miss.error).toBeNull();
    expect(miss.text).toContain("失败 1 台");
    expect(miss.text).toContain("没有键 NOPE");
  });

  it("account_update 空 patch 本地就拒（省掉一次注定失败的跨机请求）", async () => {
    const a = await register("甲", OK_ACCOUNTS);
    const result = await callTool("account_update", { managers: [a.id], username: "bob" });
    expect(result.error).toMatch(/至少要给一个/);
    expect(a.stub.requests).toHaveLength(0);
  });

  it("闭集形参拼错 ⇒ 本地就拒，且逐字列出合法取值", async () => {
    const a = await register("甲", OK_ACCOUNTS);
    const result = await callTool("acl_add", {
      managers: [a.id],
      group: "clientIp",
      list: "blacklist",
      entry: "x",
    });
    expect(result.error).toMatch(/clientip \| target \| upstream/);
    expect(a.stub.requests).toHaveLength(0);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
