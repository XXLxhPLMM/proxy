/**
 * @fileoverview 拨号器类型叶模块（转发导出）
 * @module core/types/connector
 * @description
 * 本文件为上游拨号器域的「叶模块」，不定义任何新类型，仅从 `proxy.ts`
 * 总表转发拨号相关契约，供 `src/core/forward/connectors/*` 与 `src/core/forward/shared.ts` 按域引入。
 *
 * 职责：
 * - 转发 `UpstreamTarget / DialHandle / DialCallback / ConnectorDial` 四件套
 * - 统一 `BaseUpstreamConnector` 族与 `dialUpstream` 工具的函数式拨号契约形态
 *
 * 设计要点：
 * - 零运行时：仅含 `export type`，构建后完全擦除
 * - 单向依赖：依赖 `proxy.ts`，禁止被 `proxy.ts` 反向依赖；禁止在此新增独立类型
 * - 双形态兼容：既支持回调式 `ConnectorDial.dial(target, cb)`，也支持经 `dialUpstream`
 *   包装后的 Promise 式 `DialResult`，结构上保持兼容
 * - 传输无关：`UpstreamTarget.secure` 仅作提示，具体由 `NetUpstreamConnector` / `TlsUpstreamConnector`
 *   在 `open()` 差异点中决定使用 `net.connect` 还是 `tls.connect`
 *
 * 使用示例：
 * ```ts
 * import type { UpstreamTarget, ConnectorDial, DialCallback } from "@/core/types/connector.js";
 * import { NetUpstreamConnector } from "@/core/forward/connectors/net.js";
 *
 * const target: UpstreamTarget = { host: "example.com", port: 80 };
 * const dialer: ConnectorDial = new NetUpstreamConnector() as unknown as ConnectorDial;
 * dialer.dial(target, (err, handle) => {
 *   if (err) throw err;
 *   handle!.socket.write("GET / HTTP/1.1\r\n\r\n");
 * });
 * ```
 */

export type { UpstreamTarget, DialHandle, DialCallback, ConnectorDial } from "./proxy.js";
