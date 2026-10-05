/**
 * `core/helpers/headers.ts`：零配置读取 + 出站凭证剥离 + 内置 HS256 同步验签
 *
 * @description
 * 这一档两个 describe 各钉一个不相干的面：①「零配置读取」那组是源码级判据，它读的是
 * `headers.ts`（**别的文件**），故那一组的判据面在别处；②「出站凭证剥离与内置 HS256 同步验签」
 * 那组是本文件自己的行为面 —— 判据从「从 config 猜」搬到「插件自述」之后行为一条没删，
 * 只是**判据的来源**换了。
 *
 * ⚠️ **零配置面为什么住在这一档、而不是 `core/identity/` 那几档旁边**：判据归属是这一族的主论断，
 * 而 `headers.ts` 的零配置面是它的**同一件事的两半**（判据不在本文件 ⇒ 本文件不需要知道任何
 * 配置项）。反向的自定义插件行为档在 `../identity/credential-seam.test.ts` —— 那一档钉「库层
 * 问到每个头」，这一档钉「库层对配置一无所知」。逐条判据与变异表见 `AGENTS.md`。
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import {
  encodeBasicCredentials,
  isJwtShape,
  isStrippableOutboundHeader,
  sanitizeHeaders,
  verifyHs256Jwt,
} from "@/core/helpers/index.js";
import { createIdentityFromConfig } from "@/core/identity.js";
import { blockAfter, codeOnly, offendingLines, sourceOf } from "../../../helpers/source-scan.js";
import { set, testContext, restoreConfig, snapshotConfig } from "../../../helpers/config.js";

/** 签发 HS256 JWT（测试用最小签发器，与内置校验器 verifyHs256Jwt 共用 node:crypto HMAC） */
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
// 1. headers.ts 源码级零配置依赖
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
    // 行为档（下面那几条）能证明「现在是对的」，这条钉住「**不许再变回去**」——
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
// 2. 判据改成「插件自述」之后，行为一条没删
// ---------------------------------------------------------------------------

