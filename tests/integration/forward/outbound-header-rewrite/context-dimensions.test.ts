/**
 * 这一档钉契约 ⑥：七个上下文维度逐个传到位 + 同连接共享 `connectionId` / 逐请求独立 `requestId` + `toProxy`。
 *
 * @module tests/integration/forward/outbound-header-rewrite
 * 六条契约那张表与「`protocol` 维度已从端口删掉」的记账见 `./AGENTS.md`；装配面见 `./fixture.js`。
 */
import { describe, expect, it } from "vitest";
import { HttpProxy } from "@/core/server/http.js";
import { set } from "../../../helpers/config.js";
import { withProxy } from "../../../helpers/proxy.js";
import { makeCollector, tcConnect } from "../../../helpers/socks-client.js";
import { startUpstreamStub } from "../../../helpers/upstream-stub.js";
import {
  ALICE,
  ALICE_PW,
  REPLY_200,
  REPLY_200_KEEPALIVE,
  UPSTREAM_ABS_REQ,
  UPSTREAMS,
  absReq,
  authIdentity,
  basicAuth,
  countOf,
  proxyOpts,
  rawRequest,
  recorder,
  setup,
  startOrigin,
} from "./fixture.js";
describe("outbound-header-rewrite · ⑥ 上下文维度", () => {
  /**
   * 锁「七个维度逐个传到位」
   *
   * @description `user` 在**未鉴权**时是 `undefined`（缺席即「没有身份」，不是空串）——见下一条带鉴权的用例。
   *
   * ⚠️ **`client` 断言的是 TCP 对端、不是 XFF 那一档**（本条曾按「XFF 优先」写，实测红）：两个调用点
   * 各自取的是不同形状（准入侧 `getSocketAddress(socket)` vs 事件面 `getClientAddress(req)`），
   * 而**hook 拿到前者、事件面拿到后者**。推导见 `./AGENTS.md`「四条刻意不给断言的」第 4 条。
   */
  it("http 通道：channel/toProxy/target/client 与两个 id 全部传到位（未鉴权时 user 缺席）", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const rec = recorder();

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      expect((await rawRequest(port, absReq(origin.port, ["X-Forwarded-For: 203.0.113.9"]))).status).toBe(200);
    });

    expect(rec.calls).toHaveLength(1);
    const ctx = rec.calls[0].context;
    expect(ctx.channel, "走的是哪条通道（落盘日志文本契约的字面量）").toBe("http");
    expect(ctx.toProxy, "对端是源站（直连）→ 不是代理").toBe(false);
    expect(ctx.target, "真实目标 authority，与 Host 回写同源").toBe(`127.0.0.1:${origin.port}`);
    // 客户端**显式发了 XFF**，而 `client` 维度仍是对端：它取的是 terminal 那份（TCP 对端），
    // 不是 `eventContext.client` 用的 `getClientAddress` 那一档。差异记在那条用例的注释里。
    expect(ctx.client, "TCP 对端（terminal 那份口径），刻意不受客户端自报的 XFF 影响").toBe("127.0.0.1");
    expect(typeof ctx.requestId, "requestId 必须传到位").toBe("string");
    expect(ctx.requestId, "requestId 非空").toBeTruthy();
    expect(typeof ctx.connectionId, "connectionId 必须传到位").toBe("string");
    expect(ctx.connectionId, "connectionId 非空").toBeTruthy();
    expect(ctx.requestId, "两个 id 是各自独立的维度，不许取同一个值").not.toBe(ctx.connectionId);
    expect(ctx.user, "未鉴权 → 没有身份维度（缺席即 undefined，不是空串）").toBeUndefined();
  });

  /**
   * 锁「鉴权通过时 `user` 维度等于账号名」
   *
   * @description 单独一条而不是并进上面那条：`user` 既是**可空维度**又要在**有值时精确**，
   * 一条用例同时断两半会让人分不清是哪半坏了。这里走**内联账号表**的 basic 身份（理由与取舍见
   * `authIdentity()` 的注释）：被测的是 `RequestScope.user → context.user` 这条接线，身份族与账号表
   * 来源与之无关，故不引入「临时 users.json + 1s 节流强制重读」那套更重的装配。
   */
  it("启鉴权后 user 维度等于账号名（basic 账号表经 Proxy-Authorization 鉴权通过）", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const rec = recorder();

    await withProxy(HttpProxy, proxyOpts(rec.rewriter, authIdentity()), async (port) => {
      const r = await rawRequest(
        port,
        absReq(origin.port, [`Proxy-Authorization: ${basicAuth(ALICE, ALICE_PW)}`]),
      );
      expect(r.status, "凭据认得出来 → 鉴权通过").toBe(200);
    });

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].context.user, "已鉴权用户名必须传到钩子上下文里").toBe(ALICE);
  });

  /**
   * 锁「`requestId` 逐请求独立、`connectionId` 按连接共享」
   *
   * @description 只断言「两个 id 都是非空字符串」的话，任何一个维度取错（两个都现算、两个都按连接
   * 缓存）都会全绿。故这条走**入站 keep-alive 的同一条 TCP 连接**连发两个请求：源站应答刻意带
   * `Connection: keep-alive`（否则代理回完就断链，两个请求会落在两条连接上，这条就白测了），
   * 然后断「同连接共享 connectionId」与「逐请求独立 requestId」两半。
   */
  it("同一入站连接上连发两个请求：connectionId 共享、requestId 各自独立", async () => {
    setup();
    const origin = await startOrigin(REPLY_200_KEEPALIVE);
    const rec = recorder();
    const req = absReq(origin.port);

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      const sock = await tcConnect(port);
      const c = makeCollector(sock);
      try {
        sock.write(req);
        await c.waitFor((b) => countOf(b.toString("latin1"), "\r\n\r\nok") >= 1, 5000);
        sock.write(req);
        await c.waitFor((b) => countOf(b.toString("latin1"), "\r\n\r\nok") >= 2, 5000);
      } finally {
        sock.destroy();
      }
    });

    expect(rec.calls, "两个请求各调一次钩子").toHaveLength(2);
    expect(origin.requests(), "两个请求都真的出站了").toHaveLength(2);
    expect(
      rec.calls[1].context.connectionId,
      "同一条入站 TCP 连接共享 connectionId（它取的是 socket 维度）",
    ).toBe(rec.calls[0].context.connectionId);
    expect(rec.calls[1].context.requestId, "requestId 是逐请求独立的").not.toBe(rec.calls[0].context.requestId);
  });

  /**
   * 锁「`toProxy` 在对端是代理时为 true，且上游凭证在钩子跑之前已注入」
   *
   * @description 这一档走 `client 模式 + http 上游`，用的是 `tests/helpers/upstream-stub.ts` 那份
   * 可观测上游桩（明文承载，3 角色 × 2 承载里取 https 角色的 plain 档：它逐字记下请求行与
   * `Proxy-Authorization`）。与上面几条「直连源站」档的区别正是 `toProxy` 这个维度，而它必须由
   * 连接器**声明**（`targetForm === "absolute"`）——插件要动 `host` 或凭证头时得先看它，绝不许
   * 从别处推。正控是同一次调用里的另外两条：Host **原样保留**（对端是代理，不做 §5.4 回写）、
   * 上游 Basic 凭证**已注入**（钩子不必自己算它该带什么）。
   */
  it("client 模式经 http 上游：toProxy 为 true，Host 原样保留且上游凭证在钩子跑之前已注入", async () => {
    setup();
    const upstream = await startUpstreamStub("https", { secure: false });
    UPSTREAMS.push(upstream);
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", upstream.port);
    set("upstreamUsername", "up-user");
    set("upstreamPassword", "up-pass");
    const rec = recorder();

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      expect((await rawRequest(port, UPSTREAM_ABS_REQ)).status).toBe(200);
    });

    expect(rec.calls).toHaveLength(1);
    const ctx = rec.calls[0].context;
    expect(ctx.toProxy, "对端是 http 上游（targetForm === absolute）→ toProxy 为 true").toBe(true);
    expect(ctx.target, "target 是客户端请求的目标（不是上游地址）").toBe("127.0.0.1:8080");
    expect(rec.calls[0].headers.host, "对端是代理 → 客户端 Host 原样保留（不按 §5.4 回写）").toBe(
      "client-host.example",
    );
    expect(
      rec.calls[0].headers["proxy-authorization"],
      "上游凭证在改写**之前**已注入，插件不必猜该不该带、带什么",
    ).toBe(basicAuth("up-user", "up-pass"));

    // 上游那一侧：absolute-form 请求行 + 同样的凭证（源站桩逐字记的，证明改写链路上游照样通）
    const facts = upstream.last();
    expect(facts, "上游确实被拨到了（排除假绿）").toBeDefined();
    expect(facts?.requestLine, "对端是代理 → request-target 保留客户端的 absolute-form").toBe(
      "GET http://127.0.0.1:8080/x HTTP/1.1",
    );
    expect(facts?.proxyAuthorization, "上游确实收到了注入的 Basic 凭证").toBe(basicAuth("up-user", "up-pass"));
  });
});
