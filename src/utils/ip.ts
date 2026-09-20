/**
 * IP 工具函数 - 从请求中提取客户端 IP 与 authority
 * 职责：
 * - getClientAddress：获取客户端真实 IP
 *   支持直连与代理场景（X-Forwarded-For / X-Real-IP / Forwarded）
 * - getAuthority：获取请求目标 authority
 *   （CONNECT 用 url，普通请求用 Host 头）
 */

/** 可取地址的最小形状：真 IncomingMessage 与 AuthRequestLike 均满足 */
type AddressableReq = {
  headers: Record<string, string | string[] | undefined>;
  socket?: unknown;
};

import { RE_FORWARDED_FOR, RE_QUOTE_GLOBAL } from "./constants.js";

/** 从未知形状的套接字嗅探远端地址，非字符串一律视为缺失 */
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
  const v = raw.replace(RE_QUOTE_GLOBAL, "").trim();
  // 方括号形态：定位 "]" 取括号内地址，`[v6]:port` 的端口自然被排除
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    return end === -1 ? v.slice(1) : v.slice(1, end);
  }
  // 裸 IPv6（含 >=2 个冒号）：多冒号即地址本身，不做端口剥离
  if (v.split(":").length > 2) {
    return v;
  }
  // 裸 IPv4[:port]：仅当尾部为纯数字端口时剥离
  const idx = v.lastIndexOf(":");
  if (idx !== -1 && /^\d+$/.test(v.slice(idx + 1))) {
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

/**
 * 检测目标地址是否指向代理自身，防止循环转发
 * （纯函数，host/port 全参数化）
 * 规则：
 * 1. 端口不同 → 不是循环
 * 2. 代理监听通配地址（IPv4 0.0.0.0、IPv6 :: 及其展开形态 0:0:0:0:0:0:0:0）→
 *    任何目标 + 相同端口都是循环
 * 3. 代理监听具体 IP/域名 → 目标地址必须完全匹配才是循环
 *    （含 localhost 等价）
 * @param targetHost - 目标主机名/IP
 * @param targetPort - 目标端口
 * @param selfHost - 代理监听地址
 * @param selfPort - 代理监听端口
 * @returns 是否构成自环
 * @example isSelfLoopAddr("example.com", 8080, "0.0.0.0", 8080) // => true
 * @example isSelfLoopAddr("example.com", 8080, "::", 8080) // => true
 */
export function isSelfLoopAddr(
  targetHost: string,
  targetPort: number,
  selfHost: string,
  selfPort: number,
): boolean {
  if (targetPort !== selfPort) {
    return false;
  }

  const normalizedTarget = targetHost.toLowerCase();
  const normalizedSelf = selfHost.toLowerCase();

  // 本机地址别名（这些都指向同一个 loopback 接口）
  const localhostAliases = ["localhost", "127.0.0.1", "::1", "[::1]"];

  // 通配监听地址：IPv4 0.0.0.0 与 IPv6 :: / 0:0:0:0:0:0:0:0 等价（均表示所有接口）
  const wildcardHosts = ["0.0.0.0", "::", "0:0:0:0:0:0:0:0"];

  if (wildcardHosts.includes(normalizedSelf)) {
    return true;
  }

  if (normalizedTarget === normalizedSelf) {
    return true;
  }

  if (localhostAliases.includes(normalizedSelf) && localhostAliases.includes(normalizedTarget)) {
    return true;
  }

  return false;
}
