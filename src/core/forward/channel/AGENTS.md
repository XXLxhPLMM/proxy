# src/core/forward/channel/

文件与路径说明。

## 文件

- `src/core/forward/channel/http.ts` — `HttpForwarder.handleRequest`：HTTP 普通请求通道（目标解析 → 连接器选择 → `forwardViaTransport`，`ServerResponse` 形态应答）。
- `src/core/forward/channel/tunnel.ts` — `TunnelForwarder.handleConnect` / `openUpstream`：CONNECT 隧道通道（裸 socket 状态行 + `bridge` 桥接）。
- `src/core/forward/channel/upgrade.ts` — `WsForwarder.handleUpgrade` / `transportVia` / `relay`：Upgrade 通道（握手报文改写 + 101 之后透传）。
- `src/core/forward/channel/socks.ts` — `SocksForwarder.serveSocks4` / `serveSocks5Connect` / `connect`：SOCKS4/5 入站通道（客户端原始字节握手）。
- `src/core/forward/channel/socks-reader.ts` — `SocksHandshakeReader`（`readExactly` / `readUntil` / `takeBuffered` / `dispose`）：server 与 forwarder 共用的握手读取器。

## 路径指引

- 层内：`src/core/forward/base.ts`（连接器选择 `connectorForRoute`、终态与拨号失败收尾 `settleDenied` / `settleDialFailure`、回灌 `bridgeWithBuffered`）。
- 层外相关：`src/core/helpers/route.ts`（有效模式判定）、`src/core/forward/upstream/dial.ts`（建链与桥接）、`src/core/forward/upstream/connector/`（对端身份声明与 `selfLoopTarget()`）、`src/core/guard.ts`（`awaitStatusLine` 状态行等待）、`src/core/server/`（入站建服与派发）。
- 相关测试：`tests/unit/dialer-protocol-boundary.test.ts`、`tests/unit/forwarder-request-path-allocation.test.ts`、`tests/integration/forwarder-instance-reuse.test.ts`、`tests/integration/forward-tunnel-guard.test.ts`、`tests/integration/http-forward-contract.test.ts`、`tests/integration/socks-handshake.test.ts`、`tests/integration/upstream-matrix.test.ts`。
