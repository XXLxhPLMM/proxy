/**
 * core - 代理核心共享抽象（纯类型 + 基类 + 身份识别 + 转发管道 + 服务器族）
 *
 * @description 本 barrel 是**选择性**出口，不是 core 的完整导出面。
 *
 * **为什么刻意不全导**（这是一条纪律）：
 * - `access-control` / `error-boundary` / `request-terminal` **刻意不在其中**：
 *   它们是「实现面」（判定、分类、终态守卫），调用方要么经 runtime/CLI 那一层用不到，
 *   要么经各自的兄弟模块直引。导出它们会让人以为「core 的公共 API 面就是这一屏」，
 *   而这个 barrel 恰恰不承诺这件事。
 * - `connectors`（`ConnectorSource`）同理：它是**装配期**的注入位，注入方是唯一组装根
 *   `runtime/services.ts` 与库调用方，两者都直接引 `@/core/forward/upstream/connector/index.js`。
 *   把装配期注入位挂在一个看起来「运行时公共 API」的 barrel 上，是把装配面与消费面混在一起。
 * - core 内部的既有惯例就是**按扁平路径直接引用**（`@/core/identity.js`、
 *   `@/core/access-control.js`、`@/core/events/index.js`），库入口 `src/index.ts` 也不经本文件。
 *   **不要为了导出而导出**——每多一个出口就多一处将来要维护的兼容面。
 */

export * from "./types/proxy.js";
export * from "./types/identity.js";
export * from "./types/pipe.js";
export * from "./identity.js";
export * from "./helpers/index.js";
export * from "./guard.js";
export * from "./server/base.js";
export * from "./forward/base.js";
export * from "./forward/upstream/dial.js";
export * from "./forward/channel/http.js";
export * from "./forward/channel/tunnel.js";
export * from "./forward/channel/socks.js";
export * from "./forward/channel/socks-reader.js";
export * from "./forward/channel/upgrade.js";
