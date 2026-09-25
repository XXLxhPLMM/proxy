/**
 * @fileoverview 上游协议映射与上游 Basic 凭证头
 * @module core/helpers/upstream
 * @description
 * `upstreamProtocol` 这一个配置键到「怎么拨、怎么握手、要不要 TLS、带不带凭证」的
 * **唯一**映射点。此前 http/tunnel/websocket/socks 四处各写一份四连等，最容易漂移。
 *
 * 职责：
 * - 协议判据：`isSocksProto`（SOCKS 系分流）/ `socksVersionOf`（握手版本）/
 *   `isTlsUpstreamProto`（TLS 承载，含 SOCKS over TLS 的 `sockss*`）
 * - 上游凭证：`upstreamAuthValue` / `upstreamAuthHeaderLine`（仅显式配置
 *   `upstreamUsername` 时携带；原先各转发器各自实现、两种格式存在漂移风险，收敛到此一处）
 *
 * 不负责：
 * - 不读 `upstreamHost`/`upstreamPort`（那是路由判定的产物，见 `route.ts`）
 * - 不做 TLS 握手、不发报文（`forward/dial.ts` / `wire.ts`）
 * - 不做客户端入站鉴权（`credentials.ts` / `core/auth.ts`）
 *
 * 依赖：`./credentials.js`（`encodeBasicCredentials`）+ `@/config/index.js`（类型）
 * + `@/utils/constants.js`。
 *
 * 使用示例：
 * ```ts
 * import { upstreamAuthHeaderLine, isSocksProto } from "@/core/helpers/upstream.js";
 *
 * // 分流：SOCKS 系走握手，其它走 CONNECT
 * if (isSocksProto(config.get("upstreamProtocol"))) {
 *   // ... 走 SOCKS 握手
 * }
 * raw = buildConnectRequest(host, port, upstreamAuthHeaderLine(config));
 * ```
 */

import { HEADER_NAME_PROXY_AUTHORIZATION, buildProxyAuthValue } from "@/utils/constants.js";
import type { ConfigAccessor } from "@/config/index.js";
import { encodeBasicCredentials } from "./credentials.js";

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
 * @param config - 配置访问器，必须由调用方显式注入
 * @returns 形如 `Basic dXNlcjpwYXNz` 的头值；未配置 upstreamUsername 返回 undefined
 * @example upstreamAuthValue(config) // => "Basic YWxpY2U6c2VjcmV0" | undefined
 */
export function upstreamAuthValue(config: ConfigAccessor): string | undefined {
  const u = config.get("upstreamUsername");

  if (!u) {
    return undefined;
  }

  return buildProxyAuthValue(encodeBasicCredentials(u, config.get("upstreamPassword")));
}

/**
 * 上游代理 Basic 凭证完整头行（`Proxy-Authorization: Basic ...`），供 CONNECT 报文拼接
 * @param config - 配置访问器，必须由调用方显式注入
 * @returns 头行字符串；未配置 upstreamUsername 返回 undefined
 * @example `buildConnectRequest(host, port, upstreamAuthHeaderLine(config))`
 */
export function upstreamAuthHeaderLine(config: ConfigAccessor): string | undefined {
  const value = upstreamAuthValue(config);

  return value ? `${HEADER_NAME_PROXY_AUTHORIZATION}: ${value}` : undefined;
}
