# src/core/forward/upstream/connector — 上游连接器层

「怎么到达 dest」的唯一抽象。core 只认 `ConnectorSource` 端口、永不自己造实现。

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `types.ts` | `ConnectorSource` 端口 / `UpstreamConnector` / `OpenContext` / `OpenedUpstream` | 形状裁决都在这里，改它要读下方硬约定 |
| `registry.ts` | `createConnectorSource(ctx)` —— 协议 → 连接器的**唯一映射**，装配期注入 | **唯一出口**。未登记协议 fail-closed **抛错**，不静默回落 direct |
| `direct.ts` | `DirectConnector` | **无协议实现**（直连不与任何代理对话，`open()` 由传输层建链原语直接组成） |
| `http-connect.ts` | `HttpConnectConnector` —— CONNECT 上游对接（`secure` 决定 net/tls） | 只拨号到上游、**不发 CONNECT、不等状态行** |
| `socks-upstream.ts` | `SocksUpstreamConnector` 抽象基类 + `withUpstreamDial` 拨号外壳 + `readReply` | **不进 barrel**（内部件） |
| `socks4.ts` / `socks5.ts` | 两版握手协议体（各只提供 `handshake` 一个方法） | 协议体的唯一住处 |
| `index.ts` | 层出口 | 跨目录一律 `@/core/forward/upstream/connector/index.js`；层内禁止自引 barrel |

**协议实现的住处是硬不变量，零例外。** 抽象最容易出的错是「实现没跟上抽象」：连接器只剩薄委托、真实现还躺在 `dial.ts`，于是想读「我们怎么做 SOCKS5 上游」的人去 `socks5.ts` 找不到东西——**可发现性极差**。所以 `open()` / `transport()` **就是**实现本体，不许再写回委托。

## 硬约定

- **对端身份只由声明式数据说了算**：`targetForm`（`"absolute"` = 对端是 HTTP 代理 / `"origin"` = 对端是源站）判「request-target 形态与是否注入上游凭证」；`kind` 判「Host 回写规则 / 连接器族」；`upstreamAuthHeader()` 判凭证面；`peerTarget(dest)` 判 `http.request` 的 host/port 与失败日志路由。⚠️ **`kind` 与 `targetForm` 是两个独立字段、端口对二者零约束**（`kind:"https"` + `targetForm:"origin"` 编译期完全合法）——**那是巧合，不是契约**。
- **连接器绝不销毁 socket、绝不向 `ctx.client` 写任何字节。** 成败应答一律归 channel。
- **`OpenedUpstream.refusal`（仅 http-connect 的非 200）由 channel 处置，语义刻意不同**：`tunnel` 是「原样透传 `head`+`rest` 给客户端再销毁上游」（不断链，`Proxy-Authenticate` 必须送达），`socks` 是「发 `upstream-refused` 事件 + 回 SOCKS 失败应答再销毁」（回 HTTP 报文会污染协议）。
- **记忆化挂在 startup 相位上**：`ConnectorSource` 的两个入口都只读**装配期定死的登记表**。⚠️ **哪天 `UPSTREAM_PROTOCOL` 被重分类成 runtime 相位（热改即时生效），这份记忆立刻变成第二真相源**——改完配置不重启，source 仍握着旧协议的连接器，且没有任何报错。那时必须**删掉记忆**（每次问表），**不是加失效钩子**：一个能被热改的键就该每次现读。改 `FIELDS` 里该键的 phase 前**必须**先读 `registry.ts` 模块头那一段。
- **fail-closed 的抛点固定在请求期**（`upstream()` 第一次被调），**不在装配期**。`??=` 右侧抛错时**不赋值**：非法协议每次都重新查、每次都抛，绝不会出现「第一次抛、第二次悄悄给一个直连」那样的旁路。护栏 `tests/integration/upstream-protocol-fail-closed.test.ts`（从**库路径**注入 `"ftp"`——`ConfigStore` 零校验故该分支可达——断言请求期表现为 `forward.error` + **源站零字节**，带一条合法协议对照组证明不是「怎么都不通」）。

## `OpenContext` 只有五个字段

`client` / `dest` / `onEvent` / `logPrefix` / `clientLifetime`。

- **没有 `viaUpstream` 标志位**（`kind` 就是连接器的身份声明），**也没有 `user` 身份字段**（`HelperEvent` 载荷只有 `type`/`message`/`err`；身份一律由 channel 侧的 `scope.emit` 带上）。四个 channel 传的都是 `onEvent: scope.emit`（同一个函数引用）。
- **`logPrefix` 必填**（四个 channel 恒传 `"http"` / `"tunnel"` / `"socks"` / `"upgrade"`）：`logPrefix?` + 三处 `?? DEFAULT_LOG_PREFIX` 那份缺省**零调用方**，却在三个连接器里各抄了一份常量，没有存在理由。**它刻意不由入站派发表给**——① 派发表只覆盖三个 `server.on` 事件，**SOCKS 根本不在表里**；② 本字段的使用点在转发器深处（`openUpstream` / `transportVia` / `openVia` / `forwardViaTransport`），要由派发表给就得给四个通道的入口方法逐请求加一个形参——把一个**通道的编译期常量**降级成**调用方可能传错的每请求参数**。前缀值是**落盘日志文本契约**。
- **`clientLifetime`（`"linked"` 缺省 / `"independent"`）必须由 channel 如实申报**：只有 channel 知道这次要的是隧道（`open()`，两端同一资源）还是每请求新建的传输层（`transport()` → `http.request`），connector 无从推断，故只透传、不自己设默认。

