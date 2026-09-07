/**
 * upstream/index - 上游处理器工厂
 * 按 upstreamProtocol 分发，对应 forward/http 的 client 模式分支
 */

import type { ProxyProtocol } from "@/core/types/proxy.js";
import { httpUpstreamHandler } from "./http.js";
import { httpsUpstreamHandler } from "./https.js";
import { socksUpstreamHandler } from "./socks.js";
import { tlsUpstreamHandler } from "./tls.js";
import type { UpstreamHandler } from "./types.js";

const handlers: Record<ProxyProtocol, UpstreamHandler> = {
  http: httpUpstreamHandler,
  https: httpsUpstreamHandler,
  socks4: socksUpstreamHandler,
  socks5: socksUpstreamHandler,
  sockss4: tlsUpstreamHandler,
  sockss5: tlsUpstreamHandler,
};

export function getUpstreamHandler(protocol: ProxyProtocol): UpstreamHandler {
  return handlers[protocol] ?? httpUpstreamHandler;
}
