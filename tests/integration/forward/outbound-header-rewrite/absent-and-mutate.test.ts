/**
 * 这一档钉契约 ①②③：钩子缺席时出站报文逐字节不变 / 加头（http + upgrade 两条通道）/ 改值与删头。
 *
 * @module tests/integration/forward/outbound-header-rewrite
 * 六条契约那张表、为什么全部用行为断言、变异实测与那处覆盖缺口见 `./AGENTS.md`；装配面见 `./fixture.js`。
 */
import { describe, expect, it } from "vitest";
import { HttpProxy } from "@/core/server/http.js";
import { withProxy } from "../../../helpers/proxy.js";
import {
  REPLY_101,
  REPLY_200,
  absReq,
  dictOf,
  proxyOpts,
  rawRequest,
  recorder,
  setup,
  startOrigin,
  upgradeOnce,
  upgradeReq,
} from "./fixture.js";

describe("outbound-header-rewrite · ① 缺席 = 逐字节不变", () => {
  /**
   * 锁「钩子缺席时出站报文与「完全不注入」的那一份**完全一致**」
   *
   * @description 判据是**两份报文全等**，不是「关键头相等」——后者放过重排、放过大小写、放过
   * 少一个不影响解析的头，而那正是「顺手统一序列化」时最常见的漂移。取等的两侧必须是**同一个
   * 源站端口**（Host 头会回写成 `127.0.0.1:<port>`，端口不同则报文必然不同），故两次跑的是同
   * 一个源站、两次请求逐字节相同。
   */
  it("缺席：出站报文与「注入恒等钩子」的那一份逐字节相同，钩子的有无不许改变任何字节", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const req = absReq(origin.port, ["User-Agent: baseline-ua", "X-Keep-Me: kept"]);

    await withProxy(HttpProxy, proxyOpts(), async (port, proxy) => {
      expect(
        proxy.options.outboundHeaders,
        "缺席时归一值就是 undefined（**不是**一份恒等替身：那会让每请求多一次热路径委派）",
      ).toBeUndefined();
      expect((await rawRequest(port, req)).status).toBe(200);
    });
    const withoutHook = origin.requests();

    const rec = recorder();
    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port, proxy) => {
      expect(proxy.options.outboundHeaders, "注入的那份必须原样透传到归一后的选项上").toBe(rec.rewriter);
      expect((await rawRequest(port, req)).status).toBe(200);
    });
    const withIdentityHook = origin.requests();

    expect(withoutHook, "源站确实收到了请求（排除「压根没转发」那种假绿）").toHaveLength(1);
    expect(withIdentityHook, "恒等钩子也只该产生一份报文").toHaveLength(2);
    expect(
      withIdentityHook[1],
      "恒等钩子（逐字节返回入参）产出的出站报文必须与「完全不注入」的那一份全等",
    ).toBe(withoutHook[0]);

    // 顺带把「缺席时的字节」逐条锁死：它是所有后续用例的基线，漂了就说明出站形态被动过
    const head = withoutHook[0];
    expect(head.split("\r\n")[0], "直连源站 → request-target 归一为 origin-form").toBe("GET /x HTTP/1.1");
    const d = dictOf(head);
    expect(d.host, "客户端的 bogus Host 被回写为真实目标 authority").toBe(`127.0.0.1:${origin.port}`);
    expect(d.connection, "出站强制 close（不变量 2）与钩子无关").toBe("close");
    expect(d["user-agent"], "客户端的头原样透传（缺席 ≠ 少发东西）").toBe("baseline-ua");
    expect(d["x-keep-me"], "自定义头原样透传").toBe("kept");
  });
});

