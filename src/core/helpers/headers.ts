/**
 * @fileoverview 出站头剥离与净化：代理凭证不得泄漏到目标站点
 * @module core/helpers/headers
 * @description
 * 代理把**客户端的**头原样发给**目标站点**之前，必须先摘掉「代理自己的」头：
 * 任意 `proxy-` 前缀 + 形态上是本代理凭证的 `Authorization`。
 * 判据唯一收口在 `isStrippableOutboundHeader`，`sanitizeHeaders` 与 websocket 的
 * Upgrade 报文共用它，错误边界只需要纯名称规则时用 `isProxyHeaderName`。
 *
 * 职责：
 * - 名称规则：`isProxyHeaderName`（**纯**、不读配置）
 * - 剥离判据：`isStrippableOutboundHeader` / `stripProxyHeaders` / `sanitizeHeaders`
 * - 凭证谓词：`isProxyCredentialValue`
 *
 * ⚠️ **`isProxyCredentialValue` 刻意留在本文件，不进 `credentials.ts`**：
 * 它要读 `authEnabled` / `authType` / `jwtSecret` 并调 `loadAuthUsers`（users.json
 * 热加载缓存），本质是**读配置的凭证谓词**；而 `credentials.ts` 的不变量是
 * 「零 `ConfigAccessor`、零文件 IO」的**纯原语**。两者是不同的生命周期
 * （每次请求现读 live store vs 每次调用无状态），挪进去就破了那条分层。
 * 纯原语在 `credentials.ts`，读配置的谓词在本文件，各自依赖各的。
 *
 * 不负责：
 * - 不实现凭证比对原语（`credentials.ts`）、不解析目标（`target.ts`）
 * - 不做 ACL 判定、不发事件、不打日志
 *
 * 依赖：`./credentials.js` + `@/config/index.js`（`ConfigAccessor` 类型 + `loadAuthUsers`）
 * + `@/utils/constants/index.js`。
 *
 * 使用示例：
 * ```ts
 * import { sanitizeHeaders } from "@/core/helpers/headers.js";
 *
 * const outHeaders = sanitizeHeaders({ ...req.headers }, config);
 * ```
 */

import {
  HEADER_NAME_CONNECTION,
  HEADER_PREFIX_PROXY,
  HEADER_VALUE_CLOSE,
} from "@/utils/constants/index.js";
import { loadAuthUsers, type ConfigAccessor } from "@/config/index.js";
import {
  credentialIndexesFor,
  isJwtShape,
  matchBasicCredential,
  matchUidCredential,
  verifyHs256Jwt,
} from "./credentials.js";

/**
 * 判断头名是否属于代理协议头。
 * @description 这是不读配置的纯名称规则：任意 `proxy-` 前缀（大小写不敏感）都应从出站报文剥离。
 *          错误边界只需要该规则，不应为了分类错误而注入配置访问器。
 */
export function isProxyHeaderName(name: string): boolean {
  return name.toLowerCase().startsWith(HEADER_PREFIX_PROXY);
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
 * @param config - 配置访问器，必须由调用方显式注入
 * @returns 是否应剥离
 * @example isStrippableOutboundHeader("Proxy-Foo", "bar", config) // => true
 * @example isStrippableOutboundHeader("Authorization", "Bearer target-token", config) // => false（视账号表而定）
 */
export function isStrippableOutboundHeader(
  name: string,
  value: string | string[] | undefined,
  config: ConfigAccessor,
): boolean {
  const lower = name.toLowerCase();
  if (isProxyHeaderName(lower)) {
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
 * @param config - 配置访问器，必须由调用方显式注入
 * @returns 同一对象（已删除代理头）
 * @example stripProxyHeaders({ "Proxy-Authorization": "Basic xxx", "Host": "example.com" }, config) // => { Host: ... }
 */
export function stripProxyHeaders<H extends Record<string, string | string[] | undefined>>(
  h: H,
  config: ConfigAccessor,
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
 * @param config - 配置访问器，必须由调用方显式注入
 * @returns 净化后的新头字典
 * @example sanitizeHeaders(req.headers, config) // => { host: "...", connection: "close", ... }（无 proxy 头）
 */
export function sanitizeHeaders(
  h: Record<string, string | string[] | undefined>,
  config: ConfigAccessor,
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
 * @param config - 配置访问器，必须由调用方显式注入
 * @returns 是否为代理凭证（鉴权未启用/类型非 basic|uid|jwt 时恒为 false；jwt 模式不要求账号表非空）
 * @example isProxyCredentialValue("Basic dXNlcjpwYXNz", config) // 视配置与 users.json 而定
 * @example isProxyCredentialValue("Bearer eyJ...", config) // jwt 模式：内置 HS256 验签通过才为 true
 */
export function isProxyCredentialValue(value: string, config: ConfigAccessor): boolean {
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
