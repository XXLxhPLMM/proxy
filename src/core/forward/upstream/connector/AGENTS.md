# src/core/forward/upstream/connector/

文件与路径说明。「怎么到达 dest」的连接器层，core 侧入口是 `ConnectorSource` 端口。

## 层不变量

以下几条已逐条核过（`src/core/forward/upstream/connector/**` 内零反例）。**本节只列不变式与索引表，理由留在各文件的头注释里。**

- **`kind` 是闭合集，不许放宽成 `string`**：放宽等于把「选错 → 编译期红」换成「选错 → 静默走错分支」，而每个取值在 core 里都有**硬编码消费点**。下表是那张映射的权威出处——**改 `kind` 的取值域或改动任一消费点时，两边一起改**。
- **`kind` 与 `targetForm` 是两个独立声明式字段，端口对二者零约束**。内置实现恰好自洽，那是事实不是契约。故「对端是不是代理」**必须读 `targetForm`**，绝不许从 `kind` 推；上游凭证注入与否同理，**只由 `upstreamAuthHeader()` 决定**。
- **「用哪个连接器」在装配期定死成两档**，请求路径零次查表、零次分配。
- **未登记的上游协议 fail-closed 抛错，绝不静默回落直连**（「静默直连 = 流量旁路」）。
- **连接器只如实报告事实，绝不向 `ctx.client` 写任何字节**：成败应答与 `refusal` 的处置形态一律归 channel。

### `UpstreamKind` 五个取值的硬编码消费点

| 取值 | 消费点 | 选错的后果 |
| --- | --- | --- |
| `direct` | `channel/http.ts` 的 Host **条件回写**分支；`channel/socks.ts` `connect` 的直连分支判别 | 落到**无条件回写**分支，或跳过直连分支直接进 `targetForm` 分支 |
| `http` / `https` | 构造参数 `secure`（TLS 承载错配的形态） | 明文 `http` 拨 TLS 上游 / `https` 拨明文上游，报文全在明文或全在密文里 |
| `socks4` / `socks5` | `channel/socks.ts` 的日志版本号 `connector.kind === "socks4" ? 4 : 5`（逐字契约）；`channel/upgrade.ts` 的 `isSocksTunnel`（失败日志的 `"via socks "` 尾巴，逐字契约） | 落盘日志与实际握手版本不符；尾巴对不上「这一跳走没走 SOCKS」——两者唯一差别就是这两处 |

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
- 相关：`src/core/forward/upstream/dial.ts`（建链原语）、`src/core/forward/base.ts`（连接器选择与预检接线）、`src/core/forward/channel/`（应答与 `refusal` 处置方）、`src/addr/index.ts`（`normalizeIp`）。
- 相关测试：`tests/unit/connector-open.test.ts`、`tests/unit/connector-transport.test.ts`、`tests/unit/connector-registry.test.ts`、`tests/unit/dialer-protocol-boundary.test.ts`、`tests/integration/upstream-protocol-fail-closed.test.ts`、`tests/integration/http-inbound-keepalive-decoupled.test.ts`、`tests/integration/socks-upstream-handshake.test.ts`。
