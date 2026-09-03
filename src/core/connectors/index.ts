/**
 * connectors - 上游连接器工厂
 * 按 upstreamProtocol（一协议一文件）分发拨号函数
 */

import type { ProxyProtocol } from "@/core/types/proxy.js";
import { dialHttpUpstream } from "./http.js";
import { dialHttpsUpstream } from "./https.js";
import { dialSocksUpstream } from "./socks.js";
import { dialTlsUpstream } from "./tls.js";
import type { ConnectorDial } from "@/core/types/connector.js";

export type { ConnectorDial, DialCallback, DialHandle, UpstreamTarget } from "@/core/types/connector.js";
export { dialHttpUpstream } from "./http.js";
export { dialHttpsUpstream } from "./https.js";
export { dialSocksUpstream } from "./socks.js";
export { dialTlsUpstream } from "./tls.js";

/** 按协议取连接器（http/https/socks/tls 各一文件） */
export function createConnector(protocol: ProxyProtocol): ConnectorDial {
  switch (protocol) {
    case "https":
      return dialHttpsUpstream;
    case "socks":
      return dialSocksUpstream;
    case "tls":
      return dialTlsUpstream;
    case "http":
    default:
      return dialHttpUpstream;
  }
}
