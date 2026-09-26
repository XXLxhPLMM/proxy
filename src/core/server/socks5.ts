/**
 * SOCKS5 代理 - 明文 TCP 服 + SocksInbound(version=5)
 * 职责：握手选鉴（NO_AUTH/USER_PASS）、RFC1929 子协商与 basic 头鉴权，成功后读 CONNECT 建隧。
 * 骨架（生命周期/连接登记/建服/依赖注入）见 socks-base.ts，会话（握手+鉴权）见 socks-session.ts。
 * 协议插件（ProtocolProvider）见 protocols.ts：注册表键即 `protocol`。
 */
import type { ProxyOptions } from "@/core/types/proxy.js";
import type { ProtocolDeps } from "@/plugins/contracts.js";
import { PlainSocksProxy } from "./socks-base.js";
import { runSocks5Session } from "./socks-session.js";

/**
 * SOCKS5 代理实现：明文 TCP 分支（net.Server + runSocks5Session）
 */
export class Socks5Proxy extends PlainSocksProxy {
  /**
   * 构造 SOCKS5 代理
   * @param o - 监听地址/端口与 TLS 等选项，缺省由 BaseProxy 归一化
   * @param deps - 本实例能力插件（config/logger/auth/acl/routing/forwarders）
   */
  constructor(o: ProxyOptions = {}, deps: ProtocolDeps) {
    super("socks5", o, deps, runSocks5Session);
  }
}
