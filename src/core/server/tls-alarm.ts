/**
 * @fileoverview TLS 握手失败告警：把 `tlsClientError` 绑到当前实例显式注入的 logger
 * @module core/server/tls-alarm
 * @description
 * 收敛 `HttpsProxy`（`doStart`）与 `TlsSocksProxy`（`onListenerReady`）两处逐字重复的
 * `tlsClientError` 接线。握手失败（含 mTLS 拒绝、非 TLS 客户端打到 TLS 端口）只落 warn、
 * 不断服，携带 `code` / `authorizationError` 结构化字段便于定位「为什么连不上」
 * （事件码 `[tls-client-error]`）。
 *
 * 为什么住在 `core/server`（而不是 `src/utils`）：
 * - 它是**建服骨架**的一部分（与 `BaseProxy.closeServer` 同级：都在 server 生命周期内接线），
 *   不是一个可复用的通用工具；
 * - 它需要 core 事实 → 日志文本的翻译层（`@/core/log-events.js`）。放在 utils 会让
 *   `utils → server/log`（或 `utils → core`）成为反向依赖，而 `src/server` 本身就依赖
 *   `src/utils`，构成目录级环。
 *
 * 依赖方向：`core/server → core/log-events → utils/logger`（单向）。
 * 显式接 logger，不读任何全局 logger：调用方必须传当前实例的 `this.log`。
 */

import type tls from "node:tls";
import { logTlsClientError, type EventLog } from "../log-events.js";

/**
 * 绑定 TLS 握手失败告警（`tlsClientError`）
 * @param server - 已创建的 TLS 服务实例（`https.Server` 是其子类，同样可传）
 * @param log - 当前代理实例显式绑定的日志端口（`this.log`）
 * @param protocol - 协议标识（https / sockss4 / sockss5），拼入消息正文
 * @example
 * ```ts
 * bindTlsClientError(server, this.log, this.protocol);
 * ```
 */
export function bindTlsClientError(server: tls.Server, log: EventLog, protocol: string): void {
  server.on("tlsClientError", (err: Error, socket) => {
    logTlsClientError(log, `${protocol} 客户端 TLS 握手失败`, err, {
      code: (err as NodeJS.ErrnoException).code,
      authorizationError: socket?.authorizationError,
    });
  });
}
