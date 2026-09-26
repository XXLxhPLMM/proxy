/**
 * **出站凭证判据的接缝护栏**（S0 的安全成果 + 身份可插值化的地基）
 *
 * @description
 * 锁的是一句话：**「代理自己的凭证不得泄漏到目标站点」这条属性，由身份插件自己担保。**
 *
 * ## 来由（为什么这条必须被钉死）
 *
 * 出站剥离的判据**必须**由 `IdentityProvider.isOwnCredential` 给出，**不许**再有一个
 * `helpers/headers.ts:isProxyCredentialValue(value, config)` 从 `authEnabled` / `authType` /
 * `jwtSecret` + users.json 去**猜**「哪个 `Authorization` 是本代理的」。那在「配置即身份
 * 真相源」的世界里成立。身份一旦变成可插值组件，凭证形态
 * 就由**插件**决定（自定义头名、HMAC 摘要、云厂商网关签名…），config 不再是真相源，
 * 继续从 config 猜**必然失配**。
 *
 * 而失配的代价**不是**「剥多了」（目标的 `Authorization: Bearer <token>` 被误剥，最多
 * 让目标站少收一个它要的头），而是反过来——**代理自己的凭证被原样转发给目标站**，等于把
 * 内网口令 / 代理令牌泄露给第三方。故判据改为 `IdentityProvider.isOwnCredential`：
 * 由插件自述、且**必填无缺省**（漏实现编译期红）。
 *
 * 本档五组断言：
 * 1. **自定义 provider 的判据真的被出站剥离调用**（这条是本档的核心，已变异测试验证）
 * 2. `helpers/headers.ts` 源码级零 `@/config/index.js` 导入、零 `config.get`
 * 3. `isProxyCredentialValue` 在 `src/` 全仓零命中
 * 4. `FileAccountIdentity.isOwnCredential` 与 `identify` 同源（`jwtSecret` / `jwtVerify` 只读一份）
 * 5. 内置四个模式插件的判据真值表
 */

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { isStrippableOutboundHeader, sanitizeHeaders, stripProxyHeaders } from "@/core/helpers/index.js";
import {
  FileAccountIdentity,
  basicIdentity,
  createIdentityFromConfig,
  jwtIdentity,
  noneIdentity,
  uidIdentity,
} from "@/core/identity.js";
import type { IdentityProvider } from "@/core/types/identity.js";
import { codeOnly, blockAfter, offendingLines, sourceOf } from "../helpers/source-scan.js";
import { testContext } from "../helpers/config.js";

