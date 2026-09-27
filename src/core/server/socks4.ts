/**
 * SOCKS4 代理 - 明文 TCP 服 + SocksForwarder(version=4)
 * 职责：以 USERID 承载 token，握手解析/鉴权失败回 SOCKS4_REPLY_FAILURE，成功后拨号建隧。
 * 骨架（生命周期/连接登记/建服）见 socks-base.ts，会话（握手+鉴权）见 socks-session.ts。
 */
import type { ProxyOptions } from "@/core/types/proxy.js";
import { PlainSocksProxy } from "./socks-base.js";
import { runSocks4Session } from "./socks-session.js";

export class Socks4Proxy extends PlainSocksProxy {
  constructor(o: ProxyOptions) {
    super("socks4", o, runSocks4Session);
  }
}
