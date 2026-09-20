/**
 * SOCKSS5 代理 - TLS 加密 TCP 服 + SocksForwarder(version=5)
 * 职责：TLS 承载 SOCKS5；握手选鉴与 RFC1929 basic 头鉴权，成功后读 CONNECT 建隧。
 * 骨架（TLS 建服/证书加载/生命周期）见 socks-base.ts，会话（握手+鉴权）见 socks-session.ts。
 */
import type { ProxyOptions } from "@/core/types/proxy.js";
import { TlsSocksProxy } from "./socks-base.js";
import { runSocks5Session } from "./socks-session.js";

/**
 * SOCKSS5 代理实现：TLS 加密分支（tls.Server + runSocks5Session）
 */
export class Sockss5Proxy extends TlsSocksProxy {
  /**
   * 构造 SOCKSS5 代理
   * @param o - 监听地址/端口与 TLS/鉴权等选项，缺省由 BaseProxy 归一化
   */
  constructor(o: ProxyOptions = {}) {
    super("sockss5", o, runSocks5Session);
  }
}
