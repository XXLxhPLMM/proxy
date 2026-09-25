/**
 * @fileoverview 上游标准 URL 的校验与拆项（`UPSTREAM_URL` 字段契约）
 * @module config/schema/upstream-url
 * @description
 * `scheme://[user:pass@]host[:port]` 的唯一解析/拆项实现，供两处使用：
 * - `schema/fields.ts` 的 `FIELDS.upstreamUrl.parse`（校验，非法直接阻止启动）
 * - `normalize/upstream.ts:applyUpstreamUrlToConfig`（把 URL 拆为 `upstreamProtocol` /
 *   `upstreamSecure` / `upstreamHost` / `upstreamPort` / `upstreamUsername` /
 *   `upstreamPassword` 六个 granular 字段）
 *
 * 为什么住在 config（而不是 utils）：
 * - 它只服务 `UPSTREAM_URL` 这一个配置字段，是配置契约的一部分；通用工具目录不该知道
 *   「上游」这个业务概念，也不该为此反向依赖 `@/core/types`（`ProxyProtocol`）。
 * - 依赖方向：`config/schema → core/types`（纯类型）+ `utils/constants`（缺省端口），
 *   全单向，无环。
 *
 * 设计要点：
 * - 纯函数零 IO：不依赖 store / 文件系统，仅依赖 `URL` 与 `ProxyProtocol` 类型，便于单测。
 * - Scheme 白名单映射：`UPSTREAM_SCHEMES` 统一描述 `protocol / secure / 缺省端口`，
 *   新增上游类型只需加一行；http/https 的缺省端口取自 `utils/constants` 的
 *   `DEFAULT_PORT_HTTP` / `DEFAULT_PORT_HTTPS`，**不重复第二份端口常量**。
 * - 严格代理语义：拒绝 `path / query / hash`（代理端点无路径语义），避免把 `http://host/path` 误当上游。
 * - 大小写不敏感：`url.protocol` 统一 `toLowerCase()` 后查表。
 * - 容错解码：`userinfo` 为百分号编码，`decodeURIComponent` 失败时原样保留（WHATWG URL 对非法序列宽松）。
 *
 * 使用示例：
 * ```ts
 * import { parseUpstreamUrl, applyUpstreamUrl } from "@/config/schema/upstream-url.js";
 *
 * parseUpstreamUrl("https://user:pass@proxy.example.com:8443"); // 原串
 * parseUpstreamUrl("https://proxy.example.com/path");           // undefined（带 path 非法）
 * parseUpstreamUrl("ftp://proxy.example.com");                 // undefined（scheme 非白名单）
 *
 * const resolved: Record<string, unknown> = {};
 * applyUpstreamUrl(resolved, "socks5://alice:secret@127.0.0.1:1080");
 * // resolved = { upstreamProtocol:"socks5", upstreamSecure:false, upstreamHost:"127.0.0.1",
 * //              upstreamPort:1080, upstreamUsername:"alice", upstreamPassword:"secret" }
 * ```
 */

import type { ProxyProtocol } from "@/core/types/proxy.js";
import { DEFAULT_PORT_HTTP, DEFAULT_PORT_HTTPS } from "@/utils/constants/index.js";

/**
 * 上游 URL scheme → 协议元数据映射
 *
 * @description
 * 键为 `URL.protocol` 的小写形式（含冒号），值为三元组：
 * - `protocol` 归一后的 `ProxyProtocol`（供 `upstreamProtocol` 使用）；
 * - `secure` 是否为 TLS（供 `upstreamSecure` 使用）；
 * - `port` 缺省端口（URL 未显式带端口时补齐）。
 *
 * 覆盖（与 ProxyProtocol 同名，无别名）：`http` / `https` / `socks4` / `socks5` /
 * `sockss4` / `sockss5`。http/https 的缺省端口引 `utils/constants`，SOCKS 系列无
 * 通用缺省端口常量（1080 / 443 随明文与 TLS 而变），就地给出。
 */
const UPSTREAM_SCHEMES: Record<string, { protocol: ProxyProtocol; secure: boolean; port: number }> =
  {
    "http:": { protocol: "http", secure: false, port: DEFAULT_PORT_HTTP },
    "https:": { protocol: "https", secure: true, port: DEFAULT_PORT_HTTPS },
    "socks4:": { protocol: "socks4", secure: false, port: 1080 },
    "socks5:": { protocol: "socks5", secure: false, port: 1080 },
    "sockss4:": { protocol: "sockss4", secure: true, port: 443 },
    "sockss5:": { protocol: "sockss5", secure: true, port: 443 },
  };

/** 合法 TCP 端口下界（0 与负数视为非法） */
const MIN_PORT = 1;

/** 合法 TCP 端口上界 */
const MAX_PORT = 65535;

