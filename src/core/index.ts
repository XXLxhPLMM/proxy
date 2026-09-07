/**
 * core - 代理核心共享抽象（纯类型 + 基类 + 鉴权 + 转发管道 + 服务器族）
 */

export * from "./types/proxy.js";
export * from "./types/auth.js";
export * from "./types/server.js";
export * from "./types/pipe.js";
export * from "./types/connector.js";
export * from "./auth.js";
export * from "./token-extractors.js";
export * from "./proxy-helpers.js";
export * from "./server/base.js";

export { BaseUpstreamConnector, bridgeSockets, tunnelConnect, type TunnelOptions } from "./forward/connectors/base.js";
export { NetUpstreamConnector } from "./forward/connectors/net.js";
export { TlsUpstreamConnector, type TlsUpstreamOptions } from "./forward/connectors/tls.js";
export * from "./forward/http.js";
export * from "./forward/tunnel.js";
export * from "./forward/websocket.js";
