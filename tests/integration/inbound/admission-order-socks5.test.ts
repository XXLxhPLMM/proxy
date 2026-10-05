/**
 * SOCKS5 入站准入：握手**夹在第 ① 关（名单）与第 ② 关（鉴权）之间**，这是与 HTTP 侧的唯一结构差异。
 *
 * 关卡 ①②③ 的定义与顺序理由、两条准入结构的决策，以及「名单拒那两档必须开着鉴权」这个已实测的
 * 假绿，全部归本目录 `./AGENTS.md` —— 另一份在 HTTP 侧，共用同一份故不复制在这里；
 * 装配面见 `./admission-fixture.js`。
 *
 * @module tests/integration/inbound/admission-order-socks5
 */
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { sleep } from "../../helpers/net.js";
import { makeCollector, rfc1929, socks5ConnectIpv4, tcConnect } from "../../helpers/socks-client.js";
import {
  ACCOUNT,
  authDecided,
  basicAuth,
  startOrigin,
  startProxy,
  stopAll,
  timeline,
  writeAcl,
  type Mark,
} from "./admission-fixture.js";

afterEach(stopAll);

/** SOCKS5：只发 greeting，等代理选定鉴权方法（`05 02` = 选 USER_PASS） */
async function socks5Greeting(port: number): Promise<{ socket: net.Socket; collector: ReturnType<typeof makeCollector> }> {
  const socket = await tcConnect(port);
  const collector = makeCollector(socket);
  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  await collector.waitFor((b) => b.length >= 2);
  return { socket, collector };
}

