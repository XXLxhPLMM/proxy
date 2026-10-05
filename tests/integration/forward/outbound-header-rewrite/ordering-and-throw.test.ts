/**
 * 这一档钉契约 ④⑤：次序（先剥 → 再改写 → 最后强制 `Connection: close`）/ 钩子抛错不改写且请求照常成功。
 *
 * @module tests/integration/forward/outbound-header-rewrite
 * 六条契约那张表、行为断言的理由与变异实测见 `./AGENTS.md`；装配面（含 `authIdentity` 的取舍）见 `./fixture.js`。
 */
import { describe, expect, it } from "vitest";
import { HttpProxy } from "@/core/server/http.js";
import { withProxy } from "../../../helpers/proxy.js";
import {
  ALICE,
  ALICE_PW,
  REPLY_200,
  absReq,
  authIdentity,
  basicAuth,
  dictOf,
  proxyOpts,
  rawRequest,
  recorder,
  setup,
  startOrigin,
} from "./fixture.js";
describe("outbound-header-rewrite · ④ 次序：先剥 → 再改写 → 最后强制 close", () => {
  /**
   * 锁「钩子看到的是**已净化**的头」（次序的前半）
   *
   * @description 两次请求构成一组**对照**，缺任何一半都不成立：客户端在两次里都发
   * `Proxy-Authorization`（① 必被 `proxy-` 前缀规则剥掉，恒定），而 `Authorization` 一次是
   * **本代理自己签发的那份**（被 `isOwnCredential` 剥掉）、一次是**目标的**（`Bearer …`，必须留）。
   * 只断言「`authorization` 不在入参里」的话，一个「无差别删掉所有 `authorization`」的退化实现
   * 也会全绿，而那会把目标站要的头也吃掉；只断言「`authorization` 在」的话，剥离彻底没跑也会全绿。
   *
   * 身份走**内联账号表**那份（理由见 `authIdentity()` 的注释）：被测的是接线，不是身份族。
   */
  it("钩子入参里没有 proxy-* 头、没有本代理凭证，而目标的 Authorization 原样保留（两次请求对照）", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const rec = recorder();
    const creds = basicAuth(ALICE, ALICE_PW);

    await withProxy(HttpProxy, proxyOpts(rec.rewriter, authIdentity()), async (port) => {
      // ① `Authorization` 是本代理的凭证（basic 档）
      const a = await rawRequest(
        port,
        absReq(origin.port, [`Proxy-Authorization: ${creds}`, `Authorization: ${creds}`]),
      );
      expect(a.status, "凭据认得出来 → 鉴权通过").toBe(200);
      // ② `Authorization` 是目标的 Bearer 令牌（不是本代理的形态）
      const b = await rawRequest(
        port,
        absReq(origin.port, ["Proxy-Authorization: " + creds, "Authorization: Bearer target-secret"]),
      );
      expect(b.status).toBe(200);
    });

    expect(rec.calls, "两次请求各调一次钩子").toHaveLength(2);

    // ① 本代理的凭证：两层规则都已被执行，钩子入参里什么都不该剩
    const own = rec.calls[0].headers;
    expect(Object.keys(own).some((k) => k.startsWith("proxy-")), "入参里不得残留任何 proxy-* 头").toBe(false);
    expect(own.authorization, "本代理自己签发的凭证必须已被剥掉（isOwnCredential 已跑过）").toBeUndefined();
    // 净化已发生：出站净化的另一样品（强制 close）在钩子之前就落好了
    expect(own.connection, "钩子跑在 sanitizeHeaders 之后 → 入参里 connection 已是 close").toBe("close");
    expect(own.host, "Host 回写也已完成 → 插件不必猜这个 Host 是谁写的").toBe(`127.0.0.1:${origin.port}`);

    // ② 目标的凭证：剥离是**按判据**走的，不是「把 authorization 一刀切掉」
    const target = rec.calls[1].headers;
    expect(target.authorization, "目标的 Authorization 不是本代理凭证，必须原样保留").toBe("Bearer target-secret");
    expect(Object.keys(target).some((k) => k.startsWith("proxy-")), "入参里同样不得有 proxy-* 头").toBe(false);

    // 线上那一侧同样逐条对上（不是只有钩子看得见）
    const wire1 = dictOf(origin.requests()[0]);
    const wire2 = dictOf(origin.requests()[1]);
    expect(wire1.authorization, "本代理凭证不许出站（最贵的那条泄漏路径）").toBeUndefined();
    expect(wire1["proxy-authorization"], "客户端的 proxy-* 头不许出站").toBeUndefined();
    expect(wire2.authorization, "目标的凭证必须真的送达源站").toBe("Bearer target-secret");
  });

  /**
   * 锁「钩子对 `connection` 的改动被覆盖掉」（次序的后半）
   *
   * @description `sanitizeHeaders` 里那一次同值写入是**冗余**的：省掉它就等于让钩子开上游
   * keep-alive，而那会与拨号守卫的收尾语义冲突。故真正的牙齿是**改写之后**那次无条件写入——
   * 本条把「改成别的值」与「整个删掉」两种最常见的绕法都试一遍，出站恒为 `close`。
   *
   * ⚠️ 这条**只在 http 通道成立**，Upgrade 通道不强制 close（`Connection: Upgrade` 是 101 的
   * 前提，强制成 close 等于把握手改坏）；所以它是 http 通道的契约，不许被推广到 upgrade 上。
   */
  it("钩子把 connection 改成 keep-alive 或整个删掉，出站都恒为 Connection: close", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    let mode: "keep" | "drop" = "keep";
    const rec = recorder((h) => {
      const next = { ...h };
      if (mode === "keep") {
        next.connection = "keep-alive";
      } else {
        delete next.connection;
      }
      return next;
    });

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      expect((await rawRequest(port, absReq(origin.port))).status).toBe(200);
      mode = "drop";
      expect((await rawRequest(port, absReq(origin.port))).status).toBe(200);
    });

    expect(rec.calls).toHaveLength(2);
    expect(dictOf(origin.requests()[0]).connection, "改成 keep-alive 会被覆盖回 close").toBe("close");
    expect(dictOf(origin.requests()[1]).connection, "整个删掉也会被补回 close").toBe("close");
  });
});

