/**
 * @fileoverview 凭证原语：账号表 → 索引的编译与比对、Basic 令牌解析、HS256 验签
 * @module core/helpers/credentials
 * @description
 * 鉴权（`core/auth.ts`）与出站凭证剥离（`headers.ts:isProxyCredentialValue`）共用的
 * **纯**判据源，两侧都必须走同一实现，否则两处验签/比对逻辑会漂移。
 *
 * 职责：
 * - 索引：`buildCredentialIndexes` / `credentialIndexesFor`（模块级单槽记忆）/
 *   `matchBasicCredential` / `matchUidCredential` / `extractBasicUser` / `encodeBasicCredentials`
 * - 头值拼装：`buildProxyAuthValue`（scheme 前缀 + base64 载荷 → 完整 `Proxy-Authorization`
 *   值；原在 `utils/constants`，因那里必须保持「零函数纯值」而迁来）
 * - 令牌形态：`isJwtShape`（三段式形状，不验签）
 * - 验签：`verifyHs256Jwt`（内置 HS256，同步、永不抛）
 *
 * 不负责（**本文件的不变量**：零 `ConfigAccessor`、零文件 IO、零日志）：
 * - 不读 `jwtSecret` / `authType` / `authEnabled`——判据入参一律由调用方传入
 * - 不调 `loadAuthUsers`；因此**读配置的凭证谓词 `isProxyCredentialValue` 刻意留在
 *   `headers.ts`**，不能挪到这里：它必须读配置并触达 users 文件热加载，挪进来就破了本
 *   目录「纯原语」的分层。纯原语与读配置的谓词因此是两个文件、两条生命周期。
 * - 不发事件、不做协议应答、不做目标解析
 *
 * 依赖：`node:crypto` + `@/utils/constants/index.js` + `@/core/types/proxy.js`（仅类型）。
 * 本文件是 `helpers/` 的叶子，不引任何同目录模块。
 *
 * 使用示例（跨目录引用一律走 `helpers/` 的 barrel，不引层内深路径）：
 * ```ts
 * import { credentialIndexesFor, matchBasicCredential } from "@/core/helpers/index.js";
 *
 * const indexes = credentialIndexesFor(accounts);
 * const user = matchBasicCredential("dXNlcjpwYXNz", indexes);
 * ```
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { AUTH_SCHEME_BASIC, RE_BASE64_STRICT } from "@/utils/constants/index.js";
import type { AuthAccount } from "@/core/types/proxy.js";

/**
 * 凭证索引（`Auth` 与 `isProxyCredentialValue` 共用的唯一判据源）
 * @description
 * 判据收口在此一处，`core/auth.ts` 只做薄委托（`auth → helpers/credentials` 单向，无循环）：
 * - `basic` 键：`b64(user:pass)` 与明文 `user:pass` 整串精确比对
 * - `uidUsers` 集：只比用户名（密码忽略），裸用户名 / `user:pass` / `b64(user:pass)` / `b64(username)` 四形态
 * - 空用户名跳过（纵深防御，避免 `:` / `Og==` 命中无账号伪凭证）
 * - jwt 不建索引：`isProxyCredentialValue` 直接按 `verifyHs256Jwt` 验签（不依赖账号表）
 */
export interface ProxyCredentialIndexes {
  /** Basic 键：`b64(user:pass)` 与明文 `user:pass`（整串精确比对） */
  basic: Map<string, string>;
  /** UID 用户名集合（只比对用户名部分，密码忽略） */
  uidUsers: Set<string>;
}

/**
 * 编译账号表为凭证索引（纯函数，每次新建；按快照身份记忆复用见 `credentialIndexesFor`）
 * @param accounts - 账号表（来自 users.json，视为只读）
 * @returns basic/uid 两套索引
 */
