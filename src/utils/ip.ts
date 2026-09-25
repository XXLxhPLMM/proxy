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

/** 本地绑定事实：两个字段各自可缺失（取不到就由调用方决定回退） */
export interface SocketLocalBinding {
  /** localAddress 原样文本（可能是 v4-mapped IPv6 `::ffff:a.b.c.d`，由调用方归一） */
  address?: string;
  /** localPort；非整数/越界一律视为缺失 */
  port?: number;
}

/**
 * 取套接字本地绑定地址/端口（与 `getSocketAddress` 同形：鸭子类型嗅探，不强转 net.Socket）
 * @description SOCKS 成功应答的 BND.ADDR/BND.PORT（RFC1928 §6）要填服务端实际绑定地址，
 * 事实只存在于**出站 socket** 的 localAddress/localPort 上；取不到时返回空对象由调用方回退。
 * @param sock - 任意可能的套接字（真实 net/tls socket 或测试替身）
 * @returns 取到的本地绑定事实；缺失字段不出现（绝不返回 "unknown" 哨兵，那会污染协议字段）
 * @example getSocketLocalBinding(sock) // => { address: "::ffff:127.0.0.1", port: 54321 }
 */
export function getSocketLocalBinding(sock: unknown): SocketLocalBinding {
  if (typeof sock !== "object" || sock === null) {
    return {};
  }
  const local = sock as { localAddress?: unknown; localPort?: unknown };
  const binding: SocketLocalBinding = {};

  if (typeof local.localAddress === "string" && local.localAddress) {
    binding.address = local.localAddress;
  }
  if (
    typeof local.localPort === "number" &&
    Number.isInteger(local.localPort) &&
    local.localPort >= 0 &&
    local.localPort <= 0xffff
  ) {
    binding.port = local.localPort;
  }

  return binding;
}

/**
 * 取套接字远端地址（统一 "unknown" 哨兵）
 * @description 转发层多处需要「客户端地址」展示（守卫路由、SOCKS 审计）：
 * 原先是各自内联的 `(socket as unknown as {remoteAddress?: string}).remoteAddress ?? "unknown"`，
 * 收敛到此一处，避免类型强转散落。哨兵 "unknown" 而非空串：日志/审计可区分「取不到」与「取到空值」
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
 * 通配监听地址：IPv4 0.0.0.0 与 IPv6 :: / 0:0:0:0:0:0:0:0 等价（均表示所有接口）
 */
const WILDCARD_HOSTS = ["0.0.0.0", "::", "0:0:0:0:0:0:0:0"];

/**
 * loopback 别名族：这些都指向同一个本机回环接口
 */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * 归一主机名，供自环比对
 * @description 小写、剥方括号、去末尾点；v4-mapped IPv6（`::ffff:127.0.0.1` 与十六进制形态 `::ffff:7f00:1`）还原为点分 IPv4
 * @param raw - 原始主机名/IP
 * @returns 归一后的主机名
 * @example normalizeLoopbackHost("[::1]") // => "::1"
 * @example normalizeLoopbackHost("::ffff:127.0.0.1") // => "127.0.0.1"
 * @example normalizeLoopbackHost("localhost.") // => "localhost"
 */
function normalizeLoopbackHost(raw: string): string {
  let h = raw.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  while (h.endsWith(".")) {
    h = h.slice(0, -1);
  }
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (dotted) {
    return dotted[1];
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return h;
}

/**
 * 检测目标地址是否指向代理自身，防止循环转发
 * （纯函数，host/port 全参数化）
 * 规则：
 * 1. 端口不同 → 不是循环
 * 2. 代理监听通配地址（0.0.0.0 / ::）→ 任何目标 + 相同端口都是循环
 * 3. 目标与监听地址归一后完全相等 → 循环
 * 4. 双方都属 loopback 别名族（localhost / 127.0.0.1 / ::1 / v4-mapped ::ffff:127.0.0.1）→ 循环
 * 5. 目标是通配地址而监听在 loopback → 循环（connect(0.0.0.0) 实际连到 127.0.0.1）
 * @param targetHost - 目标主机名/IP
 * @param targetPort - 目标端口
 * @param selfHost - 代理监听地址
 * @param selfPort - 代理监听端口
 * @returns 是否构成自环
 * @example isSelfLoopAddr("example.com", 8080, "0.0.0.0", 8080) // => true
 * @example isSelfLoopAddr("::ffff:127.0.0.1", 8080, "127.0.0.1", 8080) // => true
 * @example isSelfLoopAddr("127.0.0.1", 8080, "192.168.1.5", 8080) // => false
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

  const target = normalizeLoopbackHost(targetHost);
  const self = normalizeLoopbackHost(selfHost);

  if (WILDCARD_HOSTS.includes(self)) {
    return true;
  }

  if (target === self) {
    return true;
  }

  const selfLoopback = LOOPBACK_HOSTS.includes(self);
  const targetLoopback = LOOPBACK_HOSTS.includes(target);

  if (selfLoopback && targetLoopback) {
    return true;
  }

  // 目标是通配地址：内核按 loopback 处理，此时只要代理就监听在 loopback 就是自环
  return selfLoopback && WILDCARD_HOSTS.includes(target);
}
