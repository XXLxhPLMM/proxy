/**
 * 凭据：发出去的那一头逐字对不对，以及判错之后客户端说的是什么
 *
 * @description
 * `Authorization` 的**形态**，与**判错之后的说法**（`wire` 档该带的四个字段）。
 *
 * - **替身只接受逐字 `Bearer <token>`** ⇒ 成功路径变绿的唯一可能就是客户端真的发了它。「带了个
 *   `Authorization` 头」不足以让任何一条变绿，所以另配一组负向样本逐个形态单独发。
 * - **七种形态都要被拒**：错的大小写 / 少一个空格 / 多一个空格 / `Basic` / 裸 token / 后面多跟一个字符 /
 *   完全没有这个头。⚠️ 不合并成「至少有一条被拒」—— 判据只拒掉一种形态时那句也绿；且每一条都必须真的
 *   **收到了请求**（否则「401」也可能来自未登记路由的兜底）。
 * - **`wire` 档必须带齐四个字段**（`code` / `status` / `requestId` / `request`）：混成一类就等于界面只能说
 *   「出错了」，而把「token 不对」显示成别的会把人带去改一份完全正确的凭据。
 * - **传输面不改写对面的话**：401 的文案逐字断言（`err.message` 就是服务端那句）。
 * - **表外的 `code` 降级成 `internal` 而 `requestId` 保留** —— 还能接上服务端日志。
 *
 * 目录级不变量在 `AGENTS.md`。
 *
 * @module tests/client/credentials
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRetryable } from "@/lib/index.js";
import { STATUS_BODY, caught, clientTo, startDouble, type Double } from "./_double.js";

/** 替身生命周期：每个用例自己起、自己关（不与别的用例共享端口或 token） */
let double: Double;

beforeEach(async () => {
  double = await startDouble();
});

afterEach(async () => {
  await double.close();
});

describe("凭据：`Authorization` 逐字是 `Bearer <token>`", () => {
  it("成功路径上服务端收到的那一头逐字对得上", async () => {
    double.route("GET /api/status", { json: STATUS_BODY });
    // 替身默认就要求逐字相等 —— 不匹配它会回 401，于是「成功」本身已经是凭据送达的证据
    const body = await clientTo(double).status();
    expect(body.proxy.running).toBe(true);
    expect(double.seen[0].authorization).toBe(`Bearer ${double.token}`);
  });

  it("**只有**这一种形态能过（大小写 / 少一个空格 / Basic / 无头都必须被拒）", async () => {
    // 替身的判据与真实服务端 `http/auth.ts` 同口径：逐字 `Bearer ` + 不含空白的 token。
    // 这里只锁「客户端发出去的那一头**逐字**是这个形态」——替身只接受它，所以本用例变绿
    // 的唯一路径就是客户端真的发了它。
    double.route("GET /api/status", { json: STATUS_BODY });
    await clientTo(double).status();
    expect(double.seen[0].authorization).toBe(`Bearer ${double.token}`);
    expect(double.seen[0].authorization).not.toBe(`bearer ${double.token}`);
    expect(double.seen[0].authorization).not.toBe(`Bearer${double.token}`);
    expect(double.seen[0].authorization).not.toBe(`Basic ${double.token}`);
    // token 原文后面不许再跟任何东西（多一个字符就是另一个 token）
    expect(double.seen[0].authorization).not.toBe(`Bearer ${double.token} `);
  });

  it("负向样本：替身只接受 `Bearer <token>` 时，其余形态全部 401", async () => {
    // 这一档的价值在于**判据本身也有牙齿**：替身（复刻服务端 `http/auth.ts`）逐字判据若哪天
    // 放宽成「只看有没有 Authorization 头」，下面这六条会一起红。逐个形态单独发，不合并成
    // 「至少有一条被拒」—— 那在判据只拒掉一种形态时也绿。
    double.route("GET /api/status", { json: STATUS_BODY });
    const wrongShapes = [
      `bearer ${double.token}`,
      `Bearer${double.token}`,
      `Bearer  ${double.token}`,
      `Basic ${double.token}`,
      double.token,
      `Bearer ${double.token}x`,
    ];
    for (const shape of wrongShapes) {
      const reply = await fetch(`${double.baseUrl}/api/status`, {
        headers: { Authorization: shape },
      });
      expect(reply.status, `${shape} 不该被接受`).toBe(401);
      await reply.text();
    }
    // 完全没有这个头也一样（那正是 401 的原始形态）
    const bare = await fetch(`${double.baseUrl}/api/status`);
    expect(bare.status).toBe(401);
    await bare.text();
    // 防假绿：上面每一条都必须真的**收到了请求**（否则「401」也可能来自未登记路由的兜底）
    expect(double.seen).toHaveLength(wrongShapes.length + 1);
  });

  it("客户端**确实**发了这个头（替身把判据设成一个不可能对上的值 ⇒ 请求仍会到，只是被拒）", async () => {
    double.route("GET /api/status", { json: STATUS_BODY });
    double.expectAuthorization("Bearer 完全另一个 token");
    const err = await caught(() => clientTo(double).status());
    expect(err.kind).toBe("wire");
    expect(err.code).toBe("unauthorized");
    // 请求到达了（只是被拒）—— 这一条才区分得开「没发头」与「头不对」
    expect(double.seen).toHaveLength(1);
    expect(double.seen[0].authorization).toBe(`Bearer ${double.token}`);
  });
});

