/**
 * 自定义 `IdentityProvider` 的判据**真的**被出站头剥离调用
 *
 * @description
 * 这一档钉「代理自己的凭证不得泄漏到目标站点」由身份插件自己担保，而库层对**每个**出站头名
 * × 每个值都问一遍。两个与内置模式都不同的替身插件把这件事顶到极端：`ApiKey <value>`
 * （自定义 scheme）与 `X-Api-Key: k-42`（连**头名**都换掉）。
 *
 * ⚠️ 失配的代价**不是**「剥多了」，而是反过来 —— 代理自己的凭证被原样转发给目标站。
 * 完整论证（不许有头名门禁、两条规则顺序不可换、`headers.ts` 的零配置面、内置四插件的真值表）
 * 归 `AGENTS.md`；那些牙分别在 `../helpers/headers.test.ts`、`no-legacy-helper.test.ts`
 * 与 `own-credential.test.ts`。
 */

import { describe, expect, it } from "vitest";
import { isStrippableOutboundHeader, sanitizeHeaders, stripProxyHeaders } from "@/core/helpers/index.js";
import { basicIdentity } from "@/core/identity.js";
import type { IdentityProvider } from "@/core/types/identity.js";

/**
 * 一个**刻意与任何内置模式都不同**的插件：凭证形态是 `Authorization: ApiKey <value>`
 * ——自定义 scheme（内置的只有 `Basic` / `Bearer` 两种）。
 *
 * 这正是可插值化的价值所在：旧判据 `isProxyCredentialValue(value, config)` **从 config
 * 猜**「哪个 `Authorization` 是本代理的」，它对 `ApiKey` 这种自定义 scheme 只能靠
 * `authType` 白名单去认 —— 一旦凭证形态由插件决定而 config 不再是真相源，必然失配。
 *
 * 本条只换 **scheme**、仍占着 `authorization` 这个头名（最常见的那种自定义形态）；
 * 连**头名**一起换的那一档由下面的 `headerKeyIdentity` 负责。
 */
function apiKeyIdentity(): IdentityProvider & { seen: { name: string; value: string }[] } {
  const seen: { name: string; value: string }[] = [];
  return {
    kind: "apikey",
    isEnabled: true,
    seen,
    isOwnCredential(name, value) {
      seen.push({ name, value });
      // 头名以小写归一后传入（端口契约）；自定义 scheme 与自定义取值都在这里认
      return name === "authorization" && value === "ApiKey secret-key-42";
    },
    async identify() {
      return { passed: true, username: "apikey-user" };
    },
  };
}

/**
 * 一个**用自定义头名鉴权**的插件：凭证形态是 `X-Api-Key: k-42`。
 *
 * 这才是「身份可插值化」的完整形态——上一条 `apiKeyIdentity` 只换了 scheme、仍占着
 * `authorization` 这个头名；本条连**头名**都换掉了，于是它同时覆盖两件事：
 * ① 库层必须**问到 `x-api-key`**（问不到 = 判据形同虚设）；
 * ② 问到了就必须**照答案剥掉**（不剥 = 密钥原样转发给目标站）。
 */
function headerKeyIdentity(): IdentityProvider & { seen: { name: string; value: string }[] } {
  const seen: { name: string; value: string }[] = [];
  return {
    kind: "headerkey",
    isEnabled: true,
    seen,
    isOwnCredential(name, value) {
      seen.push({ name, value });
      return name === "x-api-key" && value === "k-42";
    },
    async identify() {
      return { passed: true, username: "headerkey-user" };
    },
  };
}

