/**
 * IP 工具函数 - 从请求中提取客户端 IP 与 authority
 * 职责：
 * - getClientAddress：获取客户端真实 IP，支持直连与代理场景（X-Forwarded-For / X-Real-IP / Forwarded）
 * - getAuthority：获取请求目标 authority（CONNECT 用 url，普通请求用 Host 头）
 */

/** 可取地址的最小形状：真 IncomingMessage 与 AuthRequestLike 均满足 */
type AddressableReq = {
  headers: Record<string, string | string[] | undefined>;
  socket?: unknown;
};

/** 从未知形状的套接字嗅探远端地址，非字符串一律视为缺失 */
function socketAddress(sock: unknown): string | undefined {
  if (typeof sock === "object" && sock !== null && "remoteAddress" in sock) {
    const v = (sock as { remoteAddress?: unknown }).remoteAddress;
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * 获取客户端真实 IP 地址
 * 优先级：X-Forwarded-For > X-Real-IP > Forwarded > socket.remoteAddress
 * @param req - 入站请求
 * @returns 客户端 IP 地址
 */
export function getClientAddress(req: AddressableReq): string {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const first = (Array.isArray(xff) ? xff[0] : xff).split(",")[0]?.trim();
    if (first) return first;
  }

  const xri = req.headers["x-real-ip"];
  if (xri) {
    const addr = Array.isArray(xri) ? xri[0] : xri;
    if (addr) return addr.trim();
  }

  const forwarded = req.headers["forwarded"];
  if (forwarded) {
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const forMatch = raw.match(/for=([^;,\s]+)/i);
    if (forMatch?.[1]) return forMatch[1].replace(/"/g, "");
  }

  return socketAddress(req.socket) ?? "unknown";
}

/**
 * 获取请求目标 authority
 * - CONNECT 请求：authority 在 req.url（host:port）
 * - 普通请求：authority 在 Host 头
 * @param req - 入站请求
 * @returns authority 字符串（如 "example.com:443" 或 "example.com"）
 */
export function getAuthority(req: AddressableReq & { url?: string }): string {
  const host = req.headers.host;
  return req.url ?? (Array.isArray(host) ? host[0] : host) ?? "";
}

/**
 * 检测目标地址是否指向代理自身，防止循环转发（纯函数，host/port 全参数化）
 * 规则：
 * 1. 端口不同 → 不是循环
 * 2. 代理监听 0.0.0.0（所有接口）→ 任何目标+相同端口都是循环
 * 3. 代理监听具体 IP/域名 → 目标地址必须完全匹配才是循环（含 localhost 等价）
 */
export function isSelfLoopAddr(
  targetHost: string,
  targetPort: number,
  selfHost: string,
  selfPort: number,
): boolean {
  // 端口不同，肯定不是循环
  if (targetPort !== selfPort) return false;

  const normalizedTarget = targetHost.toLowerCase();
  const normalizedSelf = selfHost.toLowerCase();

  // 本机地址别名（这些都指向同一个 loopback 接口）
  const localhostAliases = ["localhost", "127.0.0.1", "::1", "[::1]"];

  // 情况1：代理监听 0.0.0.0（所有接口）→ 任何目标+相同端口都是循环
  if (normalizedSelf === "0.0.0.0") {
    return true;
  }

  // 情况2：目标地址与监听地址完全相同
  if (normalizedTarget === normalizedSelf) {
    return true;
  }

  // 情况3：监听的是 localhost 别名，目标也是 localhost 别名
  if (localhostAliases.includes(normalizedSelf) && localhostAliases.includes(normalizedTarget)) {
    return true;
  }

  return false;
}