describe("outbound-header-rewrite · ② 加头生效（http + upgrade 两条通道）", () => {
  /** 锁「http 普通转发的出站报文里真的有钩子加的那个键」 */
  it("HTTP 普通转发：钩子新增的头真的出现在源站收到的报文里", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const rec = recorder((h) => ({ ...h, "x-trace-id": "t-1" }));

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      expect((await rawRequest(port, absReq(origin.port))).status).toBe(200);
    });

    expect(rec.calls, "钩子恰好被调一次").toHaveLength(1);
    const d = dictOf(origin.requests()[0]);
    expect(d["x-trace-id"], "钩子加的头必须真的出站（不是只改了入参）").toBe("t-1");
    // 正控：加头不许牵连别的头
    expect(d.host).toBe(`127.0.0.1:${origin.port}`);
    expect(d.connection).toBe("close");
  });

  /**
   * 锁「Upgrade 握手的出站报文里真的有钩子加的那个键」
   *
   * @description 这一条覆盖的是**另一条调用点**（`upgrade.ts:buildUpgradeReq`），它的序列化形态与
   * http 侧刻意不同：钩子缺席走 `rawHeaders` 原样拼串（保留客户端原始头名大小写），钩子在场才切
   * 到「小写字典 → 改写 → 按原名映射回大小写 → 序列化」。所以「钩子加的**新**键」在这条路径上
   * 没有原名可映射，落到线上就是**小写**——断言按小写收，不去猜它该是哪种大小写。
   */
  it("Upgrade 握手：钩子新增的头真的出现在源站收到的握手报文里，且 Connection: Upgrade 仍活着", async () => {
    setup();
    const origin = await startOrigin(REPLY_101);
    const rec = recorder((h) => ({ ...h, "x-ws-tag": "ws-1" }));

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      const text = await upgradeOnce(port, upgradeReq(origin.port));
      expect(text, "101 证明握手报文真送到了源站并被桥接回来").toContain("101");
    });

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].context.channel, "这条走的是 upgrade 通道").toBe("upgrade");
    const head = origin.requests()[0];
    expect(head.split("\r\n")[0], "对端是源站 → request-target 用 origin-form").toBe("GET /ws HTTP/1.1");
    const d = dictOf(head);
    expect(d["x-ws-tag"], "钩子加的头必须真的写进握手报文").toBe("ws-1");
    // 走字典 + 序列化那一路不许把握手必需的头弄丢：`Connection: Upgrade` 是 101 的前提
    expect(d.connection, "改写路径不得毁掉握手必需的 Connection: Upgrade").toBe("Upgrade");
    expect(d.upgrade).toBe("websocket");
    expect(d.host, "Host 按真实目标回写").toBe(`127.0.0.1:${origin.port}`);
  });
});

describe("outbound-header-rewrite · ③ 改值 / 删头生效", () => {
  /**
   * 锁「改值与删头都真的生效」
   *
   * @description **必须带一个未被触碰的正控头**：只断言「改对了 / 删掉了」的话，钩子把整份头换成
   * 一份只含那两个键的字典也会全绿——那不是契约，是「整份替换」被顺手当成了改写。正控头证明的是
   * 「其余头原样带过去」。
   */
  it("HTTP：改值与删头都生效，且未被触碰的头原样带过去（不许被顺手当成整份替换）", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const rec = recorder((h) => {
      // 显式标注成端口的返回类型：否则 `{ ...h, "user-agent": … }` 会被推断成一个**只含该键的字面量
      // 对象类型**，`delete next["x-drop-me"]` 就编译不过（而「删头」正是本条要验的另一半）
      const next: Record<string, string | string[] | undefined> = { ...h, "user-agent": "rewritten-ua" };
      delete next["x-drop-me"];
      return next;
    });

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      expect((await rawRequest(port, absReq(origin.port, ["X-Drop-Me: gone", "X-Keep-Me: kept"]))).status).toBe(
        200,
      );
    });

    const d = dictOf(origin.requests()[0]);
    expect(d["user-agent"], "钩子改的值必须真的出站").toBe("rewritten-ua");
    expect(d["x-drop-me"], "钩子删的头必须真的不出站").toBeUndefined();
    expect(d["x-keep-me"], "正控：未被触碰的头原样带过去（不许整份替换）").toBe("kept");
    expect(d.host, "正控：Host 不受牵连").toBe(`127.0.0.1:${origin.port}`);
    expect(d.connection, "正控：强制 close 不受牵连").toBe("close");
  });
});
