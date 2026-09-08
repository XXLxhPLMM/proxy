/**
 * 代理工厂 - 按 ProxyProtocol 创建对应 ProxyCore
 * 职责：
 * - 收敛 6 种协议（http/https/socks4/socks5/sockss4/sockss5）的构造分支
 * - 调用方只需传 protocol + options，无需直接依赖各 Proxy 类
 */

import type { ProxyCore, ProxyOptions, ProxyProtocol } from "@/core/types/proxy.js";
import { HttpProxy } from "./http.js";
import { HttpsProxy } from "./https.js";
import { Socks4Proxy } from "./socks4.js";
import { Socks5Proxy } from "./socks5.js";
import { Sockss4Proxy } from "./sockss4.js";
import { Sockss5Proxy } from "./sockss5.js";

/**
 * 按协议创建代理实例
 * @param protocol - 代理协议标识（http/https/socks4/socks5/sockss4/sockss5）
 * @param options - 透传给各 Proxy 构造的选项（port/host/auth/tls 等）
 * @returns 对应协议的 ProxyCore 实例，未 start，需调用方自行 start()
 * @throws 未知协议时抛 Error
 */
export function createProxy(protocol: ProxyProtocol, options: ProxyOptions): ProxyCore {
  switch (protocol) {
    case "http": {
      return new HttpProxy(options);
    }
    case "https": {
      return new HttpsProxy(options);
    }
    case "socks4": {
      return new Socks4Proxy(options);
    }
    case "socks5": {
      return new Socks5Proxy(options);
    }
    case "sockss4": {
      return new Sockss4Proxy(options);
    }
    case "sockss5": {
      return new Sockss5Proxy(options);
    }
    default: {
      throw new Error(`未知代理协议: ${protocol}`);
    }
  }
}
