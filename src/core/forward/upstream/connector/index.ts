/**
 * 上游连接器层出口（`src/core/forward/upstream/connector/`）。
 *
 * 跨目录引用一律走本文件（`@/core/forward/upstream/connector/index.js`），**不要**深入
 * `core/forward/upstream/connector/` 内部路径：这样目录继续拆分时调用方零改动。
 * 层内相对引用（`./types.js`、`./socks-upstream.js`、`../dial.js`），**禁止自引 barrel**。
 *
 * `socks-upstream.ts` 是内部件、**刻意不进本 barrel**。本层**只管「怎么到达 dest」**：不知道入站
 * 协议，成败应答的协议形态留在 channel。
 *
 * **「用哪个连接器」是装配期注入的**：`UPSTREAM_PROTOCOL` 是 startup 相位字段，端口把「用哪个」
 * 在装配期定死成两档，请求路径只问「直连 / 走上游」。**每请求查表不存在、也不该配缓存**
 * ——`UPSTREAM_PROTOCOL` 是 startup 相位，记忆化挂在它上面才正确；给「每请求查表」配缓存等于
 * 给一件不该每请求做的事再加一层（判据见 `registry.ts`「为什么在装配期解析」）。
 *
 * **硬不变量：上游协议的实现只住在 `connector/<协议>.ts`，`forward/dial.ts` 零例外**（连它的报错
 * 文案里都不许出现协议词汇）。负向断言见 `tests/unit/dialer-protocol-boundary.test.ts`
 * （含「去注释后的 `dial.ts` 源码文本零协议词汇」）。
 *
 * 依赖方向（单向）：`connector/* → forward/upstream/dial`（`../dial.js`）；**反向禁止**。
 * `registry` 另 type-only 引 `@/core/types/proxy.js` 的 `ProxyProtocol`。
 */

export { DirectConnector } from "./direct.js";
export { HttpConnectConnector } from "./http-connect.js";
export { Socks4Connector } from "./socks4.js";
export { Socks5Connector } from "./socks5.js";
export { createConnectorSource } from "./registry.js";
export type {
  ConnectorSource,
  OpenContext,
  OpenedUpstream,
  UpstreamConnector,
  UpstreamKind,
} from "./types.js";
