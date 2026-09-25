/**
 * @fileoverview 代理领域共享工具集
 * @module core/proxy-helpers
 * @description
 * 本文件收敛代理链路中跨转发/隧道/认证复用的纯工具：
 * 头部处理、目标解析、凭证编码、CONNECT 报文构造。
 *
 * 职责：
 * - 头部域：`isStrippableOutboundHeader`（剔除判据的唯一收口：任意 `proxy-` 前缀 + 代理凭证形态的 `Authorization`，`sanitizeHeaders` 与 websocket 的 Upgrade 报文共用）、净化出站头（强制 `Connection: close`）
 * - 凭证域：`buildCredentialIndexes` / `credentialIndexesFor`（单槽记忆）/ `matchBasicCredential` / `matchUidCredential` / `isJwtShape` / `verifyHs256Jwt`（出站剥离与鉴权共用同一判据）
 * - 解析域：`parseTargetParts`（从绝对 URL 或 Host 头解析 host/port/path）、`parseAuthority`（拆 CONNECT authority）
 * - 编码域：`encodeBasicCredentials` / `buildConnectRequest`（构造上游 CONNECT 报文）
 * - 协议域：`isSocksProto` / `socksVersionOf` / `isTlsUpstreamProto`（upstreamProtocol → SOCKS 系判定/握手版本/TLS 承载的唯一映射）
 * - 自环检测：`isSelfLoop`（委托 `utils/ip:isSelfLoopAddr` 并注入当前监听 host/port）
 * - 拨号前置域：`resolveForwardTargets`（拨号目标 vs 客户端请求目标成对解析 + 路由判定）、`resolveRoute`（直连/上游路由判定，仅 client 查 upstream 组）、`guardPreDial`（自环 + 目标名单的共享前置守卫，命中发事件并回调协议自理的拒绝收尾）、`httpReplyFor`（状态码 → 预拼最小应答报文，裸 socket 拒绝收尾用）
 *
 * 设计要点：
 * - 纯函数优先：解析/编码/判定均为无副作用纯函数，便于单测（状态式守卫在 `core/guard.ts`）；
 *   拨号前置域是仅有的例外——`resolveForwardTargets`/`resolveRoute` 读配置、`guardPreDial` 读 ACL 热加载缓存并回调 `emit`/`deny`
 * - 配置经端口注入：凡读配置的函数末尾一律追加可选参数 `config: ConfigAccessor = globalConfigAccessor`，
 *   缺省读全局单例（行为与改造前逐字一致），库模式多实例时由调用方注入私有 store 派生的访问器
 * - 零日志：本文件不依赖 logger；事件上抛（`HelperEvent / HelperEventSink`）由 `core/guard.ts` 承担，日志在 server 层落盘
 * - 凭证剥离与鉴权同源：`isProxyCredentialValue` 与 `Auth` 共用 `credentialIndexesFor` / `verifyHs256Jwt`；
 *   jwt 模式剥 scheme 后按内置 HS256 验签，不依赖账号表（jwt 允许空表）
 * - 大小写不敏感：`isStrippableOutboundHeader` 统一转小写比对，兼容 Node 头名大小写差异
 * - 依赖方向：`proxy-helpers → utils/*` 单向；隧道桥接在 `forward/dial.ts:Dialer.bridge`，避免循环
 * - 常量收敛：所有协议常量（CRLF/状态行/默认端口/头名）均来自 `utils/constants.ts`，禁止内联魔数
 *
 * 使用示例：
 * ```ts
 * import { parseTargetParts, sanitizeHeaders, buildConnectRequest } from "@/core/proxy-helpers.js";
 *
 * // 1) 解析目标
 * const parts = parseTargetParts(req.url!, req.headers.host, "http:"); // => { host, port, path }
 *
 * // 2) 净化出站头
 * const outHeaders = sanitizeHeaders({ ...req.headers });
 *
 * // 3) 构造 CONNECT 报文（经 http 上游转发时）
 * const raw = buildConnectRequest("example.com", 443, "Proxy-Authorization: Basic xxx");
 * upstreamSocket.write(raw);
 * ```
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import net from "node:net";
import type http from "node:http";
import type { Duplex } from "node:stream";
import {
  CRLF,
  DEFAULT_PORT_HTTP,
  DEFAULT_PORT_HTTPS,
  DOUBLE_CRLF,
  HEADER_NAME_CONNECTION,
  HEADER_NAME_HOST_TITLE,
  HEADER_NAME_PROXY_AUTHORIZATION,
  HEADER_NAME_PROXY_CONNECTION,
  HEADER_PREFIX_PROXY,
  HEADER_VALUE_CLOSE,
  HTTP_400_BAD_REQUEST,
  HTTP_403_FORBIDDEN,
  HTTP_502_BAD_GATEWAY,
  HTTP_504_GATEWAY_TIMEOUT,
  HTTP_VERSION,
  MAX_TARGET_HOST_BYTES,
  RE_VALID_TARGET_HOST,
  RE_ABSOLUTE_URL,
  RE_BASE64_STRICT,
  RE_DIGITS,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
  STATUS_GATEWAY_TIMEOUT,
  buildProxyAuthValue,
} from "@/utils/constants.js";
import { globalConfigAccessor, type ConfigAccessor } from "@/core/config-access.js";
import { loadAuthUsers } from "@/config/auth-users.js";
import { checkTargetHost, checkUpstreamRoute, type AclReason } from "@/config/acl.js";
import type { AuthAccount, PipeEvent } from "@/core/types/proxy.js";
import { isSelfLoopAddr } from "@/utils/ip.js";

/**
 * 凭证索引（`Auth` 与 `isProxyCredentialValue` 共用的唯一判据源）
 * @description
 * 判据收口在此一处，`core/auth.ts` 只做薄委托（`auth → proxy-helpers` 单向，无循环）：
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
export function buildCredentialIndexes(
  accounts: readonly AuthAccount[],
): ProxyCredentialIndexes {
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
export function credentialIndexesFor(
  accounts: readonly AuthAccount[],
): ProxyCredentialIndexes {
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
export function matchUidCredential(
  t: string,
  indexes: ProxyCredentialIndexes,
): string | undefined {
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
 * 判断出站头是否应剥离（宽规则）
 * @description 任意 `proxy-` 前缀（大小写不敏感）一律剥离 +
 * `authorization` 命中 `isProxyCredentialValue` 即剥离（代理凭证不得泄漏到目标站点，
 * 其余 `Authorization` 如目标 `Bearer` 原样保留）；
 * `sanitizeHeaders` 与 websocket `buildUpgradeReq` 共用本谓词，
 * 此前漏删的非标准 `proxy-*` 头现在一并删掉（只允许越删越多）
 * @param name - 头名（任意大小写）
 * @param value - 头值（`authorization` 判定时使用；数组取任一命中即剥离）
 * @param config - 配置访问器；缺省 `globalConfigAccessor`（读全局单例，行为与改造前一致），
 *   库模式多实例时传入 `configAccessorFromStore(runtimeStore)` 以读私有配置
 * @returns 是否应剥离
 * @example isStrippableOutboundHeader("Proxy-Foo", "bar") // => true
 * @example isStrippableOutboundHeader("Authorization", "Bearer target-token") // => false（视账号表而定）
 */
