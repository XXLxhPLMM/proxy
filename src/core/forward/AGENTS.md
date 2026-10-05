# src/core/forward/

文件与路径说明。

## 文件

- `src/core/forward/base.ts` — 两轴共享基类 `ForwarderBase`：依赖包 `services` / `connectors` / `dialer` / `config`，前置接线族 `connectorForRoute` / `preDial` / `preDialPeerTarget` / `denyUpstreamLoop` / `settleDenied` / `settleDialFailure`，应答骨架 `refuse` / `refuseByCause`，路由事件 `emitRoute`，回灌与计量 `bridgeWithBuffered` / `openTunnelMeter` / `openHttpQuotaGate`。

## 子目录

- `src/core/forward/channel/` — 入站协议轴：http / tunnel / upgrade / socks 四条通道 + SOCKS 握手读取器 → [`channel/AGENTS.md`](./channel/AGENTS.md)
- `src/core/forward/upstream/` — 纯传输层 `dial.ts` → [`upstream/AGENTS.md`](./upstream/AGENTS.md)
- `src/core/forward/upstream/connector/` — 上游对接轴：四个连接器 + registry + 层 barrel → [`upstream/connector/AGENTS.md`](./upstream/connector/AGENTS.md)

## 路径指引

- 入站事件 → 转发器入口：`request` → `channel/http.ts` `handleRequest`；`connect` → `channel/tunnel.ts` `handleConnect`；`upgrade` → `channel/upgrade.ts` `handleUpgrade`；SOCKS → `channel/socks.ts` `serveSocks4` / `serveSocks5Connect`。
- 层外相关：`src/core/server/`（入站建服与派发 `buildInboundChannels`）、`src/core/types/`（`ConnectorSource` 端口、`CoreServices` 形状）、`src/core/helpers/route.ts`（有效模式判定）、`src/core/guard.ts`（拨号后生命周期联动）、`src/runtime/event-log.ts`（事件落盘与 `FORWARD_ERROR_LABEL` 日志文本）。
- 相关测试：`tests/unit/core/forward/`、`tests/unit/core/request-scope/allocation.test.ts`、`tests/integration/forward/instance-reuse.test.ts`、`tests/integration/forward/connector-wiring/`。
