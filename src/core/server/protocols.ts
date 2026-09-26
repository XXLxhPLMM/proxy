/**
 * @fileoverview 入站协议注册表 - 按 `ProxyProtocol` 取 `ProtocolProvider`
 * @module core/server/protocols
 * @description
 * **本文件取代了原 `core/server/factory.ts`（已删）**。理由不是「换个文件名」，
 * 而是那个文件的存在形式本身就是 v5 病根：它的 `createProxy()` 是一棵**编译期
 * 六路 switch**，`new HttpProxy(...)` / `new Socks5Proxy(...)` 逐个写死在分支里。
 * 于是「加第 7 种入站协议」= 改 core 源码 = 全局单例时代的做法，也让协议选择这件事
 * 在编译期就被焊死、无法按配置挑。
 *
 * 现在协议是**注册表里的一项**（`plugins/contracts.ts:ProtocolProvider`）：
 * - 组合根 `createProtocolRegistry().require(protocol)` 拿实现，未注册**抛错**（fail-fast）；
 *   **刻意没有任何 switch 兜底**——静默回落某个默认实现会把装配 bug 变成难查的运行时行为
 * - 新增第 7 种协议 = 实现 `ProtocolProvider` + 往这张表加一项，**不改任何既有代码**
 * - 注册表是**不可变查找表**，不承载生命周期：每个实例经 `provider.create(options, deps)`
 *   造出自己的内核实例（可多实例、可跨 Context 共享同一张表而不串味）
 *
 * `ProtocolProvider` 的两个字段各有用处：`protocol` 是注册表键回显（诊断/事件负载），
 * `secure` 声明**是否 TLS 承载**——组合根据此决定要不要装载证书（`https`/`sockss4`/`sockss5`），
 * 也是 SOCKS 会话 tag 的依据；它由 provider 声明而不是从 `protocol` 字符串现推，
 * 是为了让「协议名 → 是否 TLS」这个知识留在协议自己手里。
 *
 * `create` 收下的 `deps`（`ProtocolDeps`：config/logger/auth/acl/routing/forwarders）是
 * 组合根备齐的**本实例**能力集合：内核不再 `new Auth(...)`、不再直读名单/配置单例，
 * 同进程跑第二个实例时不会读到第一个实例的鉴权方式、上游或名单。
 *
 * 六个 provider 都刻意保持「薄」：只回 `protocol`/`secure` 并 `new` 对应内核类，
 * 真正的行为差异全在内核类与 `socks-session.ts` 里（HTTP 三通道、TLS/明文承载、
 * SOCKS4/5 会话），新增协议时照抄这个形状即可。
 *
 * @example
 * ```ts
 * const protocols = createProtocolRegistry();
 * const provider = protocols.require("socks5"); // 未注册 → 抛错
 * const core = provider.create({ port: 1080, host: "127.0.0.1" }, deps);
 * await core.start();
 * ```
 */

import type { ProxyCore, ProxyOptions, ProxyProtocol } from "@/core/types/proxy.js";
import type {
  PluginRegistry,
  ProtocolDeps,
  ProtocolProvider,
} from "@/plugins/contracts.js";
import { createPluginRegistry } from "@/plugins/contracts.js";
import { HttpProxy } from "./http.js";
import { HttpsProxy } from "./https.js";
import { Socks4Proxy } from "./socks4.js";
import { Socks5Proxy } from "./socks5.js";
import { Sockss4Proxy } from "./sockss4.js";
import { Sockss5Proxy } from "./sockss5.js";

/** 协议插件（注册表键 `http`）：明文 HTTP 代理内核 */
class HttpProtocolProvider implements ProtocolProvider {
  readonly protocol = "http";

  /** 明文承载：组合根无需装载证书 */
  readonly secure = false;

  create(options: ProxyOptions, deps: ProtocolDeps): ProxyCore {
    return new HttpProxy(options, deps);
  }
}

/** 协议插件（注册表键 `https`）：TLS 承载的 HTTP 代理内核（仅重写建服，其余复用父类） */
class HttpsProtocolProvider implements ProtocolProvider {
  readonly protocol = "https";

  /** TLS 承载：组合根须装载证书（缺失即 abort 启动，不静默降级） */
  readonly secure = true;

  create(options: ProxyOptions, deps: ProtocolDeps): ProxyCore {
    return new HttpsProxy(options, deps);
  }
}

/** 协议插件（注册表键 `socks4`）：明文 SOCKS4/4a 内核 */
class Socks4ProtocolProvider implements ProtocolProvider {
  readonly protocol = "socks4";

  readonly secure = false;

  create(options: ProxyOptions, deps: ProtocolDeps): ProxyCore {
    return new Socks4Proxy(options, deps);
  }
}

/** 协议插件（注册表键 `socks5`）：明文 SOCKS5 内核 */
class Socks5ProtocolProvider implements ProtocolProvider {
  readonly protocol = "socks5";

  readonly secure = false;

  create(options: ProxyOptions, deps: ProtocolDeps): ProxyCore {
    return new Socks5Proxy(options, deps);
  }
}

/** 协议插件（注册表键 `sockss4`）：TLS 承载的 SOCKS4/4a 内核 */
class Sockss4ProtocolProvider implements ProtocolProvider {
  readonly protocol = "sockss4";

  readonly secure = true;

  create(options: ProxyOptions, deps: ProtocolDeps): ProxyCore {
    return new Sockss4Proxy(options, deps);
  }
}

/** 协议插件（注册表键 `sockss5`）：TLS 承载的 SOCKS5 内核 */
class Sockss5ProtocolProvider implements ProtocolProvider {
  readonly protocol = "sockss5";

  readonly secure = true;

  create(options: ProxyOptions, deps: ProtocolDeps): ProxyCore {
    return new Sockss5Proxy(options, deps);
  }
}

/**
 * 构造入站协议注册表（注册表键 = `ProxyProtocol`）
 * @description 每次调用返回一张全新的表：条目是**无状态**的实现壳，实例状态全在
 * `create()` 产出的内核里，所以同一 provider 可服务任意多个实例，不需要按实例各建一张。
 * @returns 六个协议的注册表；未注册协议经 `require()` 抛错（**无 switch 兜底**）
 * @throws 键重复（构造期即暴露装配错误）
 * @example protocols.require("https").secure // => true
 */
export function createProtocolRegistry(): PluginRegistry<ProxyProtocol, ProtocolProvider> {
  return createPluginRegistry<ProxyProtocol, ProtocolProvider>([
    ["http", new HttpProtocolProvider()],
    ["https", new HttpsProtocolProvider()],
    ["socks4", new Socks4ProtocolProvider()],
    ["socks5", new Socks5ProtocolProvider()],
    ["sockss4", new Sockss4ProtocolProvider()],
    ["sockss5", new Sockss5ProtocolProvider()],
  ]);
}