export function isStrippableOutboundHeader(
  name: string,
  value?: string | string[] | undefined,
  config: ConfigAccessor = globalConfigAccessor,
): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith(HEADER_PREFIX_PROXY)) {
    return true;
  }
  if (lower === "authorization") {
    if (typeof value === "string") {
      return isProxyCredentialValue(value, config);
    }
    if (Array.isArray(value)) {
      return value.some((v) => isProxyCredentialValue(v, config));
    }
  }
  return false;
}

/**
 * 剥离代理相关头（原地删除）
 * @description 遍历头字典，删除所有命中 `isStrippableOutboundHeader` 的键；注意会 mutate 传入对象
 * @param h - 头字典（会被原地修改）
 * @param config - 配置访问器；缺省 `globalConfigAccessor`（读全局单例，行为与改造前一致），
 *   库模式多实例时传入 `configAccessorFromStore(runtimeStore)` 以读私有配置
 * @returns 同一对象（已删除代理头）
 * @example stripProxyHeaders({ "Proxy-Authorization": "Basic xxx", "Host": "example.com" }) // => { Host: ... }
 */
export function stripProxyHeaders<H extends Record<string, string | string[] | undefined>>(
  h: H,
  config: ConfigAccessor = globalConfigAccessor,
): H {
  for (const k of Object.keys(h)) {
    if (isStrippableOutboundHeader(k, h[k], config)) {
      delete h[k];
    }
  }
  return h;
}

/**
 * 净化出站头（浅拷贝后剥离代理头并强制 `Connection: close`）
 * @description 先浅拷贝再 `stripProxyHeaders`，避免污染原对象；随后覆写 `connection: close` 以禁用上游长连接
 * @param h - 原始头字典
 * @param config - 配置访问器；缺省 `globalConfigAccessor`（读全局单例，行为与改造前一致），
 *   库模式多实例时传入 `configAccessorFromStore(runtimeStore)` 以读私有配置
 * @returns 净化后的新头字典
 * @example sanitizeHeaders(req.headers) // => { host: "...", connection: "close", ... }（无 proxy 头）
 */
export function sanitizeHeaders(
  h: Record<string, string | string[] | undefined>,
  config: ConfigAccessor = globalConfigAccessor,
): Record<string, string | string[] | undefined> {
  const s = stripProxyHeaders({ ...h }, config);
  s[HEADER_NAME_CONNECTION] = HEADER_VALUE_CLOSE;
  return s;
}

