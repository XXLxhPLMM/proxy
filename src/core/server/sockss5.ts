/**
 * SOCKSS5 代理 - TLS 加密 TCP 服 + SocksInbound(version=5)
 * 职责：TLS 承载 SOCKS5；握手选鉴与 RFC1929 basic 头鉴权，成功后读 CONNECT 建隧。
 * 骨架（TLS 建服/证书加载/生命周期/依赖注入）见 socks-base.ts，会话（握手+鉴权）见 socks-session.ts。
 * 协议插件（ProtocolProvider）见 protocols.ts：注册表键即 `protocol`。
 */
import type { ProxyOptions } from "@/core/types/proxy.js";
import type { ProtocolDeps } from "@/plugins/contracts.js";
import { TlsSocksProxy } from "./socks-base.js";
import { runSocks5Session } from "./socks-session.js";

/**
 * SOCKSS5 代理实现：TLS 加密分支（tls.Server + runSocks5Session）
 */
export class Sockss5Proxy extends TlsSocksProxy {
  /**
   * 构造 SOCKSS5 代理
   * @param o - 监听地址/端口与 TLS 等选项，缺省由 BaseProxy 归一化
   * @param deps - 本实例能力插件（config/logger/auth/acl/routing/forwarders）
   */
  constructor(o: ProxyOptions = {}, deps: ProtocolDeps) {
    super("sockss5", o, deps, runSocks5Session);
  }
}
