/**
 * 上游连接器层出口（`src/core/forward/connector/`）。
 *
 * 跨目录引用一律走本文件（`@/core/forward/connector/index.js`），**不要**深入
 * `core/forward/connector/` 内部路径：这样目录继续拆分时调用方零改动。
 * 层内相对引用（`./types.js`、`./socks-upstream.js`、`../dial.js`），**禁止自引 barrel**。
 *
 * 七个职责模块：
 * - `types.ts` 端口定义（`UpstreamKind` / `OpenContext` / `OpenedUpstream` / `UpstreamConnector`），零运行期依赖
 * - `direct.ts` 直连连接器（`kind: "direct"`，明文，无上游凭证、无上游自环、**无协议实现**）
 * - `http-connect.ts` HTTP/HTTPS 上游 CONNECT 连接器（`kind: "http" | "https"`，absolute-form，
 *   带上游 Basic 凭证头；**CONNECT 协议实现住在这里**）
 * - `socks-upstream.ts` SOCKS 两版的共享基类（拨号外壳 + 握手应答读取器 `readReply`
 *   + 四个逐字相同的声明式成员，**各只有一份**；抽象类，不进本 barrel）
 * - `socks4.ts` SOCKS4/4a 上游连接器（`kind: "socks4"`，origin-form，凭证走 USERID；
 *   **SOCKS4 协议实现住在这里**）
 * - `socks5.ts` SOCKS5 上游连接器（`kind: "socks5"`，origin-form，凭证走 RFC1929 子协商；
 *   **SOCKS5 协议实现住在这里**）
 * - `registry.ts` 协议 → 连接器的唯一映射（`connectorFor` / `directConnector`，未知协议 fail-closed 抛错）
 *
 * **硬不变量：上游协议的实现只住在 `connector/<协议>.ts`。**
 * `forward/dial.ts` 是纯传输层（建链 + 桥接），**不得知道任何上游协议**——**2c 起零例外**
 * （最后一个例外是 `readReply` 及其两条带 SOCKS 字样的报错文案，已搬进 `socks-upstream.ts`）；
 * 反向依赖（`dial.ts` import 本目录）同样禁止。负向断言见
 * `tests/unit/dialer-protocol-boundary.test.ts`（含「去注释后的 `dial.ts` 源码文本零协议词汇」）。
 *
 * 依赖方向（单向）：`connector/* → forward/dial`（`../dial.js`）；**反向禁止**。
 * `registry` 另 type-only 引 `@/core/types/proxy.js` 的 `ProxyProtocol`。
 *
 * 本层**只管「怎么到达 dest」**：不知道入站协议（http / CONNECT / upgrade / socks），
 * 成败应答的协议形态留在 channel（见 `src/core/AGENTS.md`「刻意不收的」）。
 */

export { DirectConnector } from "./direct.js";
export { HttpConnectConnector } from "./http-connect.js";
export { Socks4Connector } from "./socks4.js";
export { Socks5Connector } from "./socks5.js";
export { connectorFor, directConnector } from "./registry.js";
export type { OpenContext, OpenedUpstream, UpstreamConnector, UpstreamKind } from "./types.js";