/**
 * 判断 `Authorization` 头值是否为代理自身凭证
 * @description 与 `Auth` 共用上方判据（唯一收口）：
 * `basic` 走整串精确（`b64(user:pass)` / 明文 `user:pass`），`uid` 走用户名模糊
 * （裸用户名 / `user:pass` / `b64(user:pass)` / `b64(username)`，密码忽略）；
 * 多账号下需与**整份账号表**逐个比对——只比对一个账号会让其余账号的凭证原样泄漏到目标站点。
 * `jwt` 模式不依赖账号表（jwt 允许空表）：剥 scheme 前缀后按 `isJwtShape` + `verifyHs256Jwt`
 * （内置 HS256 + `jwtSecret`）验签，命中即剥离——否则客户端用 `Authorization: Bearer <代理JWT>`
 * 认证时，该代理 JWT 会被原样转发给目标站（extractToken 的 Authorization 回退正是这么取的）。
 * `stripped` 为 scheme 剥离形态（`Auth.extractToken` 的出站侧对应物，覆盖无 scheme 裸值），命中即判真
 * （超集安全：宁可多剥，不让真凭证泄漏）。
 *
 * 已知边界：注入自定义 `jwtVerify` 时本判据不感知（只认内置 HS256；生产 `createAuthFromConfig`
 * 默认注入内置校验器）；方向仍是「宁可多剥不泄漏」——自定义校验器放行的 token 不会被剥离，属已记录边界。
 * @param value - `Authorization` 头值（如 "Basic dXNlcjpwYXNz" 或 "Bearer eyJ..."）
 * @param config - 配置访问器；缺省 `globalConfigAccessor`（读全局单例，行为与改造前一致），
 *   库模式多实例时传入 `configAccessorFromStore(runtimeStore)` 以读私有配置
 * @returns 是否为代理凭证（鉴权未启用/类型非 basic|uid|jwt 时恒为 false；jwt 模式不要求账号表非空）
 * @example isProxyCredentialValue("Basic dXNlcjpwYXNz") // 视 store 与 users.json 而定
 * @example isProxyCredentialValue("Bearer eyJ...") // jwt 模式：内置 HS256 验签通过才为 true
 */
export function isProxyCredentialValue(
  value: string,
  config: ConfigAccessor = globalConfigAccessor,
): boolean {
  if (!config.get("authEnabled")) {
    return false;
  }
  const type = config.get("authType");
  if (type !== "basic" && type !== "uid" && type !== "jwt") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const stripped = trimmed.replace(/^[A-Za-z]+\s+/, "");
  if (type === "jwt") {
    // jwt 允许空账号表：本分支必须先于 loadAuthUsers() 的早退（否则空表下代理 JWT 会泄漏）
    return isJwtShape(stripped) && verifyHs256Jwt(stripped, config.get("jwtSecret"));
  }
  const accounts = loadAuthUsers(config);
  if (accounts.length === 0) {
    // 空账号表在 loader 层已阻止启动，这里保持纵深防御
    return false;
  }
  const indexes = credentialIndexesFor(accounts);
  if (type === "basic") {
    return (
      matchBasicCredential(stripped, indexes) !== undefined ||
      matchBasicCredential(trimmed, indexes) !== undefined
    );
  }
  return (
    matchUidCredential(stripped, indexes) !== undefined ||
    matchUidCredential(trimmed, indexes) !== undefined
  );
}

/**
 * 合法端口下界（TCP 端口范围 1..65535；0 与越界值视为非法）
 */
const MIN_PORT = 1;
/**
 * 合法端口上界
 */
const MAX_PORT = 65535;

/**
 * 校验目标主机是否可作为转发目标
 * @description 白名单字符集 + 255 字节上限（SOCKS5 域名长度域上限，RFC1928 §5）：
 * - 字符集：CRLF / 空白 / 控制字符 / `/` / `@` / `?` 等一律判非法，杜绝对上游 CONNECT 报文与 SOCKS 请求的注入
 *   （SOCKS 侧主机名是原始字节，不经过 HTTP 解析器，注入只能在构造报文前收口）
 * - 长度：超过 255 字节会让 SOCKS5 的 1 字节长度域按 256 取模截断（256 → 0）造成协议失步
 * @param host - 目标主机名或 IP 字面量（不含端口）
 * @returns 是否合法
 * @example isValidTargetHost("example.com") // => true
 * @example isValidTargetHost("example.com\r\nX-Injected: 1") // => false
 * @example isValidTargetHost("a".repeat(256)) // => false
 */
export function isValidTargetHost(host: string): boolean {
  return (
    host.length > 0 &&
    Buffer.byteLength(host) <= MAX_TARGET_HOST_BYTES &&
    RE_VALID_TARGET_HOST.test(host)
  );
}

/**
 * 取 absolute-form 请求行的权威值（`host[:port]`，IPv6 保留方括号）
 * @description RFC 7230 §5.4：代理收到 absolute-form 请求时必须忽略 Host 头，
 * 并按 request-target 的权威值回写下游请求的 Host，避免虚拟主机混淆
 * @param url - 请求行 target
 * @returns 权威值；非 absolute-form 或解析失败返回 null
 * @example absoluteFormAuthority("http://example.com:8080/x") // => "example.com:8080"
 * @example absoluteFormAuthority("/x") // => null
 */
