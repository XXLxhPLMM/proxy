/**
 * @fileoverview 钉住**线路层**：`Authorization` 头、`Content-Type` 的出现时机、`DELETE` 不带体
 * @module tests/api/transport.test
 * @description
 * 这一档跑的是 `src/utils/request.ts` 与本层端点函数之间的接缝。鉴权头的字面形状错一个字符，
 * 服务端回的是 401，而 401 与「token 过期」在模型眼里长得一模一样 —— 所以必须逐字钉住。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  createAccount,
  deleteAccount,
  getAcl,
  getStatus,
  updateAccount,
} from "../../src/api/index.js";
import { createClient, normalizeBaseUrl } from "../../src/utils/request.js";
import { startStub, type ControlPlaneStub, type StubReply } from "./stub.js";

const KEY = "tok_live_deadbeef";
const USERNAME = "alice";

let stub: ControlPlaneStub | null = null;

afterEach(async () => {
  await stub?.close();
  stub = null;
});

async function open(reply: StubReply): Promise<ControlPlaneStub> {
  stub = await startStub(() => reply);
  return stub;
}

function httpFor(baseUrl: string) {
  return createClient({ baseUrl: normalizeBaseUrl(baseUrl), key: KEY, timeoutMs: 5_000 });
}

describe("线路层：请求的线上形状", () => {
  it("Authorization 头逐字是 `Bearer <key>`（不带多余空白、不换引号形式）", async () => {
    const server = await open({ status: 200, body: { pid: 1 } });
    await getStatus(httpFor(server.baseUrl));

    expect(server.last().headers["authorization"]).toBe(`Bearer ${KEY}`);
  });

  it("GET 请求不带请求体，因此也不带 Content-Type", async () => {
    const server = await open({ status: 200, body: { acl: {} } });
    await getAcl(httpFor(server.baseUrl));

    expect(server.last().rawBody).toBe("");
    expect(server.last().headers["content-type"]).toBeUndefined();
  });

  it("DELETE 不带请求体（连空 JSON 对象都不给）", async () => {
    const server = await open({ status: 200, body: { changed: true, message: "已删除" } });
    await deleteAccount(httpFor(server.baseUrl), USERNAME);

    expect(server.last().method).toBe("DELETE");
    expect(server.last().rawBody).toBe("");
    expect(server.last().headers["content-type"]).toBeUndefined();
  });

  it("带请求体的写操作带 `Content-Type: application/json`", async () => {
    const server = await open({ status: 201, body: { changed: true, message: "已创建" } });
    await createAccount(httpFor(server.baseUrl), { username: USERNAME, password: "pw" });

    expect(server.last().headers["content-type"]).toBe("application/json");
  });

  it("DELETE /api/acl 是唯一带体的 DELETE —— 体仍须是 application/json", async () => {
    const server = await open({ status: 200, body: { changed: true, message: "已删除" } });
    await updateAccount(httpFor(server.baseUrl), USERNAME, { disabled: true });

    expect(server.last().method).toBe("PUT");
    expect(server.last().headers["content-type"]).toBe("application/json");
  });

  it("客户端把控制面响应当作不可缓存（一份含账号表的快照不该留在中间缓存里）", async () => {
    const server = await open({ status: 200, body: {} });
    await getStatus(httpFor(server.baseUrl));

    expect(server.last().headers["cache-control"]).toBe("no-store");
  });
});