describe("core/helpers/headers.ts：出站凭证剥离与内置 HS256 同步验签", () => {
  it("sanitizeHeaders 剥离命中代理凭证的 Authorization，其余原样保留", () => {
    // 账号表改由 AUTH_USERS_FILE 指向的 users.json 承载（多账号），需临时造一份
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-helpers-users-"));
    const usersFile = path.join(dir, "users.json");
    fs.writeFileSync(
      usersFile,
      JSON.stringify([
        { username: "alice", password: "pw1" },
        { username: "bob", password: "pw2" },
      ]),
    );
    const prev = snapshotConfig(["authEnabled", "authType", "authUsersFile"]);
    try {
      set("authEnabled", true);
      set("authType", "basic");
      set("authUsersFile", usersFile);

      const identity = createIdentityFromConfig(testContext);
      const aliceB64 = encodeBasicCredentials("alice", "pw1");
      const bobB64 = encodeBasicCredentials("bob", "pw2");

      // 判据从「helpers/headers.ts:isProxyCredentialValue(value, config) 从配置猜」搬到
      // 「IdentityProvider.isOwnCredential(name, value) 由插件自述」。断言一条没删，只是
      // **判据的来源**从 config 换成了身份插件 —— 判据逻辑本身（basic 与整份账号表比对）
      // 必须逐字保持，否则就是「改锚点顺手把不变量也改了」。
      // 多账号：每个账号的 Basic 凭证都必须被识别为代理自身凭证（只比对一个会泄漏其余账号）
      expect(identity.isOwnCredential("authorization", `Basic ${aliceB64}`)).toBe(true);
      expect(identity.isOwnCredential("authorization", `Basic ${bobB64}`)).toBe(true);
      expect(
        identity.isOwnCredential(
          "authorization",
          `Basic ${Buffer.from("carol:pw3").toString("base64")}`,
        ),
      ).toBe(false);
      expect(identity.isOwnCredential("authorization", "Bearer target-token")).toBe(false);

      expect(
        sanitizeHeaders({ host: "a.com", authorization: `Basic ${aliceB64}` }, identity)
          .authorization,
      ).toBeUndefined();
      expect(
        sanitizeHeaders({ host: "a.com", authorization: `Basic ${bobB64}` }, identity)
          .authorization,
      ).toBeUndefined();
      expect(
        sanitizeHeaders({ host: "a.com", authorization: "Bearer target-token" }, identity)
          .authorization,
      ).toBe("Bearer target-token");
    } finally {
      restoreConfig(prev);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("jwt 模式剥离：正确密钥的代理 JWT 视为代理凭证，错密钥/非三段/目标 token 保留", () => {
    // jwt 模式允许空账号表：把 AUTH_USERS_FILE 指向不存在的文件，验证剥离判据不依赖账号表
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-helpers-jwt-"));
    const prev = snapshotConfig(["authEnabled", "authType", "jwtSecret", "authUsersFile"]);
    try {
      set("authEnabled", true);
      set("authType", "jwt");
      set("jwtSecret", "proxy-secret");
      set("authUsersFile", path.join(dir, "missing.json"));

      const identity = createIdentityFromConfig(testContext);
      const jwt = signJwt({ sub: "alice" }, "proxy-secret");
      const wrong = signJwt({ sub: "alice" }, "wrong-secret");

      // 命中：Bearer / 裸 JWT / 其他 scheme 前缀（身份侧同样剥 scheme 后验签）；空表也照样剥离
      expect(identity.isOwnCredential("authorization", `Bearer ${jwt}`)).toBe(true);
      expect(identity.isOwnCredential("authorization", jwt)).toBe(true);
      expect(identity.isOwnCredential("authorization", `Basic ${jwt}`)).toBe(true);
      // 未命中：错密钥 / 非三段 / 三段但非合法 JWT / 目标站自己的 Bearer token
      expect(identity.isOwnCredential("authorization", `Bearer ${wrong}`)).toBe(false);
      expect(identity.isOwnCredential("authorization", "Bearer a.b")).toBe(false);
      expect(identity.isOwnCredential("authorization", "Bearer a.b.c")).toBe(false);
      expect(identity.isOwnCredential("authorization", "Bearer target-token")).toBe(false);

      // sanitizeHeaders：命中的 Authorization 剥掉，未命中的原样保留
      expect(
        sanitizeHeaders({ host: "a.com", authorization: `Bearer ${jwt}` }, identity).authorization,
      ).toBeUndefined();
      expect(
        sanitizeHeaders({ host: "a.com", authorization: `Bearer ${wrong}` }, identity)
          .authorization,
      ).toBe(`Bearer ${wrong}`);
      expect(
        sanitizeHeaders({ host: "a.com", authorization: "Bearer target-token" }, identity)
          .authorization,
      ).toBe("Bearer target-token");
      // Proxy-Authorization 始终剥离（任意 proxy- 前缀），与 jwt 判据无关
      expect(
        isStrippableOutboundHeader("Proxy-Authorization", `Bearer ${wrong}`, identity),
      ).toBe(true);
      expect(
        sanitizeHeaders({ host: "a.com", "proxy-authorization": `Bearer ${wrong}` }, identity)[
          "proxy-authorization"
        ],
      ).toBeUndefined();
    } finally {
      restoreConfig(prev);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isJwtShape / verifyHs256Jwt：形状判定与 HS256 同步验签（fail-closed、永不抛）", () => {
    const now = Math.floor(Date.now() / 1000);
    // 形状：恰三段
    expect(isJwtShape("a.b.c")).toBe(true);
    expect(isJwtShape("a.b")).toBe(false);
    expect(isJwtShape("abc")).toBe(false);
    expect(isJwtShape("a.b.c.d")).toBe(false);
    // 同步验签：签名正确且未过期放行（无 exp 也放行）
    const good = signJwt({ sub: "alice" }, "s3cr3t");
    expect(verifyHs256Jwt(good, "s3cr3t")).toBe(true);
    expect(verifyHs256Jwt(signJwt({ sub: "alice", exp: now + 60 }, "s3cr3t"), "s3cr3t")).toBe(true);
    // 空密钥 / 错密钥 / 签名篡改 / 过期 / 非有限 exp 一律拒绝
    expect(verifyHs256Jwt(good, "")).toBe(false);
    expect(verifyHs256Jwt(good, "other")).toBe(false);
    expect(verifyHs256Jwt(`${good}x`, "s3cr3t")).toBe(false);
    expect(verifyHs256Jwt(signJwt({ sub: "alice", exp: now - 60 }, "s3cr3t"), "s3cr3t")).toBe(
      false,
    );
    expect(verifyHs256Jwt(signJwt({ sub: "alice", exp: "soon" }, "s3cr3t"), "s3cr3t")).toBe(false);
    // 错算法 / 载荷非对象 / 垃圾字节 → false 且永不抛出
    expect(verifyHs256Jwt(signJwt({ sub: "alice" }, "s3cr3t", { alg: "RS256" }), "s3cr3t")).toBe(
      false,
    );
    expect(verifyHs256Jwt(signJwt("just-a-string", "s3cr3t"), "s3cr3t")).toBe(false);
    expect(verifyHs256Jwt("!!!.???.###", "s3cr3t")).toBe(false);
    expect(() => verifyHs256Jwt("a..b", "s3cr3t")).not.toThrow();
  });
});