export function absoluteFormAuthority(url: string): string | null {
  if (!RE_ABSOLUTE_URL.test(url)) {
    return null;
  }
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * 目标三元组
 * @param path - 请求路径（含 query，如 "/api?page=1"）
 * @example { host: "example.com", port: 80, path: "/index.html" }
 */
export interface TargetParts {
  host: string;
  port: number;
  path: string;
}

/**
 * 拆分 authority/Host 为 host 与 port（parseTargetParts 与 parseAuthority 共用）
 * @description
 * 支持四种形态：`host`、`host:port`、`[v6]`、`[v6]:port`。
 * - 方括号 IPv6：剥去方括号得裸地址（如 `[::1]:8080` → host 为 `::1`），满足 net.connect 直用
 * - 缺省端口：返回 `defaultPort`
 * - 非法返回 null：空 host、显式空端口（`host:`）、非数字端口、端口不在 1..65535、
 *   裸 IPv6（多冒号且无方括号）、未闭合方括号
 * @param authority - 待拆分字符串（Host 头或 CONNECT authority）
 * @param defaultPort - 缺省端口（未显式给出端口时使用）
 * @returns `{ host, port }` 或 null
 * @example splitAuthority("[::1]:8080", 80) // => { host: "::1", port: 8080 }
 * @example splitAuthority("example.com", 443) // => { host: "example.com", port: 443 }
 * @example splitAuthority("example.com:", 443) // => null
 * @example splitAuthority("2001:db8::1", 443) // => null
 */
function splitAuthority(
  authority: string,
  defaultPort: number,
): { host: string; port: number } | null {
  const s = authority.trim();
  if (!s) {
    return null;
  }
  let host: string;
  let portStr: string | undefined;
  if (s.startsWith("[")) {
    // 方括号 IPv6：[v6] 或 [v6]:port
    const end = s.indexOf("]");
    if (end === -1) {
      return null;
    }
    host = s.slice(1, end);
    const rest = s.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(":")) {
        return null;
      }
      portStr = rest.slice(1);
    }
  } else {
    const idx = s.lastIndexOf(":");
    if (idx === -1) {
      host = s;
    } else {
      // 多冒号且无方括号 = 裸 IPv6，本函数不支持（避免乱拆）
      if (s.indexOf(":") !== idx) {
        return null;
      }
      host = s.slice(0, idx);
      portStr = s.slice(idx + 1);
    }
  }
  if (!host) {
    return null;
  }
  if (portStr === undefined) {
    return { host, port: defaultPort };
  }
  if (!RE_DIGITS.test(portStr)) {
    return null;
  }
  const port = Number(portStr);
  if (port < MIN_PORT || port > MAX_PORT) {
    return null;
  }
  return { host, port };
}

/**
 * 解析请求目标为 host/port/path 三元组
 * @description
 * - 若 `raw` 为绝对 URL（`http(s)://...`）：用 `new URL` 解析；host 取 `u.hostname`
 *   （方括号 IPv6 会剥去方括号，供 net.connect 直用）；端口取 URL 显式端口，
 *   缺省按 scheme 取默认端口（RFC 7230 §5.4：absolute-form 忽略 Host 头，不从 Host 补端口）
 * - 否则视为 origin-form：用共享 authority 拆分 `hostHeader`（支持 `[v6]:port`），
 *   缺省端口按 `proto` 判定（https→443，其余→80）
 * - Host 头端口非数字/越界、裸 IPv6 无方括号等非法形态 → 返回 null（不静默回落默认端口）
 * @param raw - 请求的 URL 原始字符串（可能是绝对 URL 或 origin-form 的 path）
 * @param hostHeader - Host 请求头值（可能含端口，如 "example.com:8080" 或 "[::1]:8080"）
 * @param proto - 协议提示（如 "https:"），用于 origin-form 的默认端口判定
 * @returns 解析成功返回 TargetParts，失败返回 null（绝对 URL 解析异常 / 缺 Host 头 / authority 非法）
 * @example parseTargetParts("http://example.com:8080/api?q=1", "example.com:8080") // => { host:"example.com", port:8080, path:"/api?q=1" }
 * @example parseTargetParts("/api", "example.com") // => { host:"example.com", port:80, path:"/api" }
 * @example parseTargetParts("/api", "[::1]:8080") // => { host:"::1", port:8080, path:"/api" }
 * @example parseTargetParts("http://[2001:db8::1]/x", undefined) // => { host:"2001:db8::1", port:80, path:"/x" }
 * @example parseTargetParts("/api", undefined) // => null
 */
