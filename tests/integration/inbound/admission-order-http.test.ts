/**
 * HTTP 入站准入的三关顺序：名单 → 鉴权 → 目标名单，每一关的事件与终态逐条锁死。
 *
 * 关卡 ①②③ 的定义与顺序理由、两条准入结构的决策，以及「名单拒那两档必须开着鉴权」这个已实测的
 * 假绿，全部归本目录 `./AGENTS.md` —— 另一份在 SOCKS5 侧，共用同一份故不复制在这里；
 * 装配面见 `./admission-fixture.js`。
 *
 * @module tests/integration/inbound/admission-order-http
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { sleep } from "../../helpers/net.js";
import {
  ACCOUNT,
  authDecided,
  basicAuth,
  startOrigin,
  startProxy,
  stopAll,
  timeline,
  writeAcl,
} from "./admission-fixture.js";

afterEach(stopAll);

/** 明文 HTTP 请求（absolute-form），可选带 Basic 凭证 */
function httpViaProxy(
  port: number,
  targetPort: number,
  credentials?: { user: string; pass: string },
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${targetPort}` };
    if (credentials) {
      headers["Proxy-Authorization"] =
        `Basic ${Buffer.from(`${credentials.user}:${credentials.pass}`).toString("base64")}`;
    }
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: `http://127.0.0.1:${targetPort}/ok`, headers },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const CREDS = { user: ACCOUNT.username, pass: ACCOUNT.password };

describe("HTTP 入站准入：三关顺序与事件逐条锁死", () => {
  it("① 名单拒（**开着鉴权**）→ 恰好一条 ip-denied + 一个 access/403 终态，**零条鉴权事件**", async () => {
    const origin = await startOrigin();
    // ⚠️ 必须 `authEnabled: true` + 注入真身份提供者：关鉴权时它直接放行且**不发审计事件**，
    // 那样的时间线里根本没有 `auth.decided` 这条可观测的「鉴权发生过」的痕迹——
    // 于是「把名单判定挪到鉴权之后」这种顺序反转在测试里**完全看不出来**（已实测：会假绿）。
    // 开着鉴权、并**带上正确凭证**（最强的形态：连可用凭证都不许被消耗）才测得出顺序。
    const { port, marks } = await startProxy(
      { authEnabled: true, aclFile: writeAcl({ clientIp: { blacklist: ["127.0.0.1"] } }) },
      { identity: basicAuth() },
    );

    const res = await httpViaProxy(port, origin.port, CREDS);
    await sleep(40);

    expect(res.status).toBe(403);
    expect(timeline(marks)).toEqual(["pipe:ip-denied", "access.client-denied", "request.rejected"]);
    expect(marks.at(-1)?.detail).toBe("access/403");
    expect(authDecided(marks), "被禁来源不得进入鉴权（连正确凭证都不许被消费）").toEqual([]);
  });

  it("② 鉴权拒 → 零条 ip-denied、恰好一条 auth.decided(false) + 一个 auth/407 终态", async () => {
    const origin = await startOrigin();
    const { port, marks } = await startProxy({ authEnabled: true }, { identity: basicAuth() });

    const res = await httpViaProxy(port, origin.port, { user: "alice", pass: "wrong" });
    await sleep(40);

    expect(res.status).toBe(407);
    expect(timeline(marks)).toEqual(["auth.decided", "request.rejected"]);
    expect(authDecided(marks).map((m) => m.detail)).toEqual([false]);
    expect(marks.at(-1)?.detail).toBe("auth/407");
  });

  it("③ 目标名单拒 → 鉴权在**前**、target-denied 在后（先有身份才判得了个人名单）", async () => {
    const origin = await startOrigin();
    const { port, marks } = await startProxy(
      { authEnabled: true, aclFile: writeAcl({ target: { blacklist: ["127.0.0.1"] } }) },
      { identity: basicAuth() },
    );

    const res = await httpViaProxy(port, origin.port, CREDS);
    await sleep(40);

    expect(res.status).toBe(403);
    expect(timeline(marks)).toEqual([
      "auth.decided",
      "pipe:target-denied",
      "access.target-denied",
      "request.rejected",
    ]);
    expect(authDecided(marks).map((m) => m.detail)).toEqual([true]);
    expect(marks.at(-1)?.detail).toBe("access/403");
  });

  it("鉴权拒时目标名单**根本没被问**（顺序反了的直接后果）", async () => {
    const origin = await startOrigin();
    const { port, marks } = await startProxy(
      { authEnabled: true, aclFile: writeAcl({ target: { blacklist: ["127.0.0.1"] } }) },
      { identity: basicAuth() },
    );

    const res = await httpViaProxy(port, origin.port, { user: "alice", pass: "wrong" });
    await sleep(40);

    expect(res.status).toBe(407);
    expect(timeline(marks)).toEqual(["auth.decided", "request.rejected"]);
    expect(timeline(marks), "鉴权没过就不许出现任何 target-denied").not.toContain("pipe:target-denied");
  });

  it("三关全过：鉴权 → 目标放行 → 转发（终态是 completed 而非 rejected）", async () => {
    const origin = await startOrigin();
    const { port, marks, events } = await startProxy(
      { authEnabled: true, aclFile: writeAcl({ clientIp: { whitelist: ["127.0.0.1"] } }) },
      { identity: basicAuth() },
    );
    const terminals: string[] = [];
    events.subscribe("request.completed", () => terminals.push("completed"));

    const res = await httpViaProxy(port, origin.port, CREDS);
    await sleep(40);

    expect(res.status).toBe(200);
    expect(timeline(marks)).toEqual(["auth.decided"]);
    expect(terminals).toEqual(["completed"]);
  });
});
