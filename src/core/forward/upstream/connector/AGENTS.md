# src/core/forward/upstream/connector/

文件与路径说明。「怎么到达 dest」的连接器层，core 侧入口是 `ConnectorSource` 端口。

## 文件

- `src/core/forward/upstream/connector/types.ts` — 端口与形状声明：`ConnectorSource` / `UpstreamConnector` / `OpenContext`（`client` / `dest` / `onEvent` / `logPrefix` / `clientLifetime`）/ `OpenedUpstream`。
- `src/core/forward/upstream/connector/registry.ts` — `createConnectorSource(ctx)`：协议 → 连接器的登记表与装配期工厂。
- `src/core/forward/upstream/connector/direct.ts` — `DirectConnector`：直连连接器（不与任何代理对话）。
- `src/core/forward/upstream/connector/http-connect.ts` — `HttpConnectConnector`：CONNECT 上游连接器，`secure` 决定 net / tls。
- `src/core/forward/upstream/connector/socks-upstream.ts` — `SocksUpstreamConnector` 抽象基类、拨号外壳 `dialViaSocks` 与应答读取器 `readReply`。
- `src/core/forward/upstream/connector/socks4.ts` — SOCKS4 握手协议体（`handshake`）。
- `src/core/forward/upstream/connector/socks5.ts` — SOCKS5 握手协议体（`handshake`）。
- `src/core/forward/upstream/connector/index.ts` — 层出口 barrel。

## 路径指引

- 对外出口：`@/core/forward/upstream/connector/index.js`（`socks-upstream.ts` 属层内部件）。
- 相关：`src/core/forward/upstream/dial.ts`（建链原语）、`src/core/forward/base.ts`（连接器选择与预检接线）、`src/core/forward/channel/`（应答与 `refusal` 处置方）、`src/config/files/rules/index.ts`（`normalizeIp`）。
- 相关测试：`tests/unit/connector-open.test.ts`、`tests/unit/connector-transport.test.ts`、`tests/unit/connector-registry.test.ts`、`tests/unit/dialer-protocol-boundary.test.ts`、`tests/integration/upstream-protocol-fail-closed.test.ts`、`tests/integration/http-inbound-keepalive-decoupled.test.ts`、`tests/integration/socks-upstream-handshake.test.ts`。