## `open()` 与 `transport()` 是两种「要什么」

- `open()` 给「到 dest 的字节管道」（CONNECT / socks 入站拿它自己桥接）。
- `transport()` 给「到**本连接器对端**的传输层连接、**不做协议级协商**」——http 普通请求要的是「连到我、但你自己写报文」，**Upgrade 通道也用它**。四类实现：direct 与 socks4/5 的 `transport()` 就是 `open().sock`；`HttpConnectConnector` 只拨号到上游。
- **因此 TLS 承载归连接器**：`transport()` 返回的 socket 已是握手完成的 `net.Socket`/`TLSSocket`，`channel/http.ts` 侧零 TLS 选项构造、零 `https` 模块 import。**不要**在 http 通道「顺手」把 TLS 选项加回来——那会出现两处协商。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

> 已被测试断言锁住的决策不在这里——它们的「结论 + 否掉了什么 + 为什么」写在**那条断言自己所在的测试文件的头注释**里（fail-closed 那两条在 `tests/integration/upstream-protocol-fail-closed.test.ts`；`clientLifetime` 与「不复用上游连接」那两条在 `tests/integration/http-inbound-keepalive-decoupled.test.ts`；`readReply` 住处与协议实现归属在 `tests/unit/dialer-protocol-boundary.test.ts`；SOCKS5 ATYP 与 SOCKS4a 哨兵/USERID 两条在 `tests/unit/connector-open.test.ts`）。本清单只留**没有任何测试会红**的纯设计取舍。

1. **`direct` 是同一张表的一行、不是特例分支** — 否掉「`source.direct()` 内部硬编码一个 `DirectConnector`」— 那会让「装配期定死一张表」这件事有一个例外，于是「每请求只查一张表」的不变式读代码时就不再成立。⚠️ 没有测试会红：改成硬编码照样能过 `expect(src.direct()).toBe(src.direct())`，只是「表」少了一行。
2. **「每请求查表」在本仓不存在，也不配 `WeakMap` 缓存** — 否掉「给查表加一层记忆化」— 两个入口都只读装配期定死的登记表，登记表本身是 startup 相位的解析结果；再配一份缓存只会制造第二真相源（协议键本来就不随 store 热改变变）。⚠️ 没有测试会红：「查表有没有缓存」在行为面**不可观测**（命中与否的输出一致），能被断言的只有**连接器实例**的记忆化（`expect(src.upstream()).toBe(src.upstream())`），那是另一件事。
3. **`peerTarget(dest)` 刻意带 `dest` 参数，而 `selfLoopTarget()` 无参** — 否掉「两者统一签名」— 后者答「**我自己的**上游地址」（纯配置事实、连接器独占）；前者答「本次请求的传输对端」——对直连/SOCKS 就是 `dest`，是**请求作用域事实**，连接器并不拥有，无参无从回答。传 `dest` 而非整个 `OpenContext`，是为了让这个纯查询不必拖上 `client` / `onEvent`（声明式方法不该有机会碰事件汇）。**两个成员是两种形状的刻意并存，不是签名不一致。** ⚠️ 没有测试会红：TypeScript 允许实现收窄形参，两种形状都能编译过，端口上也没有断言形参个数。
4. **`selfLoopTarget()` 是上游自环预检的唯一数据源** — 否掉「让 channel 读 `UPSTREAM_HOST` / `UPSTREAM_PORT` 去猜」— 那正是「自己读配置猜上游地址」的第二真相源（`denyUpstreamLoopAuto` 就是那种东西，别重建它）。返回 `undefined`（直连）就跳过预检。⚠️ 没有测试会红：channel 里重新读一次 `upstreamHost` 产出的自环判定与连接器那份**逐字相同**，没有任何断言会察觉那个第二真相源。
5. **`normalizeIp` 取自 `@/config/files/rules/index.js`，与 ACL 名单同一份实现** — 否掉「在 connector 里自己写一份 IP 归一」— 两份归一会漂，而漂的表现是「名单里 `::1` 拒了、路径上 `0:0:0:0:0:0:0:1` 放行」。⚠️ 没有测试会红：在 `socks4.ts` 里另写一份**正确**的归一，全部用例照样绿——「共用一份」这件事只有源码扫描能锁，而本仓没写那条扫描。