export function buildCredentialIndexes(accounts: readonly AuthAccount[]): ProxyCredentialIndexes {
  const basic = new Map<string, string>();
  const uidUsers = new Set<string>();
  for (const a of accounts) {
    // 空用户名账号在解析期已被拒（纵深防御：此处再挡一次，避免 `:` / `Og==` 之类空凭证命中）
    if (!a.username) {
      continue;
    }
    basic.set(encodeBasicCredentials(a.username, a.password), a.username);
    basic.set(`${a.username}:${a.password}`, a.username);
    uidUsers.add(a.username);
  }
  return { basic, uidUsers };
}

/** 单槽记忆：账号快照对象未变则复用索引（每请求新建 Auth / 每次出站头判定都不会重建 Map） */
let indexMemo: { accounts: readonly AuthAccount[]; indexes: ProxyCredentialIndexes } | undefined;

/**
 * 取账号表对应的凭证索引（单槽记忆：按快照对象身份复用，未变即不重建）
 * @description `Auth` 与 `isProxyCredentialValue` 共用本函数（判据唯一收口）；
 * 构建结果只读，多会话并发共享无竞态——账号文件热加载不受影响，快照对象一变就重建
 * @param accounts - 账号表（来自 users.json，视为只读）
 * @returns basic/uid 两套索引
 */
export function credentialIndexesFor(accounts: readonly AuthAccount[]): ProxyCredentialIndexes {
  if (indexMemo && indexMemo.accounts === accounts) {
    return indexMemo.indexes;
  }
  const indexes = buildCredentialIndexes(accounts);
  indexMemo = { accounts, indexes };
  return indexes;
}

/**
 * 从 Basic 令牌中提取用户名（审计展示与 uid 模糊比对共用）
 * @description 若令牌符合 base64 字符集则尝试解码，含 `:` 时视为 `user:pass` 明文；取 `:` 前的用户名并截断至 32 字符
 * @param token - 可能为 base64 或明文 `user:pass` 的字符串
 * @returns 用户名或截断后的令牌前缀
 */
export function extractBasicUser(token: string): string | undefined {
  let plain = token;
  if (RE_BASE64_STRICT.test(token)) {
    try {
      const d = Buffer.from(token, "base64").toString();
      if (d.includes(":")) {
        plain = d;
      }
    } catch {}
  }
  const u = plain.split(":")[0]?.trim();
  return (u && u.length <= 32 ? u : token.slice(0, 16)) || undefined;
}

/**
 * 比对 Basic 令牌（整串精确）
 * @param t - 提取到的令牌（`b64(user:pass)` 或明文 `user:pass`）
 * @param indexes - `credentialIndexesFor` 产物
 * @returns 命中的用户名，未命中 undefined
 */
export function matchBasicCredential(
  t: string,
  indexes: ProxyCredentialIndexes,
): string | undefined {
  return indexes.basic.get(t);
}

/**
 * 比对 UID 令牌（仅用户名，密码忽略）
 * @description socks4 USERID 场景：客户端可能发裸用户名、`user:pass` 明文、
 * `b64(user:pass)` 或 `b64(username)`——一律只取用户名部分与账号表比对
 * @param t - 提取到的令牌
 * @param indexes - `credentialIndexesFor` 产物
 * @returns 命中的用户名，未命中 undefined
 */
export function matchUidCredential(t: string, indexes: ProxyCredentialIndexes): string | undefined {
  const trimmed = t.trim();
  if (!trimmed) {
    return undefined;
  }
  // 1) 裸用户名
  if (indexes.uidUsers.has(trimmed)) {
    return trimmed;
  }
  // 2) 明文 `user:pass` 或 b64(user:pass)：取 `:` 前的用户名
  const extracted = extractBasicUser(trimmed);
  if (extracted && indexes.uidUsers.has(extracted)) {
    return extracted;
  }
  // 3) b64(裸用户名)（如 test -> dGVzdA==）：整体解码后再按 `:` 切
  try {
    const decoded = Buffer.from(trimmed, "base64").toString().trim();
    const user = decoded.split(":")[0]?.trim();
    if (user && indexes.uidUsers.has(user)) {
      return user;
    }
  } catch {
    // 非法 base64 不抛即视为不匹配
  }
  return undefined;
}

