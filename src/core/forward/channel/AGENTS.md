# src/core/forward/channel — 四条入站协议通道

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `http.ts` | `HttpForwarder.handleRequest` —— **单一路径**：解析目标 → 选连接器 → `forwardViaTransport` | `ServerResponse` 形态；**零次**调 `bridgeWithBuffered` |
| `tunnel.ts` | `TunnelForwarder.handleConnect` / `openUpstream` | 裸 socket 状态行 + `bridge` |
| `upgrade.ts` | `WsForwarder.handleUpgrade` / `transportVia` / `relay` | **不实现 WebSocket 协议**（只改写握手报文，101 之后是透传管道） |
| `socks.ts` | `SocksForwarder.serveSocks4` / `serveSocks5Connect` / `connect()` | 客户端**原始字节**握手，不过 HTTP 解析器 |
| `socks-reader.ts` | `SocksHandshakeReader`（`readExactly` / `readUntil` / `takeBuffered` + `dispose`） | server 与 forwarder 共用，解决分段与 pipelining |

**不属于本层**：选连接器（`../base.ts:connectorForRoute` 唯一一处）、有效模式判定（`../../helpers/route.ts`）、传输层建链（`../upstream/dial.ts`）、对端身份（`../upstream/connector/` 的声明式数据）、入站建服与派发（`../../server/`）。

## 硬约定

- **身份铁律**：`user` / `requestId` / `connectionId` 只能经 `RequestScope` 参数逐次传入，**绝不存成转发器字段**。跨会话共享单例这件事全靠「调用点从不把身份写回实例」这条口头约定撑着，由 `RequestScope` 的类型签名接管。护栏 `tests/integration/forwarder-instance-reuse.test.ts` + `tests/unit/forwarder-request-path-allocation.test.ts`。
- **零协议判据**：四条 channel 一律零 `isSocksProto` / `socksVersionOf` / `isTlsUpstreamProto`（护栏 `tests/unit/dialer-protocol-boundary.test.ts`），也**不许**在 channel 里再写第二份选连接器的三元式。
- **零自环地址猜测**：三条通道的「上游自环预检」统一走 `connector.selfLoopTarget()` —— `undefined`（直连）就跳过，否则喂 `denyUpstreamLoop(host, port, …)`。channel 里**不许**出现「读 `UPSTREAM_HOST`/`UPSTREAM_PORT` 调 `denyUpstreamLoopAuto`」的写法（**那个方法不存在，别重建**）。
- **`denyUpstreamLoop` 只有 4 个形参、不收 `req`**：它的两个调用点（tunnel / socks）都在 `connector.open()` **之前**，那里没有 `IncomingMessage`；`loop-detected` 事件上的 `req` 维度由 `preDial` → `guardPreDial` 那条路径带（那里才真的手上有 req）。`extra?: { req?: unknown }` 那个形参**零调用方，别加回来**。
- **`http.ts` 只有一条路径**：`forwardViaRequest` / `forwardViaSocks` / `dialViaSocksAndForward` / `dialer.dialSocks` / `upstreamTlsOptions` / `node:https` 这些形状**都不存在**。
- **零配置裸读**：请求路径一律不绕过 accessor 裸读任何配置（`upgrade.ts` 连 `get("proxyMode")` 都不出现）。
- **状态行等待统一走 `awaitStatusLine`**（`../guard.ts`）；`upstreamTimeout` 只兜时间不兜内存（另有字节封顶）。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

> 已被测试断言锁住的决策不在这里——它们的「结论 + 否掉了什么 + 为什么」写在**那条断言自己所在的测试文件的头注释**里。本清单只留**没有任何测试会红**的纯设计取舍。

1. **Upgrade 通道走 `transport()`、绝不走 `open()`** — 否掉「和 tunnel 一样走 `open()`」— 对 `HttpConnectConnector` 而言 `open()` 会**先发一条 CONNECT 再等 200**，而本通道紧接着要发 absolute-form 的 Upgrade 并**等 101**——上游代理回完 200 就进入「等 CONNECT」的状态机，本通道却在等 101，实测结果是客户端只拿到 `[upgrade] upstream response timeout`。**判据一句话：Upgrade 通道的「先发字节」是本通道自己写的报文，不是裸流——要传输层，不要隧道。** 只有 http(s) 上游这一档会踩（`DirectConnector` 与 `SocksUpstreamConnector` 的 `transport()` 恒等于 `open().sock`）。⚠️ **这一条目前没有任何测试会红**：`tests/integration/forward-tunnel-guard.test.ts` 的两条非 101 用例锁的是「严格判 101、子串不误判」，`forwarder-connector-wiring` 锁的是守卫 route 文本——两者在「改回 `open()`」时都仍可能绿（`open()` 的 `refusal` 也会把上游响应透传给客户端）。所以它留在这里，改它时别指望测试提醒你。
2. **`upstreamTimeout` 必须自行装订在 socket 上** — 否掉「用 `http.request({ timeout })` 或 `proxy.setTimeout()`」— Node **不会**把 `http.request({ timeout })` 应用到 `createConnection` 提供的 socket（实测 `socket.timeout` 恒为 `undefined`、`req.on("timeout")` 永不触发）；`proxy.setTimeout()` 是「从请求起算的一次性」定时器，会把耗时超过 `upstreamTimeout` 的**慢速大响应误杀**。要保持的是**空闲**超时，故装在 socket 上。`<= 0` 即禁用。⚠️ **同样没有测试会红**（没有一条用例构造「慢速但持续有字节」的大响应）。
3. **`Connection: close` 只有 `sanitizeHeaders` 一处** — 否掉「渠道分支里再写一遍」— 三条支路都经过 `sanitizeHeaders`，重写不改变任何字节。⚠️ **没有测试会红**：`tests/integration/http-forward-contract.test.ts` 断言的是**出站字节**（`connection: close` 确实出现），渠道分支里多写一遍同样的赋值它照样绿——本条锁的是「不重复」这个事实，不是字节。
4. **SOCKS 域名是客户端原始字节，解析 / 建握手前必过 host 白名单** — 否掉「复用 `helpers/target.ts` 里给 HTTP 用的 authority 解析」— SOCKS 的地址字段**不过 HTTP 解析器**，给它套一条不存在的协议语法就会在畸形报文上产生「看起来解析成功」的中间态。⚠️ 「SOCKS4a 哨兵判 `DSTIP ∈ 0.0.0.0/24`、不是只认全 0」那一档**有**牙齿，判据在 `tests/integration/socks-handshake.test.ts` 的头注释。
5. **新增入站×上游×证书组合必须在 `tests/integration/upstream-matrix.test.ts` 补一档** — 这是一条**流程要求**而不是形状断言，没有任何测试会因为漏补而变红；它靠评审与自觉执行。
