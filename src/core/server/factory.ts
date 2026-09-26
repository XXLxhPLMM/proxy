/**
 * 代理工厂 - 按 ProxyProtocol 创建对应 ProxyCore
 * 职责：
 * - 收敛 6 种协议（http/https/socks4/socks5/sockss4/sockss5）的构造分支
 * - 调用方只需传 protocol + options，无需直接依赖各 Proxy 类
 *
 * 设计（刻意不动的部分，别「顺手优化」）：
 * - **协议 → server 类的 switch 是一张「注册表」，不是控制流**：六个 `case` 逐字同形，
 *   换成一表 `{ [protocol]: 类 }` 在可读性上零收益（六个类还得照样 import），却会让
 *   「新增协议」这件事从「加一个 case」变成「改一处数据结构 + 想清楚要不要抽象基类」。
 *   本文件**刻意不碰它**——注册表化的取舍是另一个决策，别顺手做掉。
 * - 本工厂**只做构造**，不做任何缺省解析：服务位（`identity` / `access` / `traffic` /
 *   `connectors`）的归一**全部**发生在 `BaseProxy` 构造期一处。
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
 * @param options - 透传给各 Proxy 构造的选项（必填依赖上下文 `ctx`；服务位缺省各落一个
 *   显式 inert 档，归一只在 `BaseProxy` 构造期发生）
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