/**
 * 判断字符串是否具备 JWT 形状（三段式）
 * @description 只做形状判定、不验签（验签见 {@link verifyHs256Jwt}）；与 `Auth.extractUserFromToken` 共用
 * @param t - 待检测的令牌字符串
 * @returns 是否像 JWT（恰含两个 `.` 的三段式）
 * @example isJwtShape("eyJhbGciOi...") // => true（若为三段式）
 * @example isJwtShape("YWRtaW46c2VjcmV0") // => false
 */
export function isJwtShape(t: string): boolean {
  return t.includes(".") && t.split(".").length === 3;
}

/**
 * 内置 HS256 JWT 校验（同步，零依赖 `node:crypto`）
 * @description
 * `core/auth.ts:defaultJwtVerify` 的实现体（那边只做薄 async 包装）——鉴权与出站凭证剥离
 * （`isProxyCredentialValue`）共用同一实现，避免两处验签逻辑漂移：
 * - 拒绝空密钥（`JWT_SECRET` 缺失时一律判否，fail-closed）
 * - 仅接受 `alg=HS256` 的三段式令牌（`none` / RS256 等其他算法在签名比对前即拒绝）
 * - 以 HMAC-SHA256(`header.payload`) 比对签名段，`timingSafeEqual` 定长时间比较（防时序侧信道）
 * - 载荷必须是 JSON 对象；带 `exp` 时校验未过期，`exp` 非有限数值一律拒绝（fail-closed）
 * - 永不抛出：解析/比对异常一律归约为 `false`
 * @param token - JWT 字符串（三段式）
 * @param secret - 签名密钥（store 的 `jwtSecret`）
 * @returns 校验是否通过（同步 boolean，永不抛）
 * @example verifyHs256Jwt("eyJhbGciOi...eyJzdWIi...sig", "s3cr3t") // => true
 * @example verifyHs256Jwt("not-a-jwt", "s3cr3t") // => false
 * @example verifyHs256Jwt(token, "") // => false（空密钥）
 */
export function verifyHs256Jwt(token: string, secret: string): boolean {
  try {
    if (!secret) {
      return false;
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      return false;
    }
    const [h, p, s] = parts;
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as {
      alg?: unknown;
    } | null;
    if (header === null || typeof header !== "object" || header.alg !== "HS256") {
      return false;
    }
    const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
    const actual = Buffer.from(s, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return false;
    }
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<
      string,
      unknown
    > | null;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }
    if ("exp" in payload) {
      const exp = payload.exp;
      if (typeof exp !== "number" || !Number.isFinite(exp)) {
        return false;
      }
      if (exp * 1000 <= Date.now()) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 编码 Basic 凭证为 base64
 * @param u - 用户名
 * @param p - 密码
 * @returns base64 字符串
 * @example encodeBasicCredentials("admin", "s3cr3t") // => "YWRtaW46czNjcjN0"
 */
export function encodeBasicCredentials(u: string, p: string): string {
  return Buffer.from(`${u}:${p}`).toString("base64");
}

/**
 * 拼装 `Proxy-Authorization` 请求头值
 * @description scheme 前缀取自 `utils/constants` 的 `AUTH_SCHEME_BASIC`（尾空格是语义的一部分），
 * 本函数只做拼接——**刻意与 `encodeBasicCredentials` 分开**：前者产出 base64 载荷，
 * 后者产出完整头值，上游 Basic 凭证头（`upstream.ts`）与 SOCKS 会话（`socks-session.ts`）
 * 都要完整头值，编码只该有一份实现
 * @param b64 - `user:password` 的 base64 编码（不含 scheme 前缀）
 * @returns 完整头值，形如 `"Basic dXNlcjpwYXNz"`
 * @example buildProxyAuthValue("dXNlcjpwYXNz") // => "Basic dXNlcjpwYXNz"
 */
export function buildProxyAuthValue(b64: string): string {
  return `${AUTH_SCHEME_BASIC}${b64}`;
}
