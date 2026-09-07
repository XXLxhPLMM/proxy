/**
 * connectors - 上游连接器工厂
 * 按 upstreamProtocol（一协议一文件）分发连接器实例；协议差异收敛在各 Connector 类的 open()
 */

import type { ProxyProtocol } from "@/core/types/proxy.js";
import { BaseUpstreamConnector } from "./base.js";
import { HttpUpstreamConnector } from "./http.js";
import { HttpsUpstreamConnector } from "./https.js";
import { SocksUpstreamConnector } from "./socks.js";
import { TlsUpstreamConnector } from "./tls.js";

export type { ConnectorDial, DialCallback, DialHandle, DialResult, UpstreamTarget } from "@/core/types/connector.js";
export type { TunnelResult, TunnelViaUpstreamOptions } from "./tunnel.js";
export { BaseUpstreamConnector } from "./base.js";
export { HttpUpstreamConnector } from "./http.js";
export { HttpsUpstreamConnector } from "./https.js";
export { SocksUpstreamConnector } from "./socks.js";
export { TlsUpstreamConnector, type TlsUpstreamOptions } from "./tls.js";
export { dialTunnelViaUpstream } from "./tunnel.js";

/** 按协议取连接器实例（http/https/socks/tls 各一文件；实例 .dial() 即拨号） */
export function createConnector(protocol: ProxyProtocol): BaseUpstreamConnector {
  switch (protocol) {
    case "https":
      return new HttpsUpstreamConnector();
    case "socks":
      return new SocksUpstreamConnector();
    case "tls":
      return new TlsUpstreamConnector();
    case "http":
    default:
      return new HttpUpstreamConnector();
  }
}
