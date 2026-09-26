/**
 * SOCKS4 代理 - 明文 TCP 服 + SocksInbound(version=4)
 * 职责：以 USERID 承载 token，握手解析/鉴权失败回 SOCKS4_REPLY_FAILURE，成功后拨号建隧。
 * 骨架（生命周期/连接登记/建服/依赖注入）见 socks-base.ts，会话（握手+鉴权）见 socks-session.ts。
 * 协议插件（ProtocolProvider）见 protocols.ts：注册表键即 `protocol`。
 */
import type { ProxyOptions } from "@/core/types/proxy.js";
import type { ProtocolDeps } from "@/plugins/contracts.js";
import { PlainSocksProxy } from "./socks-base.js";
import { runSocks4Session } from "./socks-session.js";

/**
 * SOCKS4 代理实现：明文 TCP 分支（net.Server + runSocks4Session）
 */
export class Socks4Proxy extends PlainSocksProxy {
  /**
   * 构造 SOCKS4 代理
   * @param o - 监听地址/端口与 TLS 等选项，缺省由 BaseProxy 归一化
   * @param deps - 本实例能力插件（config/logger/auth/acl/routing/forwarders）
   */
  constructor(o: ProxyOptions = {}, deps: ProtocolDeps) {
    super("socks4", o, deps, runSocks4Session);
  }
}
