/**
 * 凭证向量解析与 tag 语义：scheme 大小写、空用户名索引、审计事件字段、`tag`
 *
 * @description
 * 这一档答「载体怎么被读成 token」与「审计事件带哪几个字段」。⚠️ `authority` 里那两处
 * `example.com:*` 是**申报过的**公网字面量（只进审计事件的 `target`，本档不建链）。
 *
 * ⚠️ jwt 分支在 `verify.test.ts`、`enabled`/`basic`/`uid` 的判定真值表在
 * `file-account.test.ts`；拆开即假绿的理由见 `AGENTS.md`。
 */

import { describe, expect, it } from "vitest";
import { FileAccountIdentity, createIdentity } from "@/core/identity.js";
import type { ProxyAuthEvent } from "@/core/types/proxy.js";
import { testConfig } from "../../../helpers/config.js";
import { acct, b64, ctxWith } from "./_identity.js";

describe("identity/FileAccountIdentity：凭证向量解析与 tag 语义", () => {
  it("createIdentity 工厂可用", async () => {
    const p = createIdentity({ enabled: false }, testConfig);
    expect((await p.identify(ctxWith({}))).passed).toBe(true);
  });

  it("scheme 大小写不敏感（RFC 7235）：basic/bearer 小写前缀同样剥离", async () => {
    const basic = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [acct("user", "pass")],
      enableLogging: false,
    });
    const token = b64("user:pass");
    expect(
      (await basic.identify(ctxWith({ headers: { "proxy-authorization": `basic ${token}` } })))
        .passed,
    ).toBe(true);
    expect(
      (await basic.identify(ctxWith({ headers: { "proxy-authorization": `BASIC ${token}` } })))
        .passed,
    ).toBe(true);

    const jwt = new FileAccountIdentity({
      enabled: true,
      type: "jwt",
      jwtSecret: "s",
      jwtVerify: async (t) => t === "abc",
      enableLogging: false,
    });
    expect(
      (await jwt.identify(ctxWith({ headers: { authorization: "bearer abc" } }))).passed,
    ).toBe(true);
  });

  it("空用户名账号不入索引：':','Og==','a','!' 等无意义向量一律拒绝", async () => {
    // 空用户名配置在 loader 层已被拦截；此处验证身份门面侧的纵深防御：
    // 空用户名账号被跳过后索引为空，任何 token 都不可能命中
    const basic = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [acct("", "")],
      enableLogging: false,
    });
    for (const token of [":", "Og==", "a", "!"]) {
      expect(
        (await basic.identify(ctxWith({ headers: { "proxy-authorization": token } }))).passed,
      ).toBe(false);
    }

    const uid = new FileAccountIdentity({
      enabled: true,
      type: "uid",
      accounts: [acct("", "")],
      enableLogging: false,
    });
    for (const token of [":", "Og==", "a", "!"]) {
      expect(
        (await uid.identify(ctxWith({ headers: { "proxy-authorization": token } }))).passed,
      ).toBe(false);
    }

    // 空账号表同理：basic 一律拒（loader 会阻止这种配置启动）
    const empty = new FileAccountIdentity({ enabled: true, type: "basic", accounts: [], enableLogging: false });
    expect(
      (await empty.identify(ctxWith({ headers: { "proxy-authorization": "u:p" } }))).passed,
    ).toBe(false);
  });

  it("审计事件带 attempted（deny）/ user（allow），且不再有 expected", async () => {
    const events: ProxyAuthEvent[] = [];
    const id = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [acct("alice", "pw1")],
      enableLogging: true,
    });
    const onAuthEvent = (e: ProxyAuthEvent): void => {
      events.push(e);
    };

    await id.identify(
      ctxWith({ headers: { "proxy-authorization": b64("mallory:pw") }, onAuthEvent }),
    );
    expect(events[0].passed).toBe(false);
    expect(events[0].attempted).toBe("mallory");
    expect(events[0].user).toBeUndefined();
    expect("expected" in events[0]).toBe(false);

    await id.identify(
      ctxWith({ headers: { "proxy-authorization": b64("alice:pw1") }, onAuthEvent }),
    );
    expect(events[1].passed).toBe(true);
    expect(events[1].user).toBe("alice");
  });

  it("tag 语义：仅 CONNECT 方法与 socks* 协议标 tunnel，普通带端口 Host 不误标", async () => {
    const id = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [acct("u", "p")],
      enableLogging: true,
    });
    const tags: string[] = [];
    const onAuthEvent = (e: ProxyAuthEvent): void => {
      tags.push(e.tag);
    };
    // 普通请求：Host 带端口（authority 含 ":"）不得标 tunnel
    await id.identify(ctxWith({ method: "GET", authority: "example.com:8080", onAuthEvent }));
    // CONNECT 隧道
    await id.identify(
      ctxWith({ method: "CONNECT", authority: "example.com:443", onAuthEvent }),
    );
    // socks* 协议
    await id.identify(
      ctxWith({ method: "GET", protocol: "socks5", authority: "socks5", onAuthEvent }),
    );
    expect(tags).toEqual(["", "tunnel", "tunnel"]);
  });
});