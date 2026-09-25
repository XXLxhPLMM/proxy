/**
 * @fileoverview 上游标准 URL 工具 (upstream-url.ts)
 *
 * 职责：
 * - 提供 `scheme://[user:pass@]host[:port]` 的严格校验与拆项写回能力，供 `loader.ts` 的
 *   `UPSTREAM_URL` 字段使用。
 * - 在 `loadConfig()` 中作为 `FIELDS` 表的 `parse` 与后续 `applyUpstreamUrl` 的两段式调用：
 *   先校验合法性（非法直接阻止启动），再将 URL 拆为 `upstreamProtocol` / `upstreamSecure` /
 *   `upstreamHost` / `upstreamPort` / `upstreamUsername` / `upstreamPassword` 六个 granular 字段。
 *
 * 设计要点：
 * - 纯函数零 IO：不依赖 `store` / `loader` / `fs`，仅依赖 `URL` 与 `ProxyProtocol` 类型，便于单测。
 * - Scheme 白名单映射：`UPSTREAM_SCHEMES` 统一描述 `protocol / secure / 缺省端口`，新增上游类型只需加一行。
 * - 严格代理语义：拒绝 `path / query / hash`（代理端点无路径语义），避免把 `http://host/path` 误当上游。
 * - 大小写不敏感：`url.protocol` 统一 `toLowerCase()` 后查表。
 * - 容错解码：`userinfo` 为百分号编码，`decodeURIComponent` 失败时原样保留（WHATWG URL 对非法序列宽松）。
 * - 与 `loader` 的协作：`parseUpstreamUrl` 用作 `FIELDS` 的 `parse`（返回原串或 undefined），
 *   `applyUpstreamUrl` 在 `resolved.upstreamUrl` 非空时整体覆盖 granular 字段。
 *
 * 使用示例：
 * ```ts
 * import { parseUpstreamUrl, applyUpstreamUrl } from "@/utils/upstream-url.js";
 *
 * // 校验
 * parseUpstreamUrl("https://user:pass@proxy.example.com:8443"); // 原串
 * parseUpstreamUrl("https://proxy.example.com/path");           // undefined（带 path 非法）
 * parseUpstreamUrl("ftp://proxy.example.com");                 // undefined（scheme 非白名单）
 *
 * // 拆项写回（通常由 loader 自动调用）
 * const resolved: Record<string, unknown> = {};
 * applyUpstreamUrl(resolved, "socks5://alice:secret@127.0.0.1:1080");
 * // resolved = { upstreamProtocol:"socks5", upstreamSecure:false, upstreamHost:"127.0.0.1",
 * //              upstreamPort:1080, upstreamUsername:"alice", upstreamPassword:"secret" }
 *
 * // 缺省端口
 * applyUpstreamUrl(resolved, "https://proxy.example.com");
 * // upstreamPort 自动补 443
 * ```
 *
 * 关联模块：
 * - `src/config/fields.ts` — `FIELDS: upstreamUrl` 的 `parse`；`src/config/runtime-config.ts` 是
 *   `applyUpstreamUrl` 的统一调用方，`loadConfig` 与纯内存 runtime 都经它归一化。
 * - `src/core/types/proxy.ts` — `ProxyProtocol` 类型来源。
 */

import type { ProxyProtocol } from "@/core/types/proxy.js";

/**
 * 上游 URL scheme → 协议元数据映射
 *
 * @description
 * 键为 `URL.protocol` 的小写形式（含冒号），值为三元组：
 * - `protocol` 归一后的 `ProxyProtocol`（供 `upstreamProtocol` 使用）；
 * - `secure` 是否为 TLS（供 `upstreamSecure` 使用）；
 * - `port` 缺省端口（URL 未显式带端口时补齐）。
 *
 * 覆盖（与 ProxyProtocol 同名，无别名）：`http:80` / `https:443` /
 * `socks4,socks5:1080` / `sockss4,sockss5:443`。
 */
const UPSTREAM_SCHEMES: Record<string, { protocol: ProxyProtocol; secure: boolean; port: number }> =
  {
    "http:": { protocol: "http", secure: false, port: 80 },
    "https:": { protocol: "https", secure: true, port: 443 },
    "socks4:": { protocol: "socks4", secure: false, port: 1080 },
    "socks5:": { protocol: "socks5", secure: false, port: 1080 },
    "sockss4:": { protocol: "sockss4", secure: true, port: 443 },
    "sockss5:": { protocol: "sockss5", secure: true, port: 443 },
  };

/**
 * 解析并校验标准上游 URL（FIELDS 表的 parse 校验器，非法即阻止启动）
 *
 * @description
 * 校验规则（任一失败返回 `undefined`，由 `loader` 决定抛错阻止启动）：
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
  if (url.port !== "" && !(Number(url.port) >= 1 && Number(url.port) <= 65535)) return undefined;
  return s;
}

/**
 * 上游 URL 拆项写回至 resolved 表
 *
 * @description
 * 前置条件：`raw` 已通过 `parseUpstreamUrl` 校验（`loadConfig` 中先 `parse` 后 `apply`）。
 * 将 `scheme://[user:pass@]host[:port]` 拆为 6 个 granular 字段并写入 `resolved`：
 * - `upstreamProtocol` / `upstreamSecure` / `upstreamPort` 来自 `UPSTREAM_SCHEMES`；
 * - `upstreamHost` 来自 `hostname`（IPv6 字面量剥掉方括号：`[::1]` → `::1`，
 *   否则括号会进 `net.connect`/DNS 导致解析失败）；
 * - `upstreamUsername` / `upstreamPassword` 来自 `userinfo`，经 `decodeURIComponent` 解码，失败则原样保留。
 * 未显式带端口时按 `UPSTREAM_SCHEMES` 表补缺省端口。
 *
 * @param resolved - 待写入的目标表（通常为 `loadConfig` 中的 `resolved: Record<string, unknown>`）
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
 *
 * const r2: Record<string, unknown> = {};
 * applyUpstreamUrl(r2, "socks5://127.0.0.1:1080");
 * // r2.upstreamProtocol === "socks5", r2.upstreamPort === 1080
 *
 * const r3: Record<string, unknown> = {};
 * applyUpstreamUrl(r3, "socks5://[::1]:1080");
 * // r3.upstreamHost === "::1"（方括号已剥离）, r3.upstreamPort === 1080
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
