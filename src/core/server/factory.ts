/**
 * 代理工厂 - 按 ProxyProtocol 创建对应 ProxyCore
 */

import type {
  ProxyCore,
  ProxyOptions,
  ProxyProtocol,
} from "@/core/types/proxy.js";
import { HttpProxy } from "./http.js";
import { HttpsProxy } from "./https.js";
import { Socks4Proxy } from "./socks4.js";
import { Socks5Proxy } from "./socks5.js";
import { Sockss4Proxy } from "./sockss4.js";
import { Sockss5Proxy } from "./sockss5.js";

export function createProxy(
  protocol: ProxyProtocol,
  options: ProxyOptions,
): ProxyCore
{
  switch (protocol)
  {
    case "http":
    {
      return new HttpProxy(options);
    }
    case "https":
    {
      return new HttpsProxy(options);
    }
    case "socks4":
    {
      return new Socks4Proxy(options);
    }
    case "socks5":
    {
      return new Socks5Proxy(options);
    }
    case "sockss4":
    {
      return new Sockss4Proxy(options);
    }
    case "sockss5":
    {
      return new Sockss5Proxy(options);
    }
    default:
    {
      throw new Error(`未知代理协议: ${protocol}`);
    }
  }
}