/**
 * 解析并校验标准上游 URL（FIELDS 表的 parse 校验器，非法即阻止启动）
 *
 * @description
 * 校验规则（任一失败返回 `undefined`，由调用方决定抛错阻止启动）：
 * 1) 非空（trim 后非空）；
 * 2) `new URL(s)` 可解析；
 * 3) `protocol` 在 `UPSTREAM_SCHEMES` 白名单内；
 * 4) `hostname` 非空；
 * 5) 无 `path / query / hash`（`pathname` 仅允许 `"/"` 或 `""`，`search/hash` 必须为空；代理端点无路径语义）；
 * 6) 显式 `port` 若存在则需在 1-65535。
 * 合法时原样返回输入串（保留原始大小写与编码），非法返回 `undefined`。
 *
 * @param v - 待校验的原始字符串（来自 CLI / env）
 * @returns 合法返回原串（trim 后的原串），非法返回 `undefined`
 * @example
 * ```ts
 * parseUpstreamUrl("http://proxy.example.com");                // "http://proxy.example.com"
 * parseUpstreamUrl("https://user:p%40ss@host:8443");           // "https://user:p%40ss@host:8443"
 * parseUpstreamUrl("socks5://127.0.0.1");                      // "socks5://127.0.0.1"
 * parseUpstreamUrl("socks5://[::1]:1080");                     // "socks5://[::1]:1080"（IPv6 字面量合法，存储时剥括号）
 * parseUpstreamUrl("https://host/path");                       // undefined（带 path）
 * parseUpstreamUrl("https://host?x=1");                        // undefined（带 query）
 * parseUpstreamUrl("ftp://host");                              // undefined（非法 scheme）
 * parseUpstreamUrl("https://host:99999");                      // undefined（端口越界）
 * parseUpstreamUrl("");                                        // undefined（空串）
 * ```
 */
export function parseUpstreamUrl(v: string): string | undefined {
  const s = v.trim();
  if (!s) return undefined;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return undefined;
  }
  const meta = UPSTREAM_SCHEMES[url.protocol.toLowerCase()];
  if (!meta || !url.hostname) return undefined;
  // 特殊 scheme（http/https）空路径为 "/"，非特殊 scheme（socks5/tls）为 ""，都算无 path
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return undefined;
  if (url.port !== "" && !(Number(url.port) >= MIN_PORT && Number(url.port) <= MAX_PORT))
    return undefined;
  return s;
}

/**
 * 上游 URL 拆项写回至 resolved 表
 *
 * @description
 * 前置条件：`raw` 已通过 `parseUpstreamUrl` 校验（`applyUpstreamUrlToConfig` 中先 parse 后 apply）。
 * 将 `scheme://[user:pass@]host[:port]` 拆为 6 个 granular 字段并写入 `resolved`：
 * - `upstreamProtocol` / `upstreamSecure` / `upstreamPort` 来自 `UPSTREAM_SCHEMES`；
 * - `upstreamHost` 来自 `hostname`（IPv6 字面量剥掉方括号：`[::1]` → `::1`，
 *   否则括号会进 `net.connect`/DNS 导致解析失败）；
 * - `upstreamUsername` / `upstreamPassword` 来自 `userinfo`，经 `decodeURIComponent` 解码，失败则原样保留。
 * 未显式带端口时按 `UPSTREAM_SCHEMES` 表补缺省端口。
 *
 * @param resolved - 待写入的目标表（通常是 `applyUpstreamUrlToConfig` 里的 resolved 表）
 * @param raw - 已校验的上游 URL 原串
 * @returns void（直接修改 `resolved`）
 * @example
 * ```ts
 * const r: Record<string, unknown> = {};
 * applyUpstreamUrl(r, "https://alice:se%20cret@proxy.example.com");
 * // r.upstreamProtocol === "https"
 * // r.upstreamSecure === true
 * // r.upstreamHost === "proxy.example.com"
 * // r.upstreamPort === 443（缺省）
 * // r.upstreamUsername === "alice"
 * // r.upstreamPassword === "se cret"（已解码）
 * ```
 */
export function applyUpstreamUrl(resolved: Record<string, unknown>, raw: string): void {
  const url = new URL(raw.trim());
  const meta = UPSTREAM_SCHEMES[url.protocol.toLowerCase()] as {
    protocol: ProxyProtocol;
    secure: boolean;
    port: number;
  };
  resolved.upstreamProtocol = meta.protocol;
  resolved.upstreamSecure = meta.secure;
  // WHATWG URL 对 IPv6 字面量保留方括号（[::1]），而 net.connect/DNS 只认裸地址，存储前剥掉
  const hostname = url.hostname;
  resolved.upstreamHost =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  resolved.upstreamPort = url.port === "" ? meta.port : Number(url.port);
  try {
    resolved.upstreamUsername = decodeURIComponent(url.username);
    resolved.upstreamPassword = decodeURIComponent(url.password);
  } catch {
    resolved.upstreamUsername = url.username;
    resolved.upstreamPassword = url.password;
  }
}