describe("outbound-header-rewrite · ⑤ 钩子抛错 = 不改写且请求照常成功", () => {
  /**
   * 锁「观察面抛错不得反噬协议收尾」
   *
   * @description 判据是**与 ① 的缺席基线逐字节全等** + **状态码 200**：前者钉「返回值被整体丢弃
   * （连同 hook 想改的 UA 与新加的头）」，后者钉「不得变成 5xx」。钩子刻意**不碰入参**（只构造
   * 一份带改动的字典再抛）——理由见 `./AGENTS.md`「四条刻意不给断言的」第 2 条：`catch` 返回的是同一个
   * 引用，就地改动会不会被兜住是一个**尚未裁决**的设计问题，本目录不替它表态。
   */
  it("钩子抛错：出站报文与「完全不注入」的基线逐字节全等，且客户端拿到 200（不是 5xx）", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const req = absReq(origin.port, ["User-Agent: baseline-ua"]);

    // 基线：完全不注入
    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      expect((await rawRequest(port, req)).status).toBe(200);
    });
    const baseline = origin.requests()[0];

    const rec = recorder(() => {
      throw new Error("rewriter blew up");
    });

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      const r = await rawRequest(port, req);
      expect(r.status, "钩子抛错不得把请求变成 5xx").toBe(200);
      expect(r.text, "响应照常送达客户端").toContain("ok");
    });

    expect(rec.calls, "钩子确实被调过（否则这条是假绿）").toHaveLength(1);
    expect(
      origin.requests()[1],
      "抛错时出站报文必须与缺席基线逐字节全等（钩子想加的头 / 想改的值一条都不许生效）",
    ).toBe(baseline);
  });
});
