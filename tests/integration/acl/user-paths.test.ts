/**
 * 这一档管每用户名单（`users.json` 的 `acl`）在**四条转发路径**上的生效，以及 client 模式下
 * 两次 `preDial` 不重复发事件。
 *
 * @module tests/integration/acl
 * 档级不变量（身份链只有一条、为什么必须是真代理 + 真身份 + 真 `users.json`、与 `tests/unit/`
 * 判定层那一半的分工）见 `./AGENTS.md`；装配面见 `./user-acl-fixture.js`。
 */
import { describe, expect, it } from "vitest";
import { HttpProxy } from "@/core/server/http.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import { set } from "../../helpers/config.js";
import { withProxy } from "../../helpers/proxy.js";
import { makeCollector, rfc1929, socks5ConnectIpv4, tcConnect } from "../../helpers/socks-client.js";
import { startUpstreamStub, type UpstreamStub } from "../../helpers/upstream-stub.js";
import {
  ALICE,
  ALICE_PW,
  BOB,
  BOB_PW,
  TARGET_IP,
  accessDenied,
  connectReq,
  origin,
  originHits,
  proxyGet,
  proxyOpts,
  rawBytes,
  rawRequest,
  rawTarget,
  targetDenied,
  upgradeReq,
  upgradeTarget,
  waitUntil,
  watch,
} from "./user-acl-fixture.js";

describe("acl · user-paths（每用户名单在四条转发路径上生效）", () => {
  it("HTTP 普通请求：403 + 恰好一条 target-denied(source=user) + 公共事件仍发布", async () => {
    watch();
    await withProxy(
      HttpProxy,
      proxyOpts(),
      async (port) => {
        expect(await proxyGet(port, origin.port, ALICE, ALICE_PW)).toBe(403);
      },
    );

    // 源站零字节：被拒请求根本不拨号
    expect(originHits()).toBe(0);

    const denied = targetDenied();
    expect(denied, "一次请求只发一条 target-denied").toHaveLength(1);
    expect(denied[0]).toMatchObject({
      type: "target-denied",
      host: TARGET_IP,
      reason: "blacklist",
      source: "user",
      user: ALICE,
    });

    // 公共事件面：reason 仍是闭合集合那一档（不是 "user:blacklist"——那样会是 0 条）
    const access = accessDenied();
    expect(access).toHaveLength(1);
    expect(access[0].data).toMatchObject({ host: TARGET_IP, reason: "blacklist", source: "user" });
    expect(access[0].context.user).toBe(ALICE);
  });

  it("CONNECT：403 + 恰好一条 target-denied(source=user)，目标零字节", async () => {
    watch();
    await withProxy(
      HttpProxy,
      proxyOpts(),
      async (port) => {
        const res = await rawRequest(port, connectReq(rawTarget.port, ALICE, ALICE_PW));
        expect(res.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);
      },
    );

    expect(rawBytes(), "被拒的 CONNECT 绝不建隧").toBe(0);
    const denied = targetDenied();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ source: "user", reason: "blacklist", user: ALICE });
    expect(accessDenied()).toHaveLength(1);
  });

  it("Upgrade：403 + 恰好一条 target-denied(source=user)，目标零字节", async () => {
    watch();
    await withProxy(
      HttpProxy,
      proxyOpts(),
      async (port) => {
        const res = await rawRequest(port, upgradeReq(upgradeTarget.port, ALICE, ALICE_PW));
        expect(res.startsWith("HTTP/1.1 403 Forbidden")).toBe(true);
      },
    );

    const denied = targetDenied();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ source: "user", reason: "blacklist", user: ALICE });
    expect(accessDenied()).toHaveLength(1);
  });

  it("SOCKS5：RFC1929 鉴权后回失败应答（05 01 …）+ 恰好一条 target-denied(source=user)", async () => {
    watch();
    await withProxy(
      Socks5Proxy,
      proxyOpts(),
      async (port) => {
        const sock = await tcConnect(port);
        const c = makeCollector(sock);
        // 宣告 NOAUTH + USERPASS
        sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
        await c.waitFor((b) => b.length >= 2, 3000);
        sock.write(rfc1929(ALICE, ALICE_PW));
        await c.waitFor((b) => b.length >= 4, 3000);
        // 目标 = 回环上的 http 源站：个人名单禁的就是它
        sock.write(socks5ConnectIpv4(TARGET_IP, origin.port));
        await c.waitFor((b) => b.length >= 14, 3000);

        // 累积缓冲里依次是：greeting 方法选择（05 02）、RFC1929 应答（01 00）、CONNECT 应答（10 字节）
        const bytes = c.bytes();
        const reply = bytes.subarray(bytes.length - 10);
        // CONNECT 应答头：VER=05；REP 必须是失败档（`SOCKS5_REPLY_FAILURE` = 05 01 …，成功档是 05 00 …）
        expect(reply[0]).toBe(0x05);
        expect(reply[1]).not.toBe(0x00);
        expect(reply[1]).toBe(0x01);
        sock.destroy();
      },
    );

    expect(originHits(), "被拒的 SOCKS 会话绝不拨号").toBe(0);
    const denied = targetDenied();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ source: "user", reason: "blacklist", user: ALICE });
    expect(accessDenied()).toHaveLength(1);
  });

  it("对照组：同一个代理上 bob（个人白名单圈住该 IP）照样放行（证明拒的是「这个人」）", async () => {
    watch();
    await withProxy(
      HttpProxy,
      proxyOpts(),
      async (port) => {
        expect(await proxyGet(port, origin.port, BOB, BOB_PW)).toBe(200);
        // alice 同一条代理、同一目标：403（两条请求的差别只在身份）
        expect(await proxyGet(port, origin.port, ALICE, ALICE_PW)).toBe(403);
      },
    );

    expect(originHits()).toBe(1);
    const denied = targetDenied();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ user: ALICE, source: "user" });
  });

  it("client 模式 + SOCKS5 上游（两次 preDial）：拒绝时恰好一条事件且上游零建链；放行时零条事件且真建链", async () => {
    set("proxyMode", "client");
    set("upstreamProtocol", "socks5");
    set("upstreamHost", "127.0.0.1");

    // 明文承载：`upstreamProtocol: "socks5"`（不是 `sockss5`），故 secure: false
    const stub: UpstreamStub = await startUpstreamStub("socks5", { secure: false });
    set("upstreamPort", stub.port);

    try {
      watch();
      await withProxy(
        HttpProxy,
        proxyOpts(),
        async (port) => {
          // ① 第一次 preDial 就被个人名单拒 → 恰好一条事件，上游一个字节都没收到
          expect(await proxyGet(port, origin.port, ALICE, ALICE_PW, "/a")).toBe(403);
          expect(stub.connections(), "被拒请求不拨上游").toBe(0);
          expect(targetDenied()).toHaveLength(1);
          expect(targetDenied()[0]).toMatchObject({ source: "user", user: ALICE });

          // ② bob 放行：两次 preDial 都过（第二次判的是传输对端=真实目标）
          expect(await proxyGet(port, origin.port, BOB, BOB_PW, "/b")).toBe(200);
          await waitUntil(() => stub.sessions().length > 0, "上游收到 SOCKS5 会话");
          // 放行路径一条 target-denied 都不许有（两次 preDial 不得重复发事件）
          expect(targetDenied()).toHaveLength(1);
          expect(accessDenied()).toHaveLength(1);
        },
      );

      expect(originHits()).toBe(1);
    } finally {
      await stub.close();
    }
  });
});