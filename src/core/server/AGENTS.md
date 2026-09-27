# src/core/server — 入站建服骨架

`BaseProxy` 的生命周期状态机、派发表、入站两阶段准入、`ConnRegistry` 排空。

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `base.ts` | `BaseProxy`（`extends ContextualBase`，零 Node EventEmitter）/ `ConnRegistry`（`track` / `drain`）/ `closeServer()` / `authorize()` / `listenAsync` + `ListenableServer` | 生命周期、关服模板、准入的前半。**所有协议子类共用它** |
| `admission.ts` | `createInboundAdmission(...)` → `InboundAdmission`：`admitClientIp` / `authenticate` / `scopeFor` | 持有客户端 TCP 对端 / connectionId / requestId / 终态守卫四样事实 |
| `http.ts` | `HttpProxy` —— 三个 `server.on` 回调 + **派发表 `buildInboundChannels`** + `handleForward` 走两阶段准入 + `writeRejected` + `maskSensitiveHeaders` | HTTP / https 两种的共同骨架 |
| `https.ts` | `HttpsProxy extends HttpProxy` | **只重写 `doStart`** 建 TLS 服（证书经 `@/utils/tls/index.js:loadCerts` 读、选项经 `tlsServerOptions` 拼、握手告警经 `./tls-alarm.js:bindTlsClientError` 挂） |
| `factory.ts` | 按 `ProxyProtocol` 建实例 | — |
| `socks-base.ts` | `SocksProxyBase` + `PlainSocksProxy` / `TlsSocksProxy` | `createListener` 是明文 / TLS **唯一**差异点 |
| `socks-session.ts` | `runSocks4Session` / `runSocks5Session` | 经 `SocksSessionHost` 最小接口注入，**不含日志器** |
| `socks4.ts` / `socks5.ts` / `sockss4.ts` / `sockss5.ts` | 四个 21 行薄壳 | 只选 `createListener` 的差异 |
| `tls-alarm.ts` | `bindTlsClientError(server, log, protocol)` | `https.ts:doStart` 与 `socks-base.ts:onListenerReady` 共用一份实现 |

**不属于本层**：转发与上游（`../forward/`）、事件落盘（`src/runtime/event-log.ts`）、进程策略端口（`src/server/process.ts`）、握手 / 接入期告警的**文本词汇**（`../log-events.ts`）。

## 硬约定

- **状态机** `idle → starting → running → stopping → stopped`（含 `error`），`start()` / `stop()` 是幂等模板方法（`onBeforeStart` → `doStart` → `markStarted`）；`stop()` 在 `starting` 态先等在途 start。`setState` 发 `lifecycle.changed`，是 core **唯一**来源（`runtime.ts` 订阅它并只派生 `runtime.*`，**绝不再自己发一遍**）。
- **`ProxyOptions.ctx` 必填并原样（不冻结、不兜底）归一进 `Required<ProxyOptions>`**，并**同时**经 `super(options.ctx)` 落到基类（同一个对象）。core 内不存在任何依赖缺省解析。**缺省解析只允许发生在唯一组装根 `createProxyRuntime()`**。
- **缺省归一只在构造期发生一次**，是**全仓唯一**做这件事的地方：`identity` → `noneIdentity()` 冻结单例、`traffic` → `inertTrafficAccount()` 单例、`connectors` → `createConnectorSource(options.ctx)`；**`access` 必填、core 侧零缺省解析**（理由见 `../types/AGENTS.md`）。⚠️ **`connectors` 必须在任何转发器字段初始化之前就位**，故归一顺序是它先落、转发器字段后落。
- **`this.config` / `this.log` / `this.events` 是 `ContextualBase` 的继承 protected getter**，本目录不再自带任何投影。`events` **必须每次现读**，见 `../AGENTS.md`「依赖承载体」小节。
- **零日志禁令在本目录有一条例外**：握手 / 接入期把 SOCKS 非法握手、首包超时、TLS 握手失败经 `../log-events.ts` 的 `logBadRequest` / `logClientTimeout` / `logTlsClientError` 直写 `this.log`。见 `../AGENTS.md` 硬约定与 `tests/integration/tls-client-auth.test.ts`。
- **`ListenableServer` + `listenAsync` 只从 `base.ts` 取**（`listen` / `once` / `off` 的最小形状，net / tls / http.Server 结构满足）。禁止各自包 `listen` Promise。
- **`http.Server` 的 `connect` socket 按 `Duplex` 收，不收窄成 `net.Socket`** — 否掉「给 CONNECT 路径收窄」— 需要 `pipe` 的地方会逼出强转。
- **入站请求路径零实例化**：四个转发器实例**只**在这里组装（`HttpProxy` 构造函数 3 个 + `SocksProxyBase` 字段初始化器 1 个，全仓恰好 4 个构造点）。`HttpProxy` 的三个 `protected readonly` 转发器字段**刻意是 `protected`**：子类（含测试探针）能拿到实例断言复用行为。

## 入站派发表（「哪种事件走哪个转发器的哪个方法」的唯一一处）

