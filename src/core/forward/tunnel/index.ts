/**
 * tunnel/index - 隧道载体工厂
 * server 模式 → direct；client 模式按 upstreamProtocol 选 http/https/socks/tls
 */

import type { ProxyProtocol } from "@/core/types/proxy.js";
import type { AppConfig } from "@/config/store.js";
import { directTunnelHandler } from "./direct.js";
import { httpTunnelHandler } from "./http.js";
import { httpsTunnelHandler } from "./https.js";
import { socksTunnelHandler } from "./socks.js";
import { tlsTunnelHandler } from "./tls.js";
import type { TunnelHandler } from "./types.js";

export function getTunnelHandler(mode: AppConfig["proxyMode"], upstreamProtocol: ProxyProtocol): TunnelHandler {
  if (mode !== "client") return directTunnelHandler;
  switch (upstreamProtocol) {
    case "http": return httpTunnelHandler;
    case "https": return httpsTunnelHandler;
    case "socks": return socksTunnelHandler;
    case "tls": return tlsTunnelHandler;
    default: return directTunnelHandler;
  }
}
