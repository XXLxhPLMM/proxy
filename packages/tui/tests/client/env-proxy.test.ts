/**
 * 环境代理这一圈：`HTTP_PROXY` / `NO_PROXY` 真的被用上
 *
 * @description
 * ⚠️ **这一档存在的理由是「别的档证明不了」**：`@/api/send.ts` **刻意不写 `proxy`**
 * 这一格（缺省时 axios 逐请求读环境），而「缺省」在**任何**别的判据上都长得跟 `proxy: false`
 * 一模一样 —— 不起代理时两者行为完全一致。故只有一条**正向**牙齿能分开它们：真的架一个代理，
 * 然后断言请求**到了代理手里**。
 * ⚠️ 反向的那一半（`NO_PROXY` 能绕过）也在：只有「会用」而没有「能不用」，等于把
 * 「控制面就在本机」这一类最常见的配置也一并劫走。
 *
 * ⚠️ **必须 `afterEach` 还原环境变量**：本包 `pool: "forks"` 复用 worker，一个档留下的
 * `HTTP_PROXY` 会把同 worker 里后面那些档对着 `127.0.0.1` 的真 `http.Server` 请求全部劫走。
 *
 * @module tests/client
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { status } from "@/api/index.js";
import { TuiError } from "@/lib/index.js";
import { STATUS_BODY } from "./_double.js";

const saved = new Map<string, string | undefined>();
const setEnv = (key: string, value: string): void => {
  saved.set(key, process.env[key]);
  process.env[key] = value;
};
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

/** 一个只会照着绝对 URL 回话的正向 HTTP 代理（记下它看见了什么） */
async function startProxy(): Promise<{
  readonly url: string;
  readonly seen: () => readonly string[];
  readonly close: () => Promise<void>;
}> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(STATUS_BODY));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen: () => seen,
    close: (): Promise<void> =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** 一台**永远不在**被访问的地址：请求到了它就说明没有代理在中间 */
const DEAD = "http://127.0.0.1:1";

describe("环境代理：`HTTP_PROXY` 配了就得真的用（缺省 vs `proxy: false` 只在这条上分开）", () => {
  it("⚠️ `HTTP_PROXY` 指向一个真代理 ⇒ 请求**到了代理手里**", async () => {
    const proxy = await startProxy();
    try {
      setEnv("HTTP_PROXY", proxy.url);
      const client = { baseUrl: DEAD, token: "t", timeoutMs: 3000 };

      const body = await status(client);

      // ⚠️ **核心判据**：代理**真的看见了**这条请求。写成 `proxy: false` 的实现这一条必红
      // （`DEAD` 那个端口没人监听 ⇒ 连不上，而那一档压根到不了这里）
      expect(proxy.seen().length).toBe(1);
      // ⚠️ 而它答的正是控制面该答的那份（走了代理也**不许**把响应读成别的形状）
      expect(body.proxy.running).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it("⚠️ `NO_PROXY` 命中 ⇒ **绕过**代理（控制面常就在本机，劫走它是纯故障）", async () => {
    const proxy = await startProxy();
    try {
      setEnv("HTTP_PROXY", proxy.url);
      setEnv("NO_PROXY", "127.0.0.1");
      const client = { baseUrl: DEAD, token: "t", timeoutMs: 1000 };

      // 代理不会答，而控制面那个地址没人监听 ⇒ 「绕过」这件事的表现就是**连不上**
      const err = await status(client).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(proxy.seen()).toEqual([]);
      expect(err, "绕过代理时那个地址本来就没人监听").toBeInstanceOf(TuiError);
    } finally {
      await proxy.close();
    }
  });

  it("⚠️ 代理地址的 userinfo **不进**错误文案（`HTTP_PROXY=http://user:pw@…` 的凭据会跟着 axios 的 message 走）", async () => {
    // 代理地址本身没人监听 ⇒ 必然失败，而失败文案是 `err.message` ⇒ 那是唯一一条会带上
    // 代理地址的路径。断言形状是「文案里不含那两段凭据」而不是「不含 `user`」—— 逐字写死
    // 一个会在换个代理实现之后悄悄失配
    setEnv("HTTP_PROXY", "http://proxyuser:proxypass@127.0.0.1:1");
    const client = { baseUrl: DEAD, token: "t", timeoutMs: 1000 };

    const err = await status(client).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TuiError);
    const message = (err as TuiError).message;
    expect(message).not.toContain("proxyuser");
    expect(message).not.toContain("proxypass");
  });
});