`http.ts` 导出 `InboundKind = "request"|"connect"|"upgrade"`、`InboundEvent`（判别联合，每支字段由该事件的 Node 回调参数决定）、`InboundChannel<K>`（`forwardKind` + `rejectTarget(event)` + `dispatch(event, scope)`）、`buildInboundChannels(forwarders)` 与 `channelFor(channels, kind)`。`HttpProxy` 在**构造期**建一次表（`private readonly channels`），`handleForward` 只做一次表查。

- **三个 `server.on` 回调只做「Node 参数 → 统一形状」的适配**：回调体内零 `if (kind …)`、零三元选转发器、零 `Forwarder` 字样。加第 4 种入站事件的动作是「往表里加一项 + 加一个回调」，**不是复制一遍前置接线**。护栏 `tests/unit/inbound-dispatch.test.ts`（恰好三项 / 三种 `forwardKind` 互不相同 / 三个不同 `dispatch` 闭包 / 派发参数逐字 / 回调源码级负向）。
- **`forwardKind`（`ProxyForwardKind`）只服务一件事**：公共事件面 `request.started` / `forward.request-headers` / `forward.error` 的 `data.kind`（逐字契约）。**它不参与任何控制流**，也不承担「本种类归哪个转发器」——那件事由三个互不相同的方法名承载。理由见 `../types/AGENTS.md`。
- **SOCKS 不进这张表**（它不是 `server.on` 事件，而是连接内的握手状态机），但与本表共用 `admission.ts` 的两阶段准入与 scope 组装。

## 入站两阶段准入（`admission.ts`）

| | 阶段 A（握手前） | 阶段 B（握手后） |
|---|---|---|
| HTTP（`handleForward`） | `admitClientIp(403, respond)` | `authenticate(credentials, 407, respond)` → `scopeFor(user)` → 派发 |
| SOCKS（`onConn` → `socks-session`） | `admitClientIp(undefined, respond)` | **握手**（greeting / RFC1929 / SOCKS4 目标）→ `authenticate(credentials, undefined, respond)` → `scopeFor(user)` → 派发 |

- **`createRequestScope` 全仓唯一调用点就在 `scopeFor(user?)` 里**。两条入站路径都经 `admission.scopeFor(...)` 拿到作用域——`http.ts:handleForward`（每个 http/tunnel/upgrade 请求一条，`context` = `{protocol, client, target, requestId, connectionId}`）与 `socks-base.ts:sessionHost` 透传的 `scopeFor`（每会话一条，`context` = `{protocol}`；握手阶段不带 user，鉴权后带）。**别在 `server/**` 的别处再调 `createRequestScope`**，那是身份注入的第二个入口。
- **终态的 `client` 恒为 TCP 对端**（两条路径一致）；`eventContext.client` 恒为 `getClientAddress(req)`（展示 / 审计口径）。**两者是不同的事实，刻意不合并**。终态不含 `scopeContext.client`。
- **`authenticate` 只覆盖「凭证判定不通过」**（reason 恒 `"proxy-auth-required"`、stage 恒 `"auth"`）；握手解析失败那类**不是凭证判定**的拒绝（非法 SOCKS4 报文 / 非法 RFC1929 帧 / 非法 greeting）仍归 `socks-session.ts` 的状态机。凭证侧事实由 SOCKS 侧合成（RFC1929 → `proxy-authorization: Basic …`、`req` 只有 `{headers, socket}`），`requestId` / `connectionId` 由准入层注入。
- 护栏 `tests/integration/inbound-admission-order.test.ts`（HTTP 与 SOCKS 各自三关的顺序与事件逐条锁死，含「SOCKS 握手应答字节先于 `auth.decided` 出现」这条把**结构差异**钉成可观测顺序的断言）。

## `ConnRegistry.drain(server)`：原生优化 + 兜底销毁，**两样都做**

**Node 的 `closeAllConnections()` 只覆盖它自己的连接表**——`connect` / `upgrade` 事件发出后该 socket 已脱离这张表，故**只走原生调用就拆不掉活着的 CONNECT / WebSocket 隧道**，`closeServer` 的 `server.close(cb)` 永不回调、`stop()` 挂死。

现语义：先按需 `closeAllConnections()`（http/https 有；SOCKS 的 `net.Server` / `tls.Server` 没有，走不到），**之后一律**遍历 `this.conns` 逐条 `destroy()`（`destroyed` 判断保证重复销毁无害）再 `clear()`。分工：原生调用一次性覆盖 idle keep-alive 那一大类，兜底循环负责它结构上覆盖不到的升级连接与任何非 http 承载。回归护栏 `tests/integration/stop-drain-live-tunnel.test.ts`（活隧道 / idle keep-alive / 零连接三档，各自带明确超时预算 + 停服后同端口可重绑断言）。写涉及活隧道的测试不再需要绕开 `BaseProxy` 生命周期。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

> **判据被测试断言锁住的条目不在这里。** 那类决策住在**断言它的那条 `*.test.ts` 自己的开头条注释**里
> （判据变红时读到它的人就是该改它的人）。

1. **`BaseProxy extends ContextualBase`、零 Node EventEmitter** — 否掉「`server.on(...)` 之外再开一条 core 内 EventEmitter 总线」— core 的全部事实走注入的 `EventHub`（见 `../AGENTS.md` 硬约定）。⚠️ **零断言**：`core-context.test.ts` 只证明 `ContextualBase` 自己存在且三个 getter 是 `protected`，**没有一条断言说 `BaseProxy` 继承它**；「`grep -rn "node:events" src` 零命中」也没有源码级护栏。
2. **`authorize()` 捕获 `identify()` 的异常转 deny，并直接发布 `auth.decided`** — 否掉「异常向上抛给协议层各自处理」— 身份判定失败就是拒绝，异常路径与正常 deny 路径必须落同一个终态与同一份审计；散开就会出现「异常时没有 `auth.decided`」。⚠️ **只有前半句有断言**（`base-lifecycle.test.ts` 的 `expect(ok.passed).toBe(false)`）；**「异常那一次也留 `auth.decided`」零断言**——`core-event-bridge.test.ts` 那两档用的是「返回 `passed:false` 的判定器」而不是抛错的判定器。
3. **`scopeContext` 同时决定哪些关联 id 进入 scope 的身份维度** — 否掉「id 走独立形参」— 同一个事实不许两个入口（`emit` 把身份合并进发布的 `context`，理由与判据见 `../AGENTS.md`「请求作用域与终态」一节）。**SOCKS 刻意只传 `{protocol}`**：SOCKS 的 pipe 事件不带 id，**补 id 就是改事件载荷**。这是**内容**差异、不是**形状**差异。⚠️ 「id 只有一个入口」有断言，**「SOCKS 的 pipe 事件不带 id」零断言**。
4. **`channelFor` 不是运行期逻辑，是「把种类已确定这件事告诉类型系统」** — 否掉「简化成 `channels[kind]`」或「加查表失败的兜底」— `channels[kind]` 在 `kind` 放宽成 `InboundKind` 时会退化成三个通道类型的**并集**，其 `dispatch` 收不了 `InboundEvent`（三个形参类型求交等于无解）。`channelFor` 按映射类型的索引访问（`InboundChannels[K]`）把泛型带回来，事件的判别键与通道签名因此逐字对齐——`connect` 那支写 `event.head` 能编译，误写成 `event.res` 立刻编译期红。⚠️ **零断言**：`inbound-dispatch.test.ts` 用到 `channelFor` 证明的是「它存在且能用」，不是「不能用 `channels[kind]` 代替」；「泛型带回来」靠 `tsc --noEmit` 顺带兜着。
5. **头掩码 `maskSensitiveHeaders` 就近放 `http.ts`、不进 `helpers/`** — 否掉「进公共工具面」— 归属判据是「core 事实 → 可展示形态」而非「日志文本拼装」；它只被 `handleForward` 一处调用（已覆盖三种 kind）。与出站头剥离那套方向相反的判据（理由与判据见 `tests/unit/core-event-bridge.test.ts` 头注释第 ④ 条 + `tests/unit/identity-credential-seam.test.ts` 头注释第 ② 条）。⚠️ **判据有断言、归属零断言**：把它挪进 `helpers/headers.ts` 不会让任何用例变红。
6. **`tls-alarm.ts` 住 core 而非 `utils`** — 否掉「搬去 `src/utils/cert.ts`」— `utils` 是依赖树最底层，握手告警需要「core 事实 → 日志文本」翻译层，放 utils 会逼出 `utils → core` 的反向依赖。⚠️ 零断言（`bindTlsClientError` 在 `tests/` 里零命中），纯依赖方向取舍。
7. **`sessionHost` 收 `InboundAdmission`（不是 `terminal`）** — 否掉「把终态守卫交给 SOCKS 会话」— `authenticate` 与 `scopeFor` 都是准入层方法的透传，**本地不再实现任何准入逻辑**；SOCKS 侧要写字节（8 字节二进制 reply），手握终态守卫就等于让它有可能在别处结算终态。⚠️ 零断言（`sessionHost` 在 `tests/` 里零命中），纯归属取舍。
8. **`doStart` 以 `.catch` 兜住 `onConn` 的意外抛错**（销毁 socket 并发 `clientError` 上抛）— 否掉「让它变成 unhandledRejection」— core 零日志，那条路径上没有别的地方会报出来。⚠️ 零断言（没有用例构造「`onConn` 抛错」），靠本条与源码。
9. **SOCKS 的 pipe 事件不带 `requestId` / `connectionId`，且刻意不补** — 否掉「为了可串联就补上」— 补上就是改事件载荷。需要按 id 串联时读 `terminal.snapshotContext()`。这与 `../AGENTS.md`「请求作用域与终态」一节是同一条纪律的两面。⚠️ 零断言：`core-event-bridge.test.ts`「pipe 未带 requestId 时不臆造」锁的是**桥接器不臆造**，不是「SOCKS 不带 id」；`request-scope-ids.test.ts` 的 SOCKS 那档锁的是**终态**事件的 id，不是 pipe 事件的。
