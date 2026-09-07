/**
 * 上游标准 URL 解析 - scheme://[user:pass@]host[:port] 的严格校验与拆项写回
 * 职责：scheme 白名单映射、URL 合法性校验、拆项到 granular 配置字段
 * 设计：纯函数零 IO，不依赖 store/loader；loader 仅做接线（FIELDS 行 + initConfig 拆写）
 */

import type { ProxyProtocol } from "@/core/types/proxy.js";

/** 上游 URL scheme -> [协议, 是否 TLS, 缺省端口] */
const UPSTREAM_SCHEMES: Record<string, { protocol: ProxyProtocol; secure: boolean; port: number }> = {
  "http:": { protocol: "http", secure: false, port: 80 },
  "https:": { protocol: "https", secure: true, port: 443 },
  "socks:": { protocol: "socks5", secure: false, port: 1080 },
  "socks4:": { protocol: "socks4", secure: false, port: 1080 },
  "socks5:": { protocol: "socks5", secure: false, port: 1080 },
  "sockss:": { protocol: "sockss5", secure: true, port: 443 },
  "sockss4:": { protocol: "sockss4", secure: true, port: 443 },
  "sockss5:": { protocol: "sockss5", secure: true, port: 443 },
  "tls:": { protocol: "sockss5", secure: true, port: 443 },
};

/**
 * 解析标准上游 URL（strict 校验器）：scheme://[user:pass@]host[:port]
 * 校验：scheme 白名单、host 非空、端口 1-65535、拒绝 path/query/hash（代理端点无路径语义）
 * 合法返回原串，非法返回 undefined（env 值非法直接阻止启动）
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
 * 上游 URL 拆项写回：protocol/secure/host/port/username/password
 * 前置条件：raw 已通过 parseUpstreamUrl 校验（initConfig 中先 parse 后 apply）
 * userinfo 为百分号编码，解码失败（WHATWG URL 对非法序列宽松）时原样保留
 */
export function applyUpstreamUrl(resolved: Record<string, unknown>, raw: string): void {
  const url = new URL(raw.trim());
  const meta = UPSTREAM_SCHEMES[url.protocol.toLowerCase()] as { protocol: ProxyProtocol; secure: boolean; port: number };
  resolved.upstreamProtocol = meta.protocol;
  resolved.upstreamSecure = meta.secure;
  resolved.upstreamHost = url.hostname;
  resolved.upstreamPort = url.port === "" ? meta.port : Number(url.port);
  try {
    resolved.upstreamUsername = decodeURIComponent(url.username);
    resolved.upstreamPassword = decodeURIComponent(url.password);
  } catch {
    resolved.upstreamUsername = url.username;
    resolved.upstreamPassword = url.password;
  }
}
