/**
 * @fileoverview TLS 层出口。
 *
 * 本目录按职责拆成三块，入站材料 / 入站建服选项 / 出站建链选项互不越界：
 * | 文件               | 只负责                                                    | 配置依赖 |
 * | ------------------ | --------------------------------------------------------- | -------- |
 * | `certs.ts`         | 三个类型 + `loadCerts`（只读文件，读不到必抛错）           | 无       |
 * | `server-options.ts`| `requiresClientCert` / `tlsServerOptions`（零 IO 纯拼装）  | 无       |
 * | `upstream.ts`      | `readUpstreamCa` / `upstreamTlsOptions`                    | 必填     |
 *
 * 跨目录引用一律走本文件（`@/utils/tls/index.js`），**不要**深入目录内部路径：这样目录继续拆分
 * 时调用方零改动。层内互引用相对路径（`./certs.js` 等）、**禁止自引 barrel**。
 *
 * 范围边界：本目录只管**证书材料读取与 TLS 选项拼装**，零跨层依赖（只 type-only 引用
 * `ConfigAccessor`，不 import 任何 core / server 模块）。握手失败告警（事件码 `[tls-client-error]`）
 * **不在此处**——它需要「core 事实 → 日志文本」这层翻译，放 utils 会逼出 `utils → core` 的
 * 反向依赖（目录级环）；它归 `core/server/tls-alarm.ts`（建服骨架的一部分），事件码词汇表在
 * `core/log-events.ts`，依赖方向 `core/server → core/log-events → utils/logger` 全单向。
 */

export * from "./certs.js";
export * from "./server-options.js";
export * from "./upstream.js";