describe("SOCKS5 入站准入：握手夹在第 ① 与第 ② 关之间（与 HTTP 的唯一结构差异）", () => {
  it("① 名单拒（**开着鉴权**）→ 握手之前就断流：零字节应答 + access 终态，零条鉴权事件", async () => {
    const origin = await startOrigin();
    // 同 HTTP 侧那条：必须开着鉴权，否则身份提供者静默放行、`auth.decided` 根本不出现，
    // 「把名单判定挪到鉴权之后」就测不出来（实测假绿）
    const { port, marks } = await startProxy(
      {
        proxyProtocol: "socks5",
        authEnabled: true,
        aclFile: writeAcl({ clientIp: { blacklist: ["127.0.0.1"] } }),
      },
      { identity: basicAuth() },
    );

    const socket = await tcConnect(port);
    const collector = makeCollector(socket);
    // 客户端照常发 greeting：代理**不应**回任何字节（握手尚未开始就已被拒）
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    const got = await collector.waitClose(1500).catch(() => collector.bytes());
    await sleep(40);
    socket.destroy();

    expect(got.length, "被禁来源不得收到任何握手应答字节").toBe(0);
    expect(timeline(marks)).toEqual(["pipe:ip-denied", "access.client-denied", "request.rejected"]);
    expect(marks.at(-1)?.detail).toBe("access/-");
    expect(authDecided(marks), "握手都没开始，不得进入鉴权").toEqual([]);
    expect(origin.port).toBeGreaterThan(0);
  });

  it("握手应答字节先于鉴权出现（客户端看到 `05 02` 时 `auth.decided` 仍是 0 条）", async () => {
    const { port, marks } = await startProxy({ proxyProtocol: "socks5", authEnabled: true }, { identity: basicAuth() });

    const socket = await tcConnect(port);
    const collector = makeCollector(socket);
    let authMarksWhenSelectArrived: Mark[] = [];
    socket.on("data", () => {
      if (collector.bytes().length >= 2 && authMarksWhenSelectArrived.length === 0 && authDecided(marks).length > 0) {
        authMarksWhenSelectArrived = authDecided(marks);
      }
    });
    socket.write(Buffer.from([0x05, 0x01, 0x02]));
    const select = await collector.waitFor((b) => b.length >= 2);

    // 这一刻就是「握手已推进、鉴权尚未开始」的可观测窗口
    expect([...select.subarray(0, 2)]).toEqual([0x05, 0x02]);
    expect(authDecided(marks), "鉴权必须等握手把凭证载体准备好之后才发生").toEqual([]);
    expect(authMarksWhenSelectArrived).toEqual([]);

    socket.destroy();
  });

  it("② 鉴权拒（RFC1929 错密码）→ 零条 ip-denied、一条 auth.decided(false) + auth 终态", async () => {
    const origin = await startOrigin();
    const { port, marks } = await startProxy({ proxyProtocol: "socks5", authEnabled: true }, { identity: basicAuth() });

    const { socket, collector } = await socks5Greeting(port);
    socket.write(rfc1929(ACCOUNT.username, "wrong"));
    await collector.waitFor((b) => b.length >= 4);
    await sleep(40);
    const bytes = collector.bytes();
    socket.destroy();

    // 代理回 SOCKS 鉴权失败应答（`01 01`），不回 HTTP 407 报文
    expect([...bytes.subarray(2, 4)]).toEqual([0x01, 0x01]);
    expect(timeline(marks)).toEqual(["auth.decided", "request.rejected"]);
    expect(authDecided(marks).map((m) => m.detail)).toEqual([false]);
    expect(marks.at(-1)?.detail).toBe("auth/-");
    expect(origin.port).toBeGreaterThan(0);
  });

  it("③ 目标名单拒 → 鉴权在前、target-denied 在后，CONNECT 应答仍是 SOCKS 二进制（`05 01`）", async () => {
    const origin = await startOrigin();
    const { port, marks } = await startProxy(
      {
        proxyProtocol: "socks5",
        authEnabled: true,
        aclFile: writeAcl({ target: { blacklist: ["127.0.0.1"] } }),
      },
      { identity: basicAuth() },
    );

    const socket = await tcConnect(port);
    const collector = makeCollector(socket);
    socket.write(Buffer.from([0x05, 0x01, 0x02]));
    await collector.waitFor((b) => b.length >= 2);
    socket.write(rfc1929(ACCOUNT.username, ACCOUNT.password));
    await collector.waitFor((b) => b.length >= 4);
    socket.write(socks5ConnectIpv4("127.0.0.1", origin.port));
    await collector.waitFor((b) => b.length >= 10);
    await sleep(40);
    socket.destroy();

    expect(timeline(marks)).toEqual([
      "auth.decided",
      // `pipe:socks` 是会话处理器解析完 CONNECT 包发的那条内部事实（只在 SOCKS 侧有）；
      // 它排在 `target-denied` **之前** = 目标名单仍是在解析出目标之后才判的
      "pipe:socks",
      "pipe:target-denied",
      "access.target-denied",
      "request.rejected",
    ]);
    expect(authDecided(marks).map((m) => m.detail)).toEqual([true]);
    const connectReply = collector.bytes().subarray(4, 10);
    expect(connectReply[0], "SOCKS 应答首字节恒为 0x05（回 HTTP 报文会污染协议）").toBe(0x05);
    expect(connectReply[1], "REP 必须是失败（0x01），不是 0x00").toBe(0x01);
  });

  it("鉴权拒时目标名单根本没被问（SOCKS 侧同样如此）", async () => {
    const origin = await startOrigin();
    const { port, marks } = await startProxy(
      {
        proxyProtocol: "socks5",
        authEnabled: true,
        aclFile: writeAcl({ target: { blacklist: ["127.0.0.1"] } }),
      },
      { identity: basicAuth() },
    );

    const socket = await tcConnect(port);
    const collector = makeCollector(socket);
    socket.write(Buffer.from([0x05, 0x01, 0x02]));
    await collector.waitFor((b) => b.length >= 2);
    socket.write(rfc1929(ACCOUNT.username, "wrong"));
    await sleep(60);
    socket.destroy();

    expect(timeline(marks)).toEqual(["auth.decided", "request.rejected"]);
    expect(timeline(marks)).not.toContain("pipe:target-denied");
    expect(origin.port).toBeGreaterThan(0);
  });
});