describe("自定义 IdentityProvider 的 isOwnCredential 真的被出站头剥离调用", () => {
  it("authorization（目标的 Bearer）保留、代理自己的 ApiKey 凭证被剥", () => {
    const identity = apiKeyIdentity();
    const out = sanitizeHeaders(
      {
        host: "api.example",
        // 目标站自己的 token：绝不能被剥（剥了目标站就少收一个它要的头）
        authorization: "Bearer target-site-token",
        // 代理自己的凭证：必须剥掉，否则等于把内网密钥送给第三方
        authorization2: undefined,
        "x-trace": "keep-me",
      },
      identity,
    );
    expect(out.authorization).toBe("Bearer target-site-token");
    expect(out["x-trace"]).toBe("keep-me");
    expect(out.connection).toBe("close");

    // 同一个头位换成代理自己的凭证形态 → 被剥
    const stripped = sanitizeHeaders({ authorization: "ApiKey secret-key-42" }, identity);
    expect(stripped.authorization).toBeUndefined();
  });

  it("判据**被调用到了**，且拿到的是归一后的头名（不调用的实现与恒 false 无法区分）", () => {
    // 防假绿：`sanitizeHeaders({ authorization: "ApiKey secret-key-42" })` 被剥这件事
    // 本身已经能区分「不调判据」与「调判据」——不调时它会被保留、立刻红。
    // 这里再钉一层「判据确实收到过入参」，把「被调用」从**间接证据**变成**直接证据**，
    // 并且钉住头名是**小写归一后**的（端口契约：调用方先按大小写不敏感归一）。
    const identity = apiKeyIdentity();
    const out = sanitizeHeaders({ Authorization: "ApiKey secret-key-42" }, identity);

    expect(out.Authorization).toBeUndefined();
    expect(identity.seen).toEqual([{ name: "authorization", value: "ApiKey secret-key-42" }]);
  });

  it("多值头取任一命中即整条剥离（多值头里混进了本代理凭证就整条都不能发）", () => {
    const identity = apiKeyIdentity();
    const out = stripProxyHeaders(
      {
        authorization: ["Bearer other", "ApiKey secret-key-42"],
        "x-other": ["a", "b"],
      },
      identity,
    );

    expect(out.authorization).toBeUndefined();
    expect(out["x-other"]).toEqual(["a", "b"]);
  });

  it("isStrippableOutboundHeader 也转交同一个判据（sanitizeHeaders 与 Upgrade 报文共用它）", () => {
    const identity = apiKeyIdentity();

    expect(isStrippableOutboundHeader("Authorization", "ApiKey secret-key-42", identity)).toBe(true);
    expect(isStrippableOutboundHeader("authorization", "ApiKey wrong", identity)).toBe(false);
    expect(isStrippableOutboundHeader("authorization", "Bearer target", identity)).toBe(false);
    // `proxy-` 前缀仍是无条件宽规则，与判据无关
    expect(isStrippableOutboundHeader("Proxy-Foo", "anything", identity)).toBe(true);
  });

  it("自定义头名插件：认哪个头就剥哪个头（认 `x-api-key` → 出站 `x-api-key` 必被剥）", () => {
    // 库层**不得**替插件规定「凭证只能放 `authorization` 这个头里」——
    // `IdentityProvider.isOwnCredential` 的契约明写凭证
    // 形态（含**自定义头名**）由插件决定。两句话自相矛盾，
    // 代价是一个用 `X-Api-Key` 鉴权的
    // 库调用方插件，它的 key 被原样转发给目标站。
    const identity = headerKeyIdentity();
    const out = sanitizeHeaders(
      {
        // 插件认的头 → 必须剥，否则等于把内网密钥送给第三方
        "x-api-key": "k-42",
        // 目标站自己的 token：绝不能被剥（剥了目标站就少收一个它要的头）
        authorization: "Bearer target-site-token",
        // 与凭证无关的头：原样保留
        "x-trace": "keep-me",
      },
      identity,
    );

    expect(out["x-api-key"]).toBeUndefined();
    expect(out.authorization).toBe("Bearer target-site-token");
    expect(out["x-trace"]).toBe("keep-me");
    expect(out.connection).toBe("close");
  });

  it("判据对**每个**出站头都问一遍（不是只问 authorization）——直接证据：头名逐个被问到", () => {
    // 这条是「门禁已删」的**直接证据**（上面那条是间接证据：剥掉了只可能因为问到了）。
    // 判别力在于：只问 `authorization` 的实现根本不会把 `x-other-key` 送进插件，
    // `seen` 里就少这一条 —— 于是「头名白名单」与「每个头都问」只有一种能通过。
    const identity = headerKeyIdentity();
    const out = sanitizeHeaders({ "x-api-key": "k-42", "x-other-key": "k-42" }, identity);

    // 认的被剥、不认的保留：同一个值、换一个头名就换一个答案
    expect(out["x-api-key"]).toBeUndefined();
    expect(out["x-other-key"]).toBe("k-42");
    // 两个头都被问到，且头名是**小写归一后**的（端口契约：调用方先归一）
    expect(identity.seen).toEqual([
      { name: "x-api-key", value: "k-42" },
      { name: "x-other-key", value: "k-42" },
    ]);
    // `isStrippableOutboundHeader` 本身（sanitizeHeaders 与 Upgrade 报文共用它）同样如此
    expect(isStrippableOutboundHeader("x-api-key", "k-42", identity)).toBe(true);
    expect(isStrippableOutboundHeader("x-other-key", "k-42", identity)).toBe(false);
  });

  it("多值自定义头逐个值问：任一命中即整条剥离", () => {
    const identity = headerKeyIdentity();
    const out = stripProxyHeaders({ "x-api-key": ["k-99", "k-42"], "x-trace": ["a", "b"] }, identity);

    expect(out["x-api-key"]).toBeUndefined();
    expect(out["x-trace"]).toEqual(["a", "b"]);
    expect(identity.seen).toEqual([
      { name: "x-api-key", value: "k-99" },
      { name: "x-api-key", value: "k-42" },
      { name: "x-trace", value: "a" },
      { name: "x-trace", value: "b" },
    ]);
  });

  it("`proxy-` 前缀仍是无条件宽规则、且**不问插件**（协议规则与凭证规则是两件事）", () => {
    // 协议规则在前是因为它不依赖插件：`proxy-` 前缀是 HTTP 代理协议自己规定的命名空间
    // （不认得它的请求就不知道它在跟代理说话），与「谁签发了凭证」无关。
    // 把它放在委派之后，就等于让「插件漏实现」有机会把 Proxy-Authorization 放出去。
    const identity = headerKeyIdentity();
    const out = sanitizeHeaders({ "proxy-authorization": "Basic k-42", "proxy-x": "anything" }, identity);

    expect(out["proxy-authorization"]).toBeUndefined();
    expect(out["proxy-x"]).toBeUndefined();
    // 零次委派：这条路径**不经过**身份插件
    expect(identity.seen).toEqual([]);
  });

  it("内置四插件对非 authorization 头名恒 false —— 那是**它们自己的**早退，不是端口的限制", () => {
    // 判别力在最后两行：同一个头名、同一份 headers，换一个插件就换一个答案。
    // 若保留的**原因**是「端口只对 authorization 生效」，那换插件不会改变结果，
    // 最后一行必红。锁的正是「保留的来源是插件的答案」这一条。
    const basic = basicIdentity({ accounts: [{ username: "alice", password: "pw1" }] });

    expect(basic.isOwnCredential("x-api-key", "k-42")).toBe(false);
    // 被问了、答 false、于是保留
    expect(sanitizeHeaders({ "x-api-key": "k-42" }, basic)["x-api-key"]).toBe("k-42");
    // 同一个头名换一个插件 → 同一个库层调用点给出相反答案（证明不是端口在拦）
    expect(sanitizeHeaders({ "x-api-key": "k-42" }, headerKeyIdentity())["x-api-key"]).toBeUndefined();
  });

  it("四个内置插件的判据照样生效（端口化没有把内置形态一起废掉）", () => {
    const basic = basicIdentity({ accounts: [{ username: "alice", password: "pw1" }] });
    const b64 = Buffer.from("alice:pw1").toString("base64");

    expect(basic.isOwnCredential("authorization", `Basic ${b64}`)).toBe(true);
    expect(basic.isOwnCredential("authorization", "Bearer target")).toBe(false);
    // 内置判据对非 authorization 头名恒 false（`proxy-` 前缀由独立宽规则处理）
    expect(basic.isOwnCredential("x-api-key", "secret-key-42")).toBe(false);
  });
});