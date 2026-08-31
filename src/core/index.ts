/**
 * core - 所有代理方式的核心聚合目录（barrel）
 * 文件职责：
 * - 统一暴露以类形式实现的代理核心，保持外部引入路径稳定（src/index.ts 仅从此 barrel 引入）
 * - 约束新增协议的接入方式：每个协议一个类文件（http.ts->HttpProxy https.ts->HttpsProxy tls.ts->TlsProxy socks.ts->SocksProxy），均继承 BaseProxy 并实现 doStart/doStop + 生命周期钩子
 * - 与 src/core/types.ts 的 ProxyProtocol 同源，新增协议需同步 store.ts 与 loader.ts 的白名单
 * 导出清单：
 * - types: ProxyProtocol/ProxyOptions/ProxyStats/ProxyCore/LifecycleState/Lifecycle
 * - base: BaseProxy（状态机 + EventEmitter + authorize）
 * - auth: AuthProvider/Auth/AuthContext/TokenExtractor 系列及 createAuthFromConfig
 * - http/https/tls: 各协议具体实现及工厂 createHttpProxy 等
 * 使用示例：import { HttpProxy, createAuthFromConfig, type ProxyCore } from "./core/index.js"
 */

export * from "./types.js";
export * from "./base.js";
export * from "./auth.js";
export * from "./http.js";
export * from "./https.js";
export * from "./tls.js";
