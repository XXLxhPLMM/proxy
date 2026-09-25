/**
 * @fileoverview 目标地址解析：host 白名单校验、authority 拆分、请求目标三元组
 * @module core/helpers/target
 * @description
 * 代理把「一堆文本」变成「一个能拨的 host:port」的**唯一**收口：所有协议入口
 * （http 绝对 URL / Host 头、CONNECT authority、SOCKS 域名字节）都走这里。
 *
 * 职责：
 * - 白名单：`isValidTargetHost`（字符集 + 255B 上限，防 CONNECT/SOCKS 报文注入与长度域截断）
 * - absolute-form：`absoluteFormAuthority`（RFC 7230 §5.4 权威值）、`parseTargetParts`
 * - authority 拆分：私有 `splitAuthority`（`host` / `host:port` / `[v6]` / `[v6]:port`）、
 *   `parseAuthority`（CONNECT 专用，缺省 443）
 * - 拼装：`formatAuthority`（**补回** IPv6 方括号，与解析侧刻意相反）
 *
 * 不负责（**本文件的不变量**：零 `ConfigAccessor`、零文件 IO、零日志）：
 * - 不决定拨哪里、怎么路由（`route.ts`）、不发事件
 * - 不做 ACL 名单判定（`core/access-control.ts`）
 * - 不拼 CONNECT 报文（`wire.ts` 只调本文件的 `isValidTargetHost` / `formatAuthority`）
 *
 * 依赖：`node:net` + `@/utils/constants/index.js` + `@/utils/host-text.js`。本文件是
 * `helpers/` 的叶子，不引任何同目录模块。IPv6 方括号的**解析侧**归一走 `host-text.ts` 的
 * 原子（`stripIpBrackets`），`formatAuthority` 是全项目唯一的**反向**（补回括号）。
 *
 * 使用示例：
 * ```ts
 * import { parseTargetParts, formatAuthority } from "@/core/helpers/target.js";
 *
 * const parts = parseTargetParts(req.url!, req.headers.host, "http:"); // => { host, port, path }
 * formatAuthority("::1", 443); // => "[::1]:443"
 * ```
 */

import net from "node:net";
import {
  DEFAULT_PORT_HTTP,
  DEFAULT_PORT_HTTPS,
  MAX_TARGET_HOST_BYTES,
  RE_ABSOLUTE_URL,
  RE_DIGITS,
  RE_VALID_TARGET_HOST,
} from "@/utils/constants/index.js";
import { stripIpBrackets } from "@/utils/host-text.js";

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
      // URL 的 hostname 对 IPv6 字面量保留方括号（`[::1]`），剥掉供 net.connect 直用
      const host = stripIpBrackets(u.hostname);
      const defaultPort = u.protocol === "https:" ? DEFAULT_PORT_HTTPS : DEFAULT_PORT_HTTP;
      let port: number | null = u.port ? Number(u.port) : null;
      if (port !== null && (port < MIN_PORT || port > MAX_PORT)) {
        return null;
      }
      // RFC 7230 §5.4：absolute-form 的权威值只来自 request-target，Host 头一律忽略——
      // 用 Host 补端口会让 host 与 port 来自不同输入源（虚拟主机/端口混淆）
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