export function parseTargetParts(
  raw: string,
  hostHeader?: string,
  proto?: string,
): TargetParts | null {
  if (RE_ABSOLUTE_URL.test(raw)) {
    try {
      const u = new URL(raw);
      const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
      const defaultPort = u.protocol === "https:" ? DEFAULT_PORT_HTTPS : DEFAULT_PORT_HTTP;
      let port: number | null = u.port ? Number(u.port) : null;
      if (port !== null && (port < MIN_PORT || port > MAX_PORT)) {
        return null;
      }
      // RFC 7230 §5.4：absolute-form 的权威值只来自 request-target，Host 头一律忽略——
      // 用 Host 头补端口会让 host 与 port 来自不同输入源（虚拟主机/端口混淆）
      if (port === null) {
        port = defaultPort;
      }
      if (!isValidTargetHost(host)) {
        return null;
      }
      return {
        host,
        port,
        path: `${u.pathname}${u.search}` || "/",
      };
    } catch {
      return null;
    }
  }
  if (!hostHeader) {
    return null;
  }
  const defaultPort = proto?.startsWith("https") ? DEFAULT_PORT_HTTPS : DEFAULT_PORT_HTTP;
  const split = splitAuthority(hostHeader, defaultPort);
  if (!split || !isValidTargetHost(split.host)) {
    return null;
  }
  return {
    host: split.host,
    port: split.port,
    path: raw || "/",
  };
}

/**
 * 解析 CONNECT authority 为 hostname/port
 * @description 委托共享 authority 拆分：支持 `host`、`host:port`、`[v6]`、`[v6]:port`；
 * 缺端口默认 443；显式空端口（`host:`）、非数字端口、端口不在 1..65535、
 * 空 host、裸 IPv6（多冒号无方括号）→ 返回 null
 * @param a - authority 字符串（如 "example.com:443" 或 "[::1]:443"）
 * @returns 解析结果或 null
 * @example parseAuthority("example.com:443") // => { hostname:"example.com", port:443 }
 * @example parseAuthority("example.com") // => { hostname:"example.com", port:443 }
 * @example parseAuthority("[::1]:8443") // => { hostname:"::1", port:8443 }
 * @example parseAuthority("example.com:") // => null
 * @example parseAuthority("2001:db8::1") // => null
 * @example parseAuthority(":443") // => null
 */
export function parseAuthority(a: string): { hostname: string; port: number } | null {
  const split = splitAuthority(a, DEFAULT_PORT_HTTPS);
  if (!split || !isValidTargetHost(split.host)) {
    return null;
  }
  return { hostname: split.host, port: split.port };
}

/**
 * 拨号目标与客户端请求目标（client 模式两者不同：拨的是上游，名单判的是客户端要访问的站点）
 * @param dial - 实际拨号目标：有效模式为 server 即真实目标（client 配置但路由名单命中时同样直拨真实目标），
 *   有效模式为 client 才是 `upstreamHost:upstreamPort`
 * @param dest - 客户端请求的目标（与 dial 同为名单判定对象）
 * @param route - 路由判定（有效模式 + direct/upstream + 名单命中原因），调用方后续分支一律以它为准
 */
export interface ForwardTargets {
  dial: TargetParts;
  dest: TargetParts;
  route: RouteDecision;
}

/**
 * 路由判定结果：本请求的「有效模式」与「直连还是交上游」
 * @param mode - 有效模式：配置 server 恒 "server"；配置 client 命中路由名单回落 "server"（该请求按 server 语义处理）
 * @param route - server 代理模式恒 "direct"；client 模式按名单判 "direct" | "upstream"
 * @param reason - 直连且因路由名单命中时给出（blacklist / whitelist）
 */
export interface RouteDecision {
  mode: "server" | "client";
  route: "direct" | "upstream";
  reason?: AclReason;
}

/**
 * 判定请求的路由：直连（不交上游）还是经 client 上游串联
 * @description
 * - `proxyMode !== "client"` → `{ mode: "server", route: "direct" }`，**不查 upstream 组**（server 模式零开销短路）；
 * - client 模式委托 `acl:checkUpstreamRoute`：黑名单命中（优先）/ 白名单非空未命中 → 回落
 *   `{ mode: "server", route: "direct", reason }`（命中即按 server 语义处理：拨号目标/path 形态/
 *   上游凭证/Host 回写/secure 标志全部自然回落）；否则 `{ mode: "client", route: "upstream" }`。
 * - 纯函数不打日志：路由事实由各转发器在 preDial 通过后的分支处经 `emitRoute` 发事件（见 `forward/base:emitRoute`），落盘归 server 层
 * @param dest - 客户端请求的目标（名单只判 host，端口不参与）
 * @param config - 配置访问器；缺省 `globalConfigAccessor`（读全局单例，行为与改造前一致），
 *   库模式多实例时传入 `configAccessorFromStore(runtimeStore)` 以按实例的 `proxyMode` 与名单路由
 * @returns 路由判定
 */
