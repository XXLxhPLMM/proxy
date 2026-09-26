/**
 * 入站请求事实提取 - 客户端真实 IP 与请求目标 authority
 * 职责：
 * - `getClientAddress`：X-Forwarded-For > X-Real-IP > Forwarded > socket 远端地址
 * - `getAuthority`：CONNECT 取 `req.url`（authority 在请求行），普通请求取 `Host` 头
 * 设计：
 * - 纯函数无 IO：不解析 body、不碰 socket 内部状态，只读 headers/url/method
 * - 头值可能是 `string[]`（重复头），统一取第一项
 * - 取不到时返回 `"unknown"` 哨兵：下游日志/审计要能区分「取不到」与「取到空值」
 * - 这两个值**仅供展示与审计**，ACL 的客户端 IP 判定刻意不看它们（可伪造，见 `src/config/AGENTS.md`）
 */

/** 可取地址的最小形状：真 IncomingMessage 与 AuthRequestLike 均满足 */
type AddressableReq = {
  headers: Record<string, string | string[] | undefined>;
  socket?: unknown;
};

import { RE_FORWARDED_FOR, RE_QUOTE_GLOBAL } from "@/utils/protocol/http.js";
import { getSocketAddress } from "@/utils/net/socket.js";

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
  return getSocketAddress(req.socket);
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
