# src/core/forward/upstream/

文件与路径说明。

## 层不变量

以下几条已逐条核过（`src/core/forward/upstream/**` 内零反例）。**本节只列不变式，理由留在各文件的头注释里。**

- **`dial.ts` 零协议知识，零例外**：不认 SOCKS、不认 CONNECT、不拼任何协议报文，**连报错文案里都不许出现协议词汇**。字节级原语也不例外——即便它只是「读 n 字节」，只要文案带协议字样（会经 channel 的 catch 进落盘日志）就必须住 `connector/socks-upstream.ts`。协议实现一律住 `connector/<协议>.ts`。
  牙齿：`tests/unit/core/forward/upstream/dial-boundary.test.ts`（锁 `Dialer.prototype` 方法闭集 + **去注释后的源码文本不含协议词汇**）。
- **依赖方向单向**：`connector/* → forward/upstream/dial`，**反向禁止**。

## 文件

- `src/core/forward/upstream/dial.ts` — 传输层 `Dialer`（`extends ContextualBase`）：建链 `dialDirect` / `dialTls` / `choose` / `dialWith` 与桥接 `bridge`，上游协议实现的住处是 `connector/<协议>.ts`。

## 子目录

- `src/core/forward/upstream/connector/` — 上游连接器层（「怎么到达 dest」的抽象、四个连接器、registry、层 barrel） → [`connector/AGENTS.md`](./connector/AGENTS.md)

## 路径指引

- 相关：`src/core/forward/base.ts`（共享 `dialer` 与 `bridgeWithBuffered` 调用方）、`src/core/guard.ts`（`guardDialing` / `DialGuardOptions`）、`src/core/forward/channel/`（桥接的通道侧调用方 `WsForwarder.relay`）。
- 相关测试：`tests/unit/core/forward/upstream/dial-boundary.test.ts`、`tests/unit/core/dead-optionality.test.ts`、`tests/unit/core/forward/upstream/transport.test.ts`。