export function resolveRoute(
  dest: { host: string; port: number },
  config: ConfigAccessor = globalConfigAccessor,
): RouteDecision {
  if (config.get("proxyMode") !== "client") {
    return { mode: "server", route: "direct" };
  }
  const r = checkUpstreamRoute(dest.host, config);
  if (r.direct) {
    return { mode: "server", route: "direct", ...(r.reason ? { reason: r.reason } : {}) };
  }
  return { mode: "client", route: "upstream" };
}

/**
 * 成对解析「拨号目标」与「客户端请求的目标」，并给出路由判定
 * @description
 * 收敛 http.handle 与 websocket.handle 逐字重复的两段三元解析：
 * - dest 先解析（绝对 URL 或 Host，与模式无关）→ `resolveRoute(dest)` 出有效模式 → **按有效模式选 dial**：
 *   有效 client 才拨 `UPSTREAM_*`（path 保留客户端原始 request-target，串联给上游代理必须 absolute-form），
 *   否则 dial = dest（server 配置直连；client 配置但路由名单命中同样直拨真实目标）；
 *   名单判定的永远是 `dest`，上游的协议/地址/端口只来自 `UPSTREAM_*`、**不受名单约束**
 * - 任一解析失败返回 null，由调用方发 `target-unresolved` 并回 400（与改造前两段独立判空的行为一致）
 * - 调用方拿返回的 `route.mode`（有效模式）做后续分支，**不得再裸读 `get("proxyMode")`**
 * @param url - 请求行 target（可能是绝对 URL 或 origin-form 的 path）
 * @param hostHeader - Host 请求头（origin-form 时用于解析目标）
 * @param config - 配置访问器；缺省 `globalConfigAccessor`（读全局单例，行为与改造前一致），
 *   库模式多实例时传入 `configAccessorFromStore(runtimeStore)` 以读该实例的 `proxyMode`/`upstreamHost`/`upstreamPort`
 * @returns 一对目标 + 路由判定，解析失败返回 null
 * @example resolveForwardTargets("http://a.com/x", "a.com")
 * // => { dial: {upstream...}, dest: {a.com...}, route: {mode:"client", route:"upstream"} }
 */
export function resolveForwardTargets(
  url?: string,
  hostHeader?: string,
  config: ConfigAccessor = globalConfigAccessor,
): ForwardTargets | null {
  const dest = parseTargetParts(url ?? "", hostHeader);

  if (!dest) {
    return null;
  }

  const route = resolveRoute(dest, config);

  if (route.mode === "client") {
    return {
      dial: { host: config.get("upstreamHost"), port: config.get("upstreamPort"), path: url ?? "/" },
      dest,
      route,
    };
  }

  return { dial: dest, dest, route };
}

/**
 * 拼装 authority 字符串（`host:port`；IPv6 字面量补回方括号）
 * @description 解析侧（`parseTargetParts`/`parseAuthority`）刻意剥去 IPv6 方括号以便 `net.connect` 直用，
 * 拼装侧（CONNECT 请求行、Upgrade/CONNECT 的 Host 头）必须补回：RFC 3986 的 authority 中
 * IPv6 只能是 `[v6]:port` 形态，`::1:443` 是畸形报文，上游代理/源站无法解析。
 * 已带方括号的输入原样保留端口拼接（兼容手工配置的 `UPSTREAM_HOST=[::1]`）。
 * @param host - 主机名或 IP 字面量（IPv6 可带或不带方括号）
 * @param port - 端口
 * @returns `host:port`（IPv6 为 `[host]:port`）
 * @example formatAuthority("example.com", 443) // => "example.com:443"
 * @example formatAuthority("::1", 443) // => "[::1]:443"
 * @example formatAuthority("[::1]", 443) // => "[::1]:443"
 */