/** 签发 HS256 JWT（与内置 `verifyHs256Jwt` 共用 node:crypto HMAC，锁的是同一条验签路径） */
function signJwt(
  payload: unknown,
  secret: string,
  header: { alg: string; typ?: string } = { alg: "HS256", typ: "JWT" },
): string {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

// ---------------------------------------------------------------------------
// 1. 自定义 provider 的判据真的被出站剥离调用（本档核心）
// ---------------------------------------------------------------------------

describe("自定义 IdentityProvider 的 isOwnCredential 真的被出站头剥离调用", () => {
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
   * `authorization` 这个头名；本条连**头名**都换掉了，于是它同时覆盖了两件旧实现做不到的事：
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
    // 这条**取代**了 5A 写的那条边界表征（「`x-api-key` 不被剥」）。
    // 那条锁的是**旧实现的一个 bug**：`headers.ts:isStrippableOutboundHeader` 把
    // `lower === "authorization"` 写死之后才委派，于是库层在替插件规定「凭证只能放
    // `authorization` 这个头里」——可 `IdentityProvider.isOwnCredential` 的契约明写凭证
    // 形态（含**自定义头名**）由插件决定。两句话自相矛盾，代价是一个用 `X-Api-Key` 鉴权的
    // 库调用方插件，它的 key 被原样转发给目标站。故那条表征测试已删除，本条是它的**反面**。
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

// ---------------------------------------------------------------------------
// 2. headers.ts 源码级零配置依赖
// ---------------------------------------------------------------------------

describe("core/helpers/headers.ts：零配置读取（判据已搬出本文件）", () => {
  it("零 `@/config/index.js` 导入", () => {
    const code = codeOnly(sourceOf("core", "helpers", "headers.ts"));

    expect(
      offendingLines(code, /@\/config\//),
      "出站头净化不需要知道任何配置项：「凭证长什么样」归身份插件，"
        + "本文件只负责转交。重新引 config 就是「从 config 猜凭证形态」的入口复活",
    ).toEqual([]);
  });

  it("零 `config.get` / 零 `ConfigAccessor`（连类型都不引）", () => {
    const code = codeOnly(sourceOf("core", "helpers", "headers.ts"));

    expect(offendingLines(code, /\.get\s*\(/), "headers.ts 不许读配置").toEqual([]);
    expect(code).not.toContain("ConfigAccessor");
  });

  it("只 type-only 引 `IdentityProvider`（凭证判据的唯一来源，且不产生运行期依赖边）", () => {
    const raw = sourceOf("core", "helpers", "headers.ts");

    expect(raw).toMatch(/import\s+type\s+\{\s*IdentityProvider\s*\}/);
    // 三个薄封装都把 identity 收成必填形参（缺席即忘记注入，不给缺省放行档）
    for (const anchor of [
      "export function isStrippableOutboundHeader(",
      "export function stripProxyHeaders<",
      "export function sanitizeHeaders(",
    ]) {
      expect(raw.slice(raw.indexOf(anchor))).toContain("identity: IdentityProvider");
    }
  });

  it("`isProxyHeaderName` 仍是零依赖纯函数（错误边界在完全没有上下文的场合用它）", () => {
    const code = codeOnly(sourceOf("core", "helpers", "headers.ts"));
    const body = code.slice(code.indexOf("export function isProxyHeaderName("));
    const fn = body.slice(0, body.indexOf("}"));

    // 签名一字不许动：多了参数就会逼错误分类去注入配置或身份插件
    expect(fn).toContain("(name: string): boolean");
    expect(fn).not.toContain("IdentityProvider");
    expect(fn).not.toContain("ConfigAccessor");
  });

  it("源码级：`isStrippableOutboundHeader` 体内零 `authorization` 字面量（头名门禁不许回来）", () => {
    // 行为档（上面那几条）能证明「现在是对的」，这条钉住「**不许再变回去**」——
    // 因为「只问 authorization」这个门禁在功能面并非全错：它对内置四插件完全等价
    // （它们对别的头名本来就恒 false），所以一旦被人以「省掉无谓的委派」为名加回来，
    // 只会红掉「自定义头名插件」那几条。这条负向源码断言是那道防退化的第二道闸。
    const code = codeOnly(sourceOf("core", "helpers", "headers.ts"));
    const fn = blockAfter(code, "export function isStrippableOutboundHeader(");

    expect(fn).not.toContain("authorization");
    // 且协议规则必须**在前**（不许为了「统一」把两条规则并成一条委派）
    expect(fn).toContain("isProxyHeaderName(lower)");
    expect(fn.indexOf("isProxyHeaderName(lower)")).toBeLessThan(fn.indexOf("isOwnCredential"));
  });

  it("源码级：三个薄封装把 `identity` 收成必填形参（判据不许有缺省放行档）", () => {
    // 判据缺席在安全语义上等于「全放行」= 凭证原样转发，故不许有 `?` 也不许有 `??`。
    // 断言只取**形参列表**（锚点到函数体的 `{` 之间）——「往后一直找」会退化成
    // 「文件后面某处出现过这句话」，那时删掉形参也照样通过。
    const code = codeOnly(sourceOf("core", "helpers", "headers.ts"));

    for (const anchor of [
      "export function isStrippableOutboundHeader(",
      "export function stripProxyHeaders<",
      "export function sanitizeHeaders(",
    ]) {
      const at = code.indexOf(anchor);
      expect(at, `源码里找不到锚点 ${anchor}`).toBeGreaterThanOrEqual(0);
      const params = code.slice(at, code.indexOf("{", at));
      expect(params, `${anchor} 不得有可选形参`).toMatch(/identity: IdentityProvider[,)]/);
      expect(params, `${anchor} 不得给判据形参兜底`).not.toMatch(/identity\s*\?\?/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. isProxyCredentialValue 全仓零命中
// ---------------------------------------------------------------------------

describe("isProxyCredentialValue：从 src/ 全仓消失（判据已内化进身份插件）", () => {
  /** 递归列出 src/ 下所有 .ts（与 traffic-ledger 那条零 process.env 扫描同口径） */
  function allSourceFiles(): string[] {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const srcRoot = path.join(__dirname, "..", "..", "src");
    return (fs.readdirSync(srcRoot, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `src/${f.split(path.sep).join("/")}`);
  }

  it("零代码命中：零 `export function`、零 import、零调用", () => {
    const files = allSourceFiles();
    expect(files.length).toBeGreaterThan(30);

    for (const rel of files) {
      const code = codeOnly(sourceOf(...rel.slice("src/".length).split("/")));
      expect(
        offendingLines(code, /isProxyCredentialValue/),
        `${rel} 不得再出现 isProxyCredentialValue：从配置猜「哪个 Authorization 是代理的」`
          + "这条路径在身份可插值后必然失配，代价是代理凭证被转发给目标站",
      ).toEqual([]);
    }
  });

  it("零 `export function isProxyCredentialValue` 声明", () => {
    for (const rel of allSourceFiles()) {
      const code = codeOnly(sourceOf(...rel.slice("src/".length).split("/")));
      expect(code).not.toMatch(/export\s+function\s+isProxyCredentialValue/);
    }
  });

  it("零 `import ... isProxyCredentialValue`", () => {
    for (const rel of allSourceFiles()) {
      const code = codeOnly(sourceOf(...rel.slice("src/".length).split("/")));
      expect(code).not.toMatch(/import\s[^;]*isProxyCredentialValue/);
    }
  });

  it("全仓（含注释）只在**契约注释**里点名，且位置逐条登记", () => {
    // 为什么这条比上面三条更严：上面三条用 `codeOnly` 去掉了注释，所以它们只锁「代码面」。
    // 但**注释面**同样有牙齿：注释是下一个读代码的人的唯一线索，它说「这里有个函数」而代码里
    // 已经没有，会让人去找一个不存在的东西（或者更糟：照着它去实现一个）。
    //
    // 允许点名的只有一类：**「它曾经是 X」这种解释判据来源变迁的契约注释**。
    // 不允许的是把它当**现存 API** 引用（「调 `isProxyCredentialValue(...)`」）。
    // 下面这条例外清单就是本仓当前允许点名的全部位置，逐条写明文件与理由 —— 往里加一行都
    // 必须同时说明「为什么这行注释里出现一个不存在的 API 是必要的」。
    //
    // 注：`src/**/*.md`（AGENTS.md）不在扫描范围内 —— 那里是**历史记录**的正确容身处，
    // 「曾经是」的措辞本来就该留在那里。
    const ALLOWED_MENTIONS: readonly { file: string; reason: string }[] = [
      {
        file: "core/helpers/headers.ts",
        reason:
          "文件头解释「凭证判据不在本文件」这条分层事实时点名了它（判据搬到了 core/identity/）。"
          + "删掉这个名字，下一个人会以为 headers.ts 只是漏实现了判据、于是把它加回来。",
      },
      {
        file: "core/helpers/credentials.ts",
        reason:
          "六处全是「**不再**由本文件派生、旧判据已移走」的方向性说明（模块文件头 + "
          + "`credentialIndexesFor` / `verifyHs256Jwt` 的契约注释）。它们的作用是阻止"
          + "「凭据原语层顺手把配置读取也做了」这条回退。",
      },
      {
        file: "core/types/proxy.ts",
        reason:
          "`IdentityProvider.isOwnCredential` 的契约注释记录判据的来源变迁（从 config 猜 → 插件自述），"
          + "并解释为什么失配的代价是凭证泄漏。**这是最该保留的一处**：自定义身份插件的作者"
          + "只读这一段契约注释。",
      },
      {
        file: "core/identity/file-account.ts",
        reason:
          "`isOwnCredential` 的实现注释记录判据的来源变迁与「密钥两份真相」那个真问题，"
          + "并说明 jwt 分支为何走内置 HS256。删掉它，这条边界会被人当成疏忽去「修」。",
      },
      {
        file: "index.ts",
        reason:
          "库入口的「不留兼容层」清单：明确声明旧名**一律不导出、不加别名**。"
          + "这正是「它是旧 API」这一事实的权威出处。",
      },
    ];

    for (const rel of allSourceFiles()) {
      const raw = sourceOf(...rel.slice("src/".length).split("/"));
      if (!raw.includes("isProxyCredentialValue")) {
        continue;
      }
      const allowed = ALLOWED_MENTIONS.find((a) => rel.endsWith(a.file));
      expect(
        allowed,
        `${rel} 提到了 isProxyCredentialValue，但不在本档的「契约注释」允许清单里。`
          + "要么它是代码（上面三条立刻红），要么它是注释而你刚加的 —— "
          + "请先判断它属于「解释判据来源变迁的契约注释」还是「当现存 API 引用」，"
          + "后者必须改写成不点名的说法。历史记录请写进 src/**/*.md 而不是函数契约注释。",
      ).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. FileAccountIdentity 的判据与识别同源
// ---------------------------------------------------------------------------

describe("FileAccountIdentity：isOwnCredential 与 identify 同源（两份真相 = 凭证泄漏）", () => {
  it("jwtSecret 只读一份：判据与识别用同一个 `this.jwtSecret`", () => {
    // 旧判据读的是 `config.get("jwtSecret")`，而 `Auth` 的验签走**注入的** `this.jwtVerify`
    // ——两条路径读**两份真相**。注入的校验器一旦不用配置里那个 JWT_SECRET（密钥轮换中的
    // 旧密钥、公钥验签），判据就会拿错密钥去验。现在判据读本实例的 `this.jwtSecret`。
    const token = signJwt({ sub: "alice" }, "s3cr3t");
    const id = new FileAccountIdentity({
      enabled: true,
      type: "jwt",
      jwtSecret: "s3cr3t",
      // 注入一个恒真的校验器：识别侧会放行**任何**东西
      jwtVerify: async () => true,
    });

    // 判据只认本实例的密钥签名出来的 token
    expect(id.isOwnCredential("authorization", `Bearer ${token}`)).toBe(true);
    expect(id.isOwnCredential("authorization", `Bearer ${signJwt({ sub: "x" }, "other")}`)).toBe(
      false,
    );
    // 而 `jwtVerify` 注入位只有一处：`createIdentityFromConfig` 的动态代理经它回写
    expect(id.jwtVerify).toBeTypeOf("function");
  });

  it("isEnabled 与识别的早退是同一个开关（消费方只读这一个字段）", () => {
    // 端口口径是「本实例会不会拒绝任何人」，故 `type === "none"` 已并进 `isEnabled`。
    // 若这两处不是同一个事实，症状是「isEnabled 说判人、而识别模板方法放行」。
    const off = new FileAccountIdentity({ enabled: false, type: "basic" });
    const on = new FileAccountIdentity({ enabled: true, type: "basic" });
    const none = new FileAccountIdentity({ enabled: true, type: "none" });

    expect(off.isEnabled).toBe(false);
    expect(on.isEnabled).toBe(true);
    // `AUTH_ENABLED=true` + `AUTH_TYPE=none` 从此只有一个答案
    expect(none.isEnabled).toBe(false);
  });

  it("isOwnCredential 的 `enabled` 门禁与 identify 的早退是同一行（源码级）", () => {
    // 防「判据放行、识别拒绝」或反过来的分叉：两条路径都读 `this.isEnabled`，
    // 而不是各写一份 `enabled && type !== "none"`。
    const code = codeOnly(sourceOf("core", "identity", "file-account.ts"));

    expect(code).toMatch(/isOwnCredential\([^)]*\)\s*:\s*boolean\s*\{\s*if\s*\(\s*!this\.isEnabled\s*\)/);
    // 且全文只有一处 isEnabled 的 getter 定义（不存在「第二个真相」的写法）
    expect((code.match(/get\s+isEnabled\s*\(\)/g) ?? []).length).toBe(1);
  });

  it("FileAccountIdentity 零配置读取（不 import @/config/index.js、零 config.get）", () => {
    const code = codeOnly(sourceOf("core", "identity", "file-account.ts"));

    expect(code).not.toMatch(/@\/config\//);
    expect(offendingLines(code, /\.get\s*\(/)).toEqual([]);
    // 读配置是 `createIdentityFromConfig` 的活（配置驱动的动态门面），不是本类的
    expect(code).not.toContain("loadAuthUsers");
  });

  it("动态门面：isOwnCredential 与 identify 共用同一个 live 闭包（热改配置同步生效）", () => {
    // `createIdentityFromConfig` 每次判定现造一份 FileAccountIdentity 快照，
    // `isOwnCredential` 与 `identify` 都要走那个**同一个** `live()` 闭包。
    // 若两者各读一份，「能过鉴权的凭证没被剥」的老问题就回来了。
    const code = codeOnly(sourceOf("core", "identity", "factory.ts"));
    const live = code.slice(code.indexOf("const live = (): FileAccountIdentity =>"));
    const liveBody = live.slice(0, live.indexOf("});"));

    for (const key of ["authEnabled", "authType", "jwtSecret", "loadAuthUsers"]) {
      expect(liveBody, `live() 闭包必须现读 ${key}`).toContain(key);
    }
    // 判据与识别都经 live()（而不是快照 snap）
    expect(code).toMatch(/isOwnCredential\([^)]*\)\s*:\s*boolean\s*\{\s*return\s+live\(\)\.isOwnCredential/);
    expect(code).toMatch(/async\s+identify\([^)]*\)\s*\{[\s\S]{0,80}return\s+live\(\)\.identify/);
  });

  it("createIdentityFromConfig 的 jwtVerify 注入位透传（动态代理上有同名单的 getter/setter）", () => {
    const code = codeOnly(sourceOf("core", "identity", "factory.ts"));

    expect(code).toMatch(/get\s+jwtVerify\s*\(\)/);
    expect(code).toMatch(/set\s+jwtVerify\s*\(/);
    // 缺省观察面经形参注入（不塞进 CoreContext：那是只读三件套视图，不是订阅注册表）
    expect(code).toContain("onFileEvent");
  });

  it("端口形状本身：isOwnCredential 是必填成员（漏实现编译期红）", () => {
    // 这条是**编译期**断言：`IdentityProvider` 上没有默认实现，替身少写一个成员就红。
    // 上面 apiKeyIdentity / 内置插件都实现了它，缺一个都过不了 typecheck。
    const provider: IdentityProvider = {
      kind: "minimal",
      isEnabled: true,
      isOwnCredential: () => false,
      identify: async () => ({ passed: true }),
    };
    expect(provider.isOwnCredential("authorization", "x")).toBe(false);

    // @ts-expect-error isOwnCredential 是必填：默认实现必然是「恒 false = 永不剥离」，
    // 那正是凭证泄漏的形态，宁可编译期红。
    const missing: IdentityProvider = {
      kind: "incomplete",
      isEnabled: true,
      identify: async () => ({ passed: true }),
    };
    expect(missing).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. 内置四个模式插件的判据真值表
// ---------------------------------------------------------------------------

describe("内置四个模式插件的 isOwnCredential 真值表", () => {
  it("noneIdentity：恒 false（从不校验凭证就没有「自己的凭证」）", () => {
    const none = noneIdentity();

    expect(none.kind).toBe("none");
    expect(none.isEnabled).toBe(false);
    for (const [name, value] of [
      ["authorization", "Basic YWxpY2U6cHcx"],
      ["authorization", "Bearer eyJ..."],
      ["x-api-key", "anything"],
    ] as const) {
      expect(none.isOwnCredential(name, value), `none 对 ${name} 恒不剥离`).toBe(false);
    }
  });

  it("basicIdentity：与**整份**账号表比对（多账号下只比一个 = 其余账号凭证泄漏）", () => {
    const basic = basicIdentity({
      accounts: [
        { username: "alice", password: "pw1" },
        { username: "bob", password: "pw2" },
        { username: "carol", password: "" },
      ],
    });

    // 每个账号都要命中
    for (const [u, p] of [
      ["alice", "pw1"],
      ["bob", "pw2"],
      ["carol", ""],
    ]) {
      expect(basic.isOwnCredential("authorization", `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`)).toBe(
        true,
      );
    }
    // 密码错配 / 不在表内 / 目标的 Bearer 一律不命中
    expect(basic.isOwnCredential("authorization", `Basic ${Buffer.from("alice:pw2").toString("base64")}`)).toBe(
      false,
    );
    expect(basic.isOwnCredential("authorization", `Basic ${Buffer.from("dave:pw").toString("base64")}`)).toBe(
      false,
    );
    expect(basic.isOwnCredential("authorization", "Bearer target-token")).toBe(false);
    // 非 authorization 头名恒 false（`proxy-` 前缀由独立宽规则处理，不归本方法）
    expect(basic.isOwnCredential("Proxy-Authorization", `Basic ${Buffer.from("alice:pw1").toString("base64")}`)).toBe(
      false,
    );
  });

  it("basicIdentity：空账号表恒判否（显式失败，而不是「碰巧没匹配上」）", () => {
    const empty = basicIdentity({ accounts: [] });
    const b64 = Buffer.from("alice:pw1").toString("base64");

    expect(empty.isOwnCredential("authorization", `Basic ${b64}`)).toBe(false);
    expect(empty.isOwnCredential("authorization", b64)).toBe(false);
  });

  it("uidIdentity：四形态都命中，密码不参与判定", () => {
    const uid = uidIdentity({ accounts: [{ username: "test", password: "ignored" }] });
    const b64 = Buffer.from("test:whatever").toString("base64");
    const b64User = Buffer.from("test").toString("base64");

    // 裸用户名 / user:pass / b64(user:pass) / b64(裸用户名)
    for (const token of ["test", "test:whatever", "test:WRONGPASS", b64, b64User]) {
      expect(
        uid.isOwnCredential("authorization", token),
        `uid 四形态之一：${token}`,
      ).toBe(true);
    }
    expect(uid.isOwnCredential("authorization", "nobody")).toBe(false);
    expect(uid.isOwnCredential("authorization", "Bearer target-token")).toBe(false);
  });

  it("uidIdentity：空账号表恒判否", () => {
    const empty = uidIdentity({ accounts: [] });

    expect(empty.isOwnCredential("authorization", "test")).toBe(false);
    expect(empty.isOwnCredential("authorization", Buffer.from("test:pw").toString("base64"))).toBe(
      false,
    );
  });

  it("jwtIdentity：正确密钥的 token 命中（含空账号表）；错密钥/非三段/目标 token 不命中", () => {
    // jwt 允许空账号表：判据走内置 HS256 验签形状判定，不查账号表
    const secret = "proxy-secret";
    const jwt = jwtIdentity({ secret, verify: async () => true });
    const good = signJwt({ sub: "alice" }, secret);
    const wrong = signJwt({ sub: "alice" }, "wrong-secret");

    expect(jwt.isOwnCredential("authorization", `Bearer ${good}`)).toBe(true);
    expect(jwt.isOwnCredential("authorization", good)).toBe(true);
    expect(jwt.isOwnCredential("authorization", `Basic ${good}`)).toBe(true);
    expect(jwt.isOwnCredential("authorization", `Bearer ${wrong}`)).toBe(false);
    expect(jwt.isOwnCredential("authorization", "Bearer a.b")).toBe(false);
    expect(jwt.isOwnCredential("authorization", "Bearer a.b.c")).toBe(false);
    expect(jwt.isOwnCredential("authorization", "Bearer target-token")).toBe(false);
  });

  it("jwtIdentity：判据**不调用**注入的异步 verify（同步判据 await 不了 Promise）", () => {
    // 这是端口形状的账，必须被写下来：注入别的校验器（RS256 / 远端 JWKS）时，
    // 「它放行但内置 HS256 不认」的 token 不会被剥离。方向是「宁可多剥不泄漏」，
    // 不是「绝不误剥」。真要修得让端口另给剥离路径一个**同步**结论（形状变更）。
    let verifyCalls = 0;
    const jwt = jwtIdentity({
      secret: "proxy-secret",
      verify: async () => {
        verifyCalls += 1;
        return true;
      },
    });

    expect(jwt.isOwnCredential("authorization", `Bearer ${signJwt({ sub: "a" }, "proxy-secret")}`)).toBe(
      true,
    );
    expect(verifyCalls, "同步判据绝不许调异步校验器（否则返回值只能是恒 false）").toBe(0);
  });

  it("jwtIdentity：空账号表照样剥离（jwt 分支必须先于空表早退）", () => {
    // 顺序反了的后果：客户端用 `Authorization: Bearer <代理JWT>` 认证时，
    // 该 JWT 会被原样转发给目标站（`extractToken` 的 Authorization 回退正是这么取的）。
    const jwt = jwtIdentity({ secret: "s", verify: async () => true });
    const good = signJwt({ sub: "alice" }, "s");

    expect(jwt.isOwnCredential("authorization", `Bearer ${good}`)).toBe(true);
  });

  it("四个插件的 kind 各自透出（消费方只读 isEnabled，kind 供展示/审计）", () => {
    expect(noneIdentity().kind).toBe("none");
    expect(basicIdentity({ accounts: [] }).kind).toBe("basic");
    expect(uidIdentity({ accounts: [] }).kind).toBe("uid");
    expect(jwtIdentity({ secret: "s", verify: async () => true }).kind).toBe("jwt");
  });

  it("配置驱动的动态门面：空账号表 + authType=basic 时判否，authType=none 时恒判否", () => {
    // 缺省档在 setup-env 里是 AUTH_ENABLED=false，故这里只断言「type=none 一律不剥离」
    // 这条不依赖任何临时状态的事实（配置驱动门面每次现读 live store）。
    const live = createIdentityFromConfig(testContext);

    expect(live.isEnabled).toBe(false);
    expect(live.isOwnCredential("authorization", `Basic ${Buffer.from("alice:pw1").toString("base64")}`)).toBe(
      false,
    );
  });
});
