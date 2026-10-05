/**
 * 耗尽行为：配额撞顶 = **硬切**（应答能改就改，改不了就拆连接），每条路径各断言**恰好一条**事件。
 *
 * @description
 * 「为什么不是 403」「恰好一次由 `fired` 闭锁保证（HTTP 两个方向共用同一个）」「不要改成
 * `setImmediate` 延迟 destroy」这三条裁决归 `./AGENTS.md`；本档只钉三条路径各自的硬切形状。
 *
 * @module tests/integration/quota
 */
import { describe, expect, it } from "vitest";
import { accountLocatorFor } from "@/config/index.js";
import { readAuthUsers } from "@/datasource/users/index.js";
import { HttpProxy } from "@/core/server/http.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import { sleep } from "../../helpers/net.js";
import { set, testConfig } from "../../helpers/config.js";
import { blockAfter, codeOf } from "../../helpers/source-scan.js";
import { withProxy } from "../../helpers/proxy.js";
import { makeCollector, rfc1929, socks5ConnectIpv4, tcConnect } from "../../helpers/socks-client.js";
import {
  ALICE,
  ALICE_PW,
  TARGET_IP,
  account,
  exceeded,
  origin,
  pipeEvents,
  proxyOpts,
  proxyRequest,
  raw,
  tunnelPayload,
  upgradeTarget,
  upgradeWithHead,
  writeUsers,
} from "./quota-fixture.js";