export function formatAuthority(host: string, port: number): string {
  const bracketed = host.startsWith("[") && host.endsWith("]");
  const isV6 = bracketed || net.isIP(host) === 6;
  return isV6 ? `[${bracketed ? host.slice(1, -1) : host}]:${port}` : `${host}:${port}`;
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
 * 构造 CONNECT 请求报文
 * @description 生成 `CONNECT host:port HTTP/1.1\r\nHost: host:port\r\n[extra]\r\nProxy-Connection: keep-alive\r\n\r\n` 形态
 * @param host - 目标主机
 * @param port - 目标端口
 * @param extra - 额外头行（已含 CRLF 结束前的完整头行，如 "Proxy-Authorization: Basic xxx"），可选
 * @returns 完整的 CONNECT 报文字符串
 * @example buildConnectRequest("example.com", 443) // => "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Connection: keep-alive\r\n\r\n"
 * @example buildConnectRequest("::1", 443) // => "CONNECT [::1]:443 HTTP/1.1\r\nHost: [::1]:443\r\n..."
 * @example buildConnectRequest("example.com", 443, "Proxy-Authorization: Basic xxx") // 额外头会插入在首部
 */
export function buildConnectRequest(host: string, port: number, extra?: string): string {
  // 纵深防御：CONNECT 请求行/头由字符串拼接而成，主机名必须过白名单，
  // 否则含 CRLF 的主机会注入额外头行乃至第二个请求（借用本代理配置的上游凭证）
  if (!isValidTargetHost(host)) {
    throw new Error("invalid target host");
  }
  const auth = extra ? `${extra}${CRLF}` : "";
  const authority = formatAuthority(host, port);
  return (
    `CONNECT ${authority} ${HTTP_VERSION}${CRLF}` +
    `${HEADER_NAME_HOST_TITLE}: ${authority}${CRLF}` +
    `${auth}${HEADER_NAME_PROXY_CONNECTION}: keep-alive${DOUBLE_CRLF}`
  );
}

/**
 * 判断上游协议是否为 SOCKS 系（socks4/socks5/sockss4/sockss5）
 * @description 串联分流的唯一判据：此前 http/tunnel/websocket/socks 四处各写一份四连等，容易漂移
 * @param p - `upstreamProtocol` 取值
 * @returns 是否 SOCKS 系
 * @example isSocksProto("sockss4") // => true
 * @example isSocksProto("https") // => false
 */
export function isSocksProto(p: string): boolean {
  return p === "socks4" || p === "socks5" || p === "sockss4" || p === "sockss5";
}

/**
 * 上游 SOCKS 协议 → 握手版本
 * @description socks4/sockss4 → 4，socks5/sockss5 → 5；调用点须先经 `isSocksProto` 分流
 * （非 SOCKS 协议按 5 兜底，该分支不会实际发生）
 * @param p - `upstreamProtocol` 取值
 * @returns 4 或 5
 * @example socksVersionOf("sockss4") // => 4
 */
export function socksVersionOf(p: string): 4 | 5 {
  return p === "socks4" || p === "sockss4" ? 4 : 5;
}

/**
 * 上游协议是否为 TLS 承载
 * @description 覆盖 `https` 与 `sockss*`（SOCKS over TLS）；`http`/`socks4`/`socks5` 为明文
 * @param p - `upstreamProtocol` 取值
 * @returns 是否 TLS 承载
 * @example isTlsUpstreamProto("https") // => true
 * @example isTlsUpstreamProto("socks5") // => false
 */
export function isTlsUpstreamProto(p: string): boolean {
  return p === "https" || p.startsWith("sockss");
}

/**
 * 上游代理 Basic 凭证头值（仅显式配置 upstreamUsername 时携带）
 * @description server 直连不带；client 串联的 http/https/socks 三条路径共用本函数，
 * 原先是各转发器各自实现（两种格式，存在漂移风险），收敛到此一处
 * @param config - 配置访问器；缺省 `globalConfigAccessor`（读全局单例，行为与改造前一致），
 *   库模式多实例时传入 `configAccessorFromStore(runtimeStore)` 以读该实例的上游凭证
 * @returns 形如 `Basic dXNlcjpwYXNz` 的头值；未配置 upstreamUsername 返回 undefined
 * @example upstreamAuthValue() // => "Basic YWxpY2U6c2VjcmV0" | undefined
 */
export function upstreamAuthValue(config: ConfigAccessor = globalConfigAccessor): string | undefined {
  const u = config.get("upstreamUsername");

  if (!u) {
    return undefined;
  }

  return buildProxyAuthValue(encodeBasicCredentials(u, config.get("upstreamPassword")));
}

/**
 * 上游代理 Basic 凭证完整头行（`Proxy-Authorization: Basic ...`），供 CONNECT 报文拼接
 * @param config - 配置访问器；缺省 `globalConfigAccessor`（读全局单例，行为与改造前一致），
 *   库模式多实例时传入 `configAccessorFromStore(runtimeStore)` 以读该实例的上游凭证
 * @returns 头行字符串；未配置 upstreamUsername 返回 undefined
 * @example `buildConnectRequest(host, port, upstreamAuthHeaderLine())`
 */
export function upstreamAuthHeaderLine(config: ConfigAccessor = globalConfigAccessor): string | undefined {
  const value = upstreamAuthValue(config);

  return value ? `${HEADER_NAME_PROXY_AUTHORIZATION}: ${value}` : undefined;
}

/**
 * 状态码 → 预拼最小 HTTP/1.1 应答报文（无 body），供裸 socket 拒绝收尾共用
 * @description tunnel / websocket 直接往 Duplex 写状态行，报文必须由 constants 派生、不得内联魔数；
 * 未知状态码按 502 兜底（网关类收尾的保守默认）
 * @param status - HTTP 状态码（400 / 403 / 504 / 502）
 * @returns `HTTP/1.1 <status> <reason>\r\n\r\n`
 * @example httpReplyFor(403) // => HTTP_403_FORBIDDEN
 */
export function httpReplyFor(status: number): string {
  switch (status) {
    case STATUS_BAD_REQUEST:
      return HTTP_400_BAD_REQUEST;
    case STATUS_FORBIDDEN:
      return HTTP_403_FORBIDDEN;
    case STATUS_GATEWAY_TIMEOUT:
      return HTTP_504_GATEWAY_TIMEOUT;
    default:
      return HTTP_502_BAD_GATEWAY;
  }
}

/**
 * 写应答后延时销毁连接
 * @description 立即 destroy 会让应答字节来不及发出（下游收不到回包），延时默认 100ms 确保先落网卡；
 * SOCKS 失败应答（server 层与 forwarder）与各类拒绝收尾共用
 * @param socket - 待回复并关闭的连接
 * @param reply - 预拼应答 Buffer
 * @param delayMs - 延时毫秒，默认 100
 */
export function writeReplyAndClose(socket: Duplex, reply: Buffer, delayMs = 100): void {
  socket.write(reply);

  setTimeout(() => {
    socket.destroy();
  }, delayMs);
}

/**
 * 判断是否为指向自身监听地址的自环请求
 * @description 委托 `utils/ip:isSelfLoopAddr`，自动注入当前配置的 `host/port`
 * @param h - 目标主机名/IP
 * @param p - 目标端口
 * @param config - 配置访问器；缺省 `globalConfigAccessor`（读全局单例的 `host`/`port`，行为与改造前一致），
 *   库模式多实例时传入 `configAccessorFromStore(runtimeStore)` 以按实例监听地址判自环
 * @returns 是否为自环（命中则应直接拒绝，避免代理环路）
 * @example isSelfLoop("127.0.0.1", 7890) // 若当前监听 127.0.0.1:7890 则为 true
 */
export function isSelfLoop(
  h: string,
  p: number,
  config: ConfigAccessor = globalConfigAccessor,
): boolean {
  return isSelfLoopAddr(h, p, config.get("host"), config.get("port"));
}

/**
 * 拨号前置守卫选项
 * @param emit - 事件汇（命中发 `loop-detected` / `target-denied`）
 * @param req - 原始请求（随事件带给日志；裸 socket 场景由 `clientAddr` 承担定位）
 * @param clientAddr - 客户端对端地址（SOCKS 等无 req 的场景）
 * @param dial - 拨号目标：**自环看的是它**（client 模式拨的是上游，上游指回自身监听地址会成环）
 * @param dest - 客户端请求的目标：**名单看的是它**（与 `proxyMode` 无关，上游永不进名单）
 * @param deny - 拒绝收尾闭包，入参为应答状态码（自环 502 / 名单 403），报文形态由协议自理
 * @param config - 配置访问器；缺省 `globalConfigAccessor`（读全局单例，行为与改造前一致），
 *   库模式多实例时传入 `configAccessorFromStore(runtimeStore)` 以按实例监听地址判自环、按实例名单判目标
 */
export interface PreDialOptions {
  emit: (e: PipeEvent) => void;
  req?: http.IncomingMessage;
  clientAddr?: string;
  dial: { host: string; port: number };
  dest: { host: string; port: number };
  deny: (status: number) => void;
  config?: ConfigAccessor;
}

/**
 * 拨号前置守卫：自环 → 目标名单，命中即发事件并执行拒绝收尾
 * @description
 * 收敛四个转发器（http/tunnel/websocket/socks）在「目标已解析、尚未拨号」处的重复判定：
 * - 自环命中发 `loop-detected`、名单拒绝发 `target-denied`（带 `req` 或 `client` 供日志定位），
 *   随后以状态码调用 `deny` 收尾——HTTP 转发器回 403/502 报文，SOCKS 回失败应答，Upgrade 写原始状态行；
 * - **不做** `isValidTargetHost`：HTTP 路径由 `parseTargetParts`/`parseAuthority` 解析时收口，
 *   SOCKS 原始字节（不过 HTTP 解析器）在字节边界单独校验（见 `socks.connect`）
 * @param opts - 见 {@link PreDialOptions}
 * @returns true 表示已拒绝，调用方应立即 return
 * @example
 * ```ts
 * if (guardPreDial({ emit: this.emit, req, dial, dest, deny: (s) => this.failEarly(res, s) })) return;
 * ```
 */
export function guardPreDial(opts: PreDialOptions): boolean {
  const config = opts.config ?? globalConfigAccessor;
  const extra = {
    ...(opts.req ? { req: opts.req } : {}),
    ...(opts.clientAddr ? { client: opts.clientAddr } : {}),
  };

  if (isSelfLoop(opts.dial.host, opts.dial.port, config)) {
    opts.emit({
      type: "loop-detected",
      target: `${opts.dial.host}:${opts.dial.port}`,
      ...extra,
    });
    opts.deny(STATUS_BAD_GATEWAY);
    return true;
  }

  const acl = checkTargetHost(opts.dest.host, config);

  if (!acl.allowed) {
    opts.emit({
      type: "target-denied",
      target: `${opts.dest.host}:${opts.dest.port}`,
      host: opts.dest.host,
      reason: acl.reason,
      ...extra,
    });
    opts.deny(STATUS_FORBIDDEN);
    return true;
  }

  return false;
}
