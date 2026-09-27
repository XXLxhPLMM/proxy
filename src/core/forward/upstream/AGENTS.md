# src/core/forward/upstream/

文件与路径说明。

## 文件

- `src/core/forward/upstream/dial.ts` — 传输层 `Dialer`（`extends ContextualBase`）：建链 `dialDirect` / `dialTls` / `choose` / `dialWith` 与桥接 `bridge`，上游协议实现的住处是 `connector/<协议>.ts`。

## 子目录

- `src/core/forward/upstream/connector/` — 上游连接器层（「怎么到达 dest」的抽象、四个连接器、registry、层 barrel） → [`connector/AGENTS.md`](./connector/AGENTS.md)

## 路径指引

- 相关：`src/core/forward/base.ts`（共享 `dialer` 与 `bridgeWithBuffered` 调用方）、`src/core/guard.ts`（`guardDialing` / `DialGuardOptions`）、`src/core/forward/channel/`（桥接的通道侧调用方 `WsForwarder.relay`）。
- 相关测试：`tests/unit/dialer-protocol-boundary.test.ts`、`tests/unit/dead-optionality-cleared.test.ts`、`tests/unit/connector-transport.test.ts`。