describe("quota/exhaustion（耗尽行为：三条路径各硬切一次）", () => {
  it("耗尽①HTTP 转发 · 响应头未发出 → 回 507 Insufficient Storage（不是 403）+ 恰好一条事件", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytes: 100 } }]);
    readAuthUsers({ locator: accountLocatorFor(testConfig), force: true });
    const body = Buffer.alloc(5000, 0x44);

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      const r = await proxyRequest(port, origin.port, ALICE, ALICE_PW, {
        method: "POST",
        path: "/exhaust",
        body,
      });
      // 配额耗尽不是权限问题：403 会诱导客户端换凭证/换身份重试，而重试对「用完了」毫无意义
      expect(r.status).toBe(507);
      expect(r.status).not.toBe(403);
    });

    const events = exceeded();
    expect(events, "一次请求只发一条").toHaveLength(1);
    expect(events[0].data).toEqual({
      user: ALICE,
      dir: "up",
      usage: 5000,
      limit: 100,
    });
    expect(events[0].context.user).toBe(ALICE);
    expect(events[0].context.requestId).toBeTruthy();
  });

  it("耗尽②HTTP 转发 · 响应头已发出 → destroy()（客户端看到中途断流）+ 恰好一条事件", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytes: 100 } }]);
    readAuthUsers({ locator: accountLocatorFor(testConfig), force: true });

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      // 源站会发 200 + content-length: 20000；配额 100B → 第一个响应体 chunk 就撞顶，
      // 此时 `res.writeHead` 早已执行 → 只能 destroy（往已开始的流里追加 507 正文即协议污染）。
      //
      // **状态行是否真的到达客户端不作断言**：Node 的 `res.destroy()` 直接销毁 socket，
      // 尚在 socket 写缓冲里的应答头会一起丢掉，于是客户端可能看到 200、也可能只看到
      // ECONNRESET —— 取决于那一轮是否已经 flush。**两条都是「硬切」的正确表现**，
      // 客户端不能依赖状态行。可断言的硬事实只有一条：**响应体被截断，绝不是一个完整的
      // 200 + 20000B 响应**（那才是「配额没生效」）。
      const r = await proxyRequest(port, origin.port, ALICE, ALICE_PW, { path: "/big?n=20000" });
      expect(r.aborted, "响应体中途被硬切").toBe(true);
      expect(r.got, "拿到的字节远小于 content-length").toBeLessThan(20000);
      expect(r.got === 20000 && r.status === 200, "绝不能是一个完整的 200 响应").toBe(false);
    });

    const events = exceeded();
    expect(events, "一次请求只发一条").toHaveLength(1);
    expect(events[0].data).toEqual({
      user: ALICE,
      dir: "down",
      usage: 20000,
      limit: 100,
    });
  });

  it("耗尽③CONNECT 隧道 → 直接 destroy（应答早已发出，改不了）+ 恰好一条事件", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytes: 100 } }]);
    readAuthUsers({ locator: accountLocatorFor(testConfig), force: true });

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      const payload = Buffer.alloc(8000, 0x45);
      const r = await tunnelPayload(port, raw.port, ALICE, ALICE_PW, payload);
      // 200 已发出（CONNECT 语义要求先回 200），随后传输被硬切：回声远小于请求量
      expect(r.established).toBe(true);
      expect(r.echoed).toBeLessThan(payload.length);
    });

    const events = exceeded();
    expect(events, "一次隧道只发一条").toHaveLength(1);
    // **只有一个合计上限**，故是**上传**那 8000 字节把它撞破的（方向由挂点如实上报）
    expect(events[0].data).toMatchObject({ user: ALICE, dir: "up", limit: 100 });
    expect(events[0].context.user).toBe(ALICE);
  });

  it("耗尽④SOCKS5 隧道 → 同样硬切 + 恰好一条事件", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytes: 100 } }]);
    readAuthUsers({ locator: accountLocatorFor(testConfig), force: true });

    await withProxy(Socks5Proxy, proxyOpts(), async (port) => {
      const sock = await tcConnect(port);
      const c = makeCollector(sock);
      sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      await c.waitFor((b) => b.length >= 2, 3000);
      sock.write(rfc1929(ALICE, ALICE_PW));
      await c.waitFor((b) => b.length >= 4, 3000);
      sock.write(socks5ConnectIpv4(TARGET_IP, raw.port));
      await c.waitFor((b) => b.length >= 14, 3000);
      // 成功应答已发（10 字节），随后传输撞顶 → 连接被 destroy，客户端再也收不到回声
      sock.write(Buffer.alloc(5000, 0x46));
      const got = await c.waitFor((b) => b.length >= 6000, 1200).catch(() => -1);
      expect(got, "SOCKS5 应答之后被硬切，收不到回声").toBe(-1);
      sock.destroy();
    });

    const events = exceeded();
    expect(events, "一次会话只发一条").toHaveLength(1);
    expect(events[0].data).toMatchObject({ user: ALICE, dir: "up", limit: 100 });
  });

  it("耗尽⑤WebSocket Upgrade 的首批载荷（head）→ 硬切：上游零字节 + 恰好一条事件 + **不许补出假的失败事实**", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW, quota: { bytes: 100 } }]);
    readAuthUsers({ locator: accountLocatorFor(testConfig), force: true });
    // 把拨号超时压到 400ms：**修复前** `relay` 会在我们自己销毁的流上继续等，
    // 直到 `upstreamTimeout` 才补出一条「上游响应超时」的假事实（见本例末尾的反向断言）
    set("upstreamTimeout", 400);
    const payload = Buffer.alloc(3000, 0x47); // "G"
    // 桩跨用例存活，按增量断言
    const reqBase = upgradeTarget.requests();
    const payloadBase = upgradeTarget.payloadBytes();

    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      const r = await upgradeWithHead(port, upgradeTarget.port, ALICE, ALICE_PW, payload);
      // 客户端侧：硬切 = 连接被拆掉，**且一个字节都收不到**（101 还没轮到，回 507/502 才是协议污染）
      expect(r.closed, "客户端连接必须被拆掉，不许挂死").toBe(true);
      expect(r.got, "硬切前没有任何应答可写（101 未到、耗尽不是权限问题）").toBe(0);
    });

    // 等过两倍 `upstreamTimeout`：给「修复前那条假事实」留足出现窗口
    await sleep(900);

    // 防假绿：请求必须真的到了上游（否则「上游零字节」是因为压根没建链）
    expect(upgradeTarget.requests() - reqBase, "上游确实收到了 Upgrade 握手").toBe(1);
    expect(
      upgradeTarget.payloadBytes() - payloadBase,
      "耗尽即硬切：客户端首批载荷**一个字节都不许进上游**",
    ).toBe(0);

    // 记账仍照实：被拒的字节**计入已用量**（累计值不截断，见 traffic-account 护栏），
    // 它们只是**没被写出去** —— 「记账」与「放行」是两件事，硬切只否掉后者。
    expect(account.usage(ALICE)).toBe(payload.length);

    const events = exceeded();
    expect(events, "一次 Upgrade 只发一条").toHaveLength(1);
    expect(events[0].data).toEqual({
      user: ALICE,
      dir: "up",
      usage: payload.length,
      limit: 100,
    });
    expect(events[0].context.user).toBe(ALICE);

    // ⚠️ **本条断言才是「判定存在」的可观测证据**：漏判 `allow` 时 `relay` 仍会被调用，
    // `awaitStatusLine` 在**我们自己销毁的**流上等满 `upstreamTimeout` 后补出一条
    // `[upgrade] upstream response timeout` —— 上游是被配额掐死的，不是超时。
    // 运维看到这行会去查上游（而上游根本没问题），`request.failed` 也会凭空多一条。
    // 注：**「上游零字节」这条断言在修复前后都成立**（destroy 先于 write，Node 会丢弃），
    // 所以它锁的是契约、不是判定的存在性；存在性由这条 + 下一条源码级断言一起钉。
    const upstreamErrors = pipeEvents.filter(
      (e) => e.type === "upstream-error" || e.type === "upstream-timeout",
    );
    expect(upstreamErrors.map((e) => e.type), "耗尽不是上游超时/上游错误").toEqual([]);
  });

  it("耗尽⑤的路径归属：upgradeOver 的 head 补记**必须判 allow**（行为断言锁不住是哪条路，故加源码级）", () => {
    // 为什么源码级这条不是重复断言：`head` 路径与 `data` 事件路径在「耗尽」这个场景下
    // **观察结果完全一样**（都拒、都断链、都不写上游），而 TCP 分段是不确定的
    // （客户端一次 `write` 的头与载荷会不会落在同一个 chunk 里不由本测试决定）。
    // 故把「判定就在 head 那一行」钉成源码事实。
    const body = blockAfter(codeOf("core", "forward", "channel", "upgrade.ts"), "private upgradeOver(");
    expect(
      body,
      "upgradeOver 必须判 charge 的 allow（`if (!meter.charge(…).allow) return`），\n"
        + "否则 relay 会在已销毁的流上继续等到 upstreamTimeout，并补出「上游超时」这条假事实。",
    ).toMatch(/!meter\.charge\("up", head\.length\)\.allow/);
  });
});
