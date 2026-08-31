/**
 * core - 所有代理方式的核心聚合目录
 * 职责：统一暴露以类形式实现的代理核心，保持外部引入路径稳定
 * 约定：
 *  - 每个协议一个类文件（http.ts -> HttpProxy，后续 socks.ts -> SocksProxy 等）
 *  - 均继承 BaseProxy，遵循 ProxyCore 契约
 *  - 新增协议只需在此 barrel 中追加 export，无需改动调用方
 */

export * from "./types.js";
export * from "./base.js";
export * from "./auth.js";
export * from "./http.js";
