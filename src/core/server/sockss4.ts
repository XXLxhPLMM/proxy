/**
 * SOCKSS4 代理 - TLS 加密 TCP 服 + SocksForwarder(version=4)
 * 职责：TLS 承载 SOCKS4；USERID 承载 token，握手解析/鉴权失败回 SOCKS4_REPLY_FAILURE，成功拨号建隧。
 * 骨架（TLS 建服/证书加载/生命周期）见 socks-base.ts，会话（握手+鉴权）见 socks-session.ts。
 */
import type { ProxyOptions } from "@/core/types/proxy.js";
import { TlsSocksProxy } from "./socks-base.js";
import { runSocks4Session } from "./socks-session.js";

export class Sockss4Proxy extends TlsSocksProxy {
  constructor(o: ProxyOptions) {
    super("sockss4", o, runSocks4Session);
  }
}