describe("鉴权错：`wire` 档，四个字段都要带", () => {
  it("401 + `unauthorized` ⇒ kind/code/status/requestId 逐个对上", async () => {
    double.setUnauthorizedRequestId("r-1");
    double.expectAuthorization("Bearer 完全另一个 token");
    const err = await caught(() => clientTo(double).status());
    expect(err.kind).toBe("wire");
    expect(err.code).toBe("unauthorized");
    expect(err.status).toBe(401);
    expect(err.requestId).toBe("r-1");
    // `request` 是「哪个请求失败」：界面上同时可能有多个 manager 在飞
    expect(err.request).toBe("GET /api/status");
    // wire 档不是重试有意义的那一类
    expect(isRetryable(err)).toBe(false);
  });

  it("服务端回的原样文案不许被改写（传输面不改写对面的话）", async () => {
    double.expectAuthorization("Bearer 完全另一个 token");
    const err = await caught(() => clientTo(double).status());
    expect(err.message).toBe("缺少或错误的 Bearer 凭据");
  });

  it("服务端的其它 4xx 分类逐字透传（409 / 501 / 404 / 405）", async () => {
    const cases: Array<[number, string, string]> = [
      [409, "already-exists", "已经有这个账号了"],
      [501, "read-only-driver", "这份名单驱动没有写面"],
      [404, "not-found", "账号表里没有 bob"],
      [405, "method-not-allowed", "这个端点不接受该方法"],
    ];
    for (const [status, code, message] of cases) {
      double.route("GET /api/status", {
        status,
        json: { error: { code, message, requestId: "r-x" } },
      });
      const err = await caught(() => clientTo(double).status());
      expect(err.kind, `${code} 必须是 wire 档`).toBe("wire");
      expect(err.code, `${code} 必须逐字透传`).toBe(code);
      expect(err.status).toBe(status);
      expect(err.message).toBe(message);
      expect(err.requestId).toBe("r-x");
    }
  });

  it("表外的 code 降级成 `internal` 而 `requestId` 保留（还能接上服务端日志）", async () => {
    double.route("GET /api/status", {
      status: 500,
      json: { error: { code: "brand-new-code", message: "某句中性事实陈述", requestId: "r-77" } },
    });
    const err = await caught(() => clientTo(double).status());
    expect(err.code).toBe("internal");
    expect(err.status).toBe(500);
    expect(err.message).toBe("某句中性事实陈述");
    expect(err.requestId).toBe("r-77");
  });
});
