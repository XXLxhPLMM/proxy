/**
 * @fileoverview 客户端地址提取：从入站请求 / 套接字取「对端地址」与「请求目标 authority」
 * @module utils/ip
 * @description
 * 职责（三件同源的事，都只做**取值与轻度归一**，不做任何策略判定）：
 * - `getClientAddress`：客户端真实 IP（X-Forwarded-For > X-Real-IP > Forwarded > socket）
 * - `getAuthority`：请求目标 authority（CONNECT 用 url，普通请求用 Host 头）
 * - `getSocketAddress`：套接字远端地址（统一 `"unknown"` 哨兵）
 *
 * 不负责（**本文件的不变量**：零配置依赖、零 IO、零日志）：
 * - **不做**自环判定（防循环转发）：`isSelfLoopAddr` 住在 `@/core/helpers/self-loop.js`，
 *   它是转发策略而非地址原语，且归一链要与 ACL 名单一致
 * - **不做**名单匹配：`ipMatches` / `hostMatches` 住在 `@/config/files/rules/index.js`
 *   （acl.json 的规则层），判定在 `@/core/access-control.js`
 * - 不解析目标 authority：`parseTargetParts` / `parseAuthority` 在 `@/core/helpers/target.js`
 *
 * 依赖：`@/utils/constants/index.js`（预编译正则）+ `@/utils/host-text.js`（文本归一原子）。
 */

/** 可取地址的最小形状：真 IncomingMessage 与 AuthRequestLike 均满足 */
type AddressableReq = {
  headers: Record<string, string | string[] | undefined>;
  socket?: unknown;
};

import { RE_DIGITS, RE_FORWARDED_FOR, RE_QUOTE_GLOBAL } from "./constants/index.js";
import { lowerTrim, stripIpBrackets } from "./host-text.js";

/** 从未知形状的套接字嗅探远端地址，非字符串或空串一律视为缺失 */
function socketAddress(sock: unknown): string | undefined {
  if (typeof sock === "object" && sock !== null && "remoteAddress" in sock) {
    const v = (sock as { remoteAddress?: unknown }).remoteAddress;
    if (typeof v === "string" && v) {
      return v;
    }
  }
  return undefined;
}

/**
 * 取套接字远端地址（统一 "unknown" 哨兵）
 * @description 转发层多处需要「客户端地址」展示（守卫路由、SOCKS 审计），一律走这里、
 * 不要各自内联 `(socket as unknown as {remoteAddress?: string}).remoteAddress ?? "unknown"`
 * （类型强转会散落到处）。哨兵 "unknown" 而非空串：日志/审计可区分「取不到」与「取到空值」
 * @param sock - 任意可能的套接字（真实 net/tls socket 或测试替身）
 * @returns remoteAddress 为非空字符串时返回它，否则返回 "unknown"
 * @example getSocketAddress(socket) // => "127.0.0.1" | "unknown"
 */
export function getSocketAddress(sock: unknown): string {
  return socketAddress(sock) ?? "unknown";
}

/**
 * 归一 Forwarded `for=` 取值为裸 IP（去掉端口与方括号）
 * 规则：
 * - 方括号形态 `[v6]` / `[v6]:port` → 取方括号内地址（连带剥端口）
 * - 裸 IPv4 `a.b.c.d[:port]` → 去尾部 `:<digits>`
 * - 裸 IPv6（多冒号、无方括号）→ 视为地址本身，原样返回
 * @param raw - Forwarded for= 的原始捕获值（可能含引号）
 * @returns 归一后的裸 IP 字符串
 * @example normalizeForwardedAddr('"[2001:db8::1]:5678"') // => "2001:db8::1"
 * @example normalizeForwardedAddr("192.0.2.43:5678") // => "192.0.2.43"
 * @example normalizeForwardedAddr("2001:db8::1") // => "2001:db8::1"
 */
function normalizeForwardedAddr(raw: string): string {
  // 去引号兼容 quoted-string（for="[2001:db8::1]"）后交给统一文本原子
  const v = lowerTrim(raw.replace(RE_QUOTE_GLOBAL, ""));
  // 方括号形态：[v6] 或 [v6]:port —— 原子取 `]` 之前内容，端口段自然被排除
  if (v.startsWith("[")) {
    return stripIpBrackets(v);
  }
  // 裸 IPv6（含 >=2 个冒号）：地址本身，不做端口剥离
  if (v.split(":").length > 2) {
    return v;
  }
  // 裸 IPv4[:port]：仅当尾部为纯数字端口时剥离（端口合法性判据统一走 RE_DIGITS）
  const idx = v.lastIndexOf(":");
  if (idx !== -1 && RE_DIGITS.test(v.slice(idx + 1))) {
    return v.slice(0, idx);
  }
  return v;
}

/**
 * 获取客户端真实 IP 地址
 * 优先级：X-Forwarded-For > X-Real-IP > Forwarded > socket.remoteAddress
 * Forwarded 的 `for=` 值会归一为裸 IP（剥去 `[v6]` 方括号与 `:port`）
 * @param req - 入站请求
 * @returns 客户端 IP 地址
 * @example headers.forwarded = 'for="[2001:db8::1]:5678"' // => "2001:db8::1"
 */
export function getClientAddress(req: AddressableReq): string {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const first = (Array.isArray(xff) ? xff[0] : xff).split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  const xri = req.headers["x-real-ip"];
  if (xri) {
    const addr = Array.isArray(xri) ? xri[0] : xri;
    if (addr) {
      return addr.trim();
    }
  }

  // RFC7239：for= 后取至 ;/,/空白为止；去引号兼容 quoted-string（如 for="[2001:db8::1]"）
  const forwarded = req.headers["forwarded"];
  if (forwarded) {
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const forMatch = raw.match(RE_FORWARDED_FOR);
    if (forMatch?.[1]) {
      return normalizeForwardedAddr(forMatch[1]);
    }
  }

  // 哨兵 "unknown" 而非空串：下游日志/审计可区分“取不到”与“取到空值”，防空串被当合法 IP
  return socketAddress(req.socket) ?? "unknown";
}

/**
 * 获取请求目标 authority
 * - CONNECT 请求：authority 在 `req.url`（host:port），此时 Host 不可信 → 优先 url
 * - 普通请求：`req.url` 只是 path（如 "/x"），权威 authority 在 Host 头 → Host 优先，url 兜底
 * @param req - 入站请求（可带 `method` 以区分 CONNECT）
 * @returns authority 字符串（如 "example.com:443" 或 "example.com"）
 * @example getAuthority({ method: "CONNECT", url: "example.com:443" }) // => "example.com:443"
 * @example getAuthority({ method: "GET", url: "/x", headers: { host: "example.com" } }) // => "example.com"
 */
export function getAuthority(req: AddressableReq & { url?: string; method?: string }): string {
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  if (req.method === "CONNECT") {
    return req.url ?? host ?? "";
  }
  return host ?? req.url ?? "";
}
