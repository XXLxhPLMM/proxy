# src/core — 代理内核

`types/`（唯一类型源）→ `server/`（建服骨架）→ `forward/`（转发器）+ `auth.ts` / `guard.ts` / `access-control.ts` / `helpers/`（共享工具目录）+ `log-events.ts`（core 事实 → `[event-code]` 文本词汇层）。各文件头 `@fileoverview` 是第一手说明，本文件只收敛跨文件的约定与禁区。

**依赖方向单向**：`core/server → core/log-events → utils/logger`，core **不再反向依赖 `src/server`**（原 `server/log/events-log.ts` 已下沉为 `core/log-events.ts`，导出符号一字未改）。core 只允许 import `@/utils/*` 与 `@/config/*`；**禁止** import 任何 `@/server/*`。跨目录优先走层 barrel（`@/utils/{logger,constants,tls,json-file}/index.js`、`@/config/files/rules/index.js`、`@/core/helpers/index.js`）；`utils/ip.ts` 与 `utils/host-text.ts` 是单文件叶子、无 barrel，只能直接引。

配置类需求**不要**放进 core：`config/files/acl.ts` 只管读名单，请求期判定归 `core/access-control.ts`，配置契约/来源/归一化归 `src/config/`。

## 类型（`types/`）

- `proxy.ts` 是 Single Source of Truth；`auth.ts` / `pipe.ts` 叶模块只做 `export type` 转发，禁止新增独立类型。
- `proxy.ts` 对外**唯一**一条出边是 `import type { LogEvent } from "../log-events.js"`（9 个 pipe 判别键的权威，见下「管道事件判别联合」）；`import type` 编译期擦除，保持「零运行时」不变量。除它之外禁止 `types/` 引任何 core 兄弟模块。
- 已删除、无需兼容：`types/connector.ts`、`types/server.ts` 整文件，`ProxyHttpServer`、`TokenExtractor`、`UpstreamTarget`、`DialHandle`、`ConnectorDial` 等，`AuthOptions.extractor` 假扩展点。

## 鉴权（`auth.ts`）

- 账号住在 `AUTH_USERS_FILE`（`cfg/users.json`），**不在** env。`createAuthFromConfig(config)` 的 config 为必填 `ConfigAccessor`；它每请求经该 accessor 现读 live store + 账号文件（热加载），改 runtime 配置下次请求即生效。
- `basic` 命中任一账号的用户名+密码；`uid` 只比用户名；`jwt` 用户名取 token 的 `sub/username/user/uid/id`。凭证索引住在 `helpers/credentials.ts`（`buildCredentialIndexes` / `credentialIndexesFor` 单槽记忆 / `matchBasicCredential` / `matchUidCredential`，`Auth` 只做薄委托，保证出站头剥离与鉴权用同一判据），结果带回 `username` 供逐连接日志。
- 失败闭环：账号形状非法 abort 启动（`validateAuthUsers`）；`authEnabled + basic|uid + 空表` abort（`assertAuthConfig`，见 `src/config/AGENTS.md`）；`authenticate()` 内异常一律 deny（`BaseProxy.authorize()` 捕获）。
- Token：`Proxy-Authorization` 优先、`Authorization` 回退（RFC 7235，scheme 大小写不敏感）。
- 凭证防泄漏：`isProxyCredentialValue()` 命中代理自身凭证时，`sanitizeHeaders` / Upgrade 报文必须剥掉该 `Authorization`；其余 `Authorization`（如目标 `Bearer`）原样转发。basic/uid 走**整份账号表**比对；**jwt 也参与出站剥离**——剥 scheme 前缀后按 `isJwtShape` + `verifyHs256Jwt`（内置 HS256 + `JWT_SECRET`）验签判定，不依赖账号表（jwt 允许空表，该分支必须先于空表早退）。判据唯一收口在 `isStrippableOutboundHeader`（任意 `proxy-` 前缀 + 凭证形态）。已知边界：自定义注入的 `jwtVerify` 不被剥离判据感知（只认内置 HS256；生产默认注入内置校验器），方向仍是「宁可多剥不泄漏」。
- JWT：默认注入内置 HS256 校验 `defaultJwtVerify`（薄 async 包装 `proxy-helpers:verifyHs256Jwt`，`node:crypto` 零依赖：验签 + `exp`，永不抛，与出站剥离共用同一实现）；显式注入优先；直构 `Auth` 未注入即 deny（审计照打）。
- `basic` 在 socks4/sockss4 额外接受 `USERID == username`（无密码字段）。
- 审计 `tag` 为 `"tunnel"` 仅当 `method === "CONNECT"` / `socks*` 协议 —— 不许用 `authority.includes(":")` 判定。`Auth` 零日志，审计经 `onAuthEvent` → proxy `auth` 事件 → server 层落盘。
- SOCKS 鉴权发生在握手后：socks5/sockss5 走 RFC1929 user/pass（auth 启用时），socks4/sockss4 用 USERID。

## 转发器（`forward/`）

- 四个转发器（http/tunnel/websocket/socks）继承 `base.ts:ForwarderBase`：共享 `dialer` / `emit` / `emitWithUser`（身份经参数逐次传入，**不许存字段**，SOCKS server 复用同一转发器实例会串号）/ `preDial` / `emitRoute`（路由事件，core 零日志）/ `denyUpstreamLoop(+Auto)` / `refuse` / `refuseByCause`。事件统一为 `PipeEvent`（泛型已删；`HelperEvent` 现为 `PipeEvent` 的真子集、可直接传入，索引签名已随判别联合一并去除）。
- **刻意不收的**：各协议应答形态（HTTP `ServerResponse` 早失败、SOCKS 二进制应答、tunnel 回 200、websocket 等 101）——强行模板化是假抽象；余量回灌 + 桥接已由 `bridgeWithBuffered` 收口（`establishTunnel`/`establish` 只剩应答 + 委托）。
- `dial.ts:Dialer`：`dialDirect` / `dialTls` / `choose` / `dialViaHttpUpstream`（tunnel/socks 共用：拨 http(s) 上游 → 发 CONNECT → 等状态行；**绝不向客户端写字节**，成败应答归调用方；超时抛 `DialTimeoutError` 供调用方回 504）/ `dialSocks`（版本与 TLS 由 `socksVersionOf` / `isTlsUpstreamProto` 推导）/ `bridge`。`readReply` 用 pause + `read(n)` 精确消费（跨 TCP 分段与余量回灌；**不许**在 data 回调里 `unshift`）。`handshakeSocks5` 的 CONNECT ATYP 按 `normalizeIp` 判族（该原语现居 `@/config/files/rules/index.js`，与 ACL 名单同一份实现）：family 6 用 `SOCKS5_ATYP_IPV6` + 16 字节地址（域名型是字符串、无 v6 语义），IPv4/域名沿用 `SOCKS5_ATYP_DOMAIN`（刻意简化）；SOCKS4a 无地址族字段，IPv6 亦按域名串交给上游（不加分支）。
- `socks.ts:SocksForwarder`：握手解析（`readGreeting` / `readUserPass` / `parseSocks4` / CONNECT）+ `connect()`（`connectVia` 收敛三条上游分支模板；`badRequest` 收敛握手非法；`establish` 回灌余量后桥接）。
- `socks-reader.ts:SocksHandshakeReader`：握手缓冲读取器（`readExactly` / `readUntil` / `takeBuffered` + `dispose`），server 与 forwarder 共用，解决分段与 pipelining。
- `guard.ts`：`guardDialing`（上下游超时/错误/半关闭联动；`keepClientOnFailure` 置位 → 只毁上游、客户端留给调用方应答；**空 reply ≠ 调用方会写**，必须显式置位）/ `socksUpstreamGuard`（空回复 + 保客户端 + 成因上抛的选项工厂）/ `readResponseHead`（字节封顶 + CRLFCRLF + 严格状态码，**不毁 socket 不写应答**）/ `awaitStatusLine`（返回 `StatusLineResult` 判别联合，失败时毁上游，客户端收尾归调用方）。零日志，事件上抛。
- `helpers/`（原 `proxy-helpers.ts` 962 行拆成 **8** 个职责文件 + barrel，跨目录只引 `@/core/helpers/index.js`；层内相对引用，禁止自引 barrel）。导出面 = **32 个值符号 + 5 个类型符号**，其中 `buildProxyAuthValue`（原在 `utils/constants`）与 `isSelfLoopAddr`（原在 `utils/ip`）是本次从 utils 迁入的，其余符号逐字不变。依赖无环：`credentials` / `target` / `self-loop` 是叶子 → `headers`/`upstream`/`route`/`wire` → `predial`。
  | 文件             | 只负责                                                                                                                                                                       | 依赖          |
  | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
  | `credentials.ts` | **纯**凭证原语：索引编译+单槽记忆 `indexMemo`、Basic 令牌解析、内置 HS256 验签、`buildProxyAuthValue`（basic 编码，上游凭证头用）。零 config、零 IO                          | 叶子          |
  | `target.ts`      | **纯**目标地址解析：host 白名单、authority 拆分/拼装（IPv6 方括号，剥壳走 `@/utils/host-text.js`）、目标三元组                                                               | 叶子          |
  | `self-loop.ts`   | 自环判定 `isSelfLoopAddr`（零 config、零 IO）；私有 `canonicalHost` 复用 `@/config/files/rules` 的 `normalizeHost`/`normalizeIp`/`ipToString`，**与 ACL 名单同一份归一实现** | 叶子          |
  | `headers.ts`     | 出站头剥离判据与净化。**`isProxyCredentialValue` 必须留在这里**（它读 `authEnabled`/`authType`/`jwtSecret` + `loadAuthUsers`，放进来会破坏 `credentials.ts` 的纯函数不变量） | `credentials` |
  | `route.ts`       | 路由判定（`resolveRoute` / `resolveForwardTargets`），**有效模式唯一入口**                                                                                                   | `target`      |
  | `upstream.ts`    | 上游协议映射（`isSocksProto`/`socksVersionOf`/`isTlsUpstreamProto`）+ 上游 Basic 凭证头                                                                                      | `credentials` |
  | `wire.ts`        | 线缆字节：出站 CONNECT 报文 / 裸 socket 状态行应答 / 写完延时销毁                                                                                                            | `target`      |
  | `predial.ts`     | 拨号前守卫：自环（`isSelfLoop` 薄委托 `./self-loop.js`）+ 目标名单 + 拒绝收尾回调                                                                                            | `self-loop`   |
- **有效模式唯一入口仍是 `resolveRoute(dest, config)`**（现居 `helpers/route.ts`）：配置 server 短路 `{mode:"server", route:"direct"}`（不查 `upstream` 组）；配置 client → `acl:checkUpstreamRoute(host, config)`，名单命中回落 `{mode:"server", route:"direct", reason}`（dial/path/凭证/Host/secure 全按 server 语义自然回落），否则 `{mode:"client", route:"upstream"}`。`resolveForwardTargets` 成对给出 `{dial, dest, route}`（dial 按有效模式选），四个转发器后续分支一律用 `route.mode`、**禁止在请求路径绕过 accessor 裸读任何配置**（唯一结构性早分支：websocket 的 socks 上游在目标尚未解析时自行调用同一 `resolveRoute`）。`resolveRoute` 纯函数不打日志；路由事实经 `forward/base:emitRoute` 发 `route` 事件（**过 preDial 每请求恰一条、拒绝路径与 server 模式短路零条**），`[route]` info 行（字段 `target`/`route`/`reason`）由 `src/server` 落盘、与事件 1:1。目标主机必过 `isValidTargetHost`（`helpers/target.ts`，字符白名单 + 255B，防 CONNECT/SOCKS 报文注入与长度域截断）。`guardPreDial`（`helpers/predial.ts`）语义：自环看 `dial`、名单看 `dest`（**名单永不判上游**，见 `src/config/AGENTS.md` 访问控制）。自环判定的唯一实现是 `helpers/self-loop.ts:isSelfLoopAddr`（原 `utils/ip.ts`，签名不变），`isSelfLoop(h, p, config)` 只做一层薄委托。`UPSTREAM_URL` 是 startup 相位，loadConfig/纯内存 runtime 共用校验与拆项入口；请求路径只消费已构造值，改 URL 必须重建 runtime，覆盖拆项 warning 保留。

## 服务端骨架（`server/`）

- `base.ts:BaseProxy`：状态机 `idle → starting → running → stopping → stopped`（可重入 `starting`），`start()`/`stop()` 幂等模板方法；`stop()` 在 `starting` 态先等在途 start。`ProxyOptions.config` 必填并在归一化后原样传给所有协议组件，不存在全局默认；未给 `auth` 时明确创建 `new Auth({ enabled: false, enableLogging: false })`，即显式 disabled；未给 `logger` 时使用 `createNoopLogger()`，绝不回退全局 logger。`ConnRegistry`（`track`/`drain`，http/socks 共用一份）+ `closeServer()` 关服模板 + `authorize()`（异常转 deny）。**建服对称面也住这里**：`listenAsync(server, port, host)` 与 `ListenableServer`（net/tls/http.Server 均结构满足的最小形状：`listen`/`once`/`off`）——原在 `utils/net.ts`，该文件已删；`http.ts`/`https.ts`/`socks-base.ts` 一律从 `base.js` 取，禁止再各自包 `listen` Promise。根 AGENTS.md 只保留状态机契约。
- `factory.ts` 按 `ProxyProtocol` 建实例；`http.ts`（`HttpProxy`：request/connect/upgrade 三通道 + `handleForward` 名单→鉴权→委派 + `writeRejected`）被 `https.ts` 继承复用（仅重写 `doStart` 建 TLS 服：证书材料经 `@/utils/tls/index.js:loadCerts` 读、选项经 `tlsServerOptions` 拼、握手告警经 `./tls-alarm.js:bindTlsClientError` 挂）。
- `tls-alarm.ts:bindTlsClientError(server, log: EventLog, protocol)`：TLS 握手/客户端证书告警接线，`https.ts:doStart` 与 `socks-base.ts:onListenerReady` 共用一份实现。**它住在 core 而非 utils**（原 `utils/cert.ts`）：`utils` 是依赖树最底层，握手告警需要「core 事实 → 日志文本」翻译层，放 utils 会逼出 `utils → core` 的反向依赖。事件码/文本格式在 `../log-events.js`。
- `socks-base.ts`（`SocksProxyBase` + `PlainSocksProxy` / `TlsSocksProxy`：`createListener` 是明文/TLS 唯一差异点）+ `socks-session.ts`（`runSocks4Session` / `runSocks5Session`，经 `SocksSessionHost` 最小接口注入，**不含日志器**）。四个 SOCKS server 文件是 21 行薄壳；监听器 `error` 与 http 同形发 `serverError` 事件。
- `socks-base.ts:onConn()` 首行过客户端名单（拒绝走 `pipe` 的 `ip-denied`，与 http 同形）；握手后 `authorized` 兜底是保险，主力是 `tlsClientError`（接线与边界见下条「core 零日志禁区」与 `core/log-events.ts`）。`doStart` 以 `.catch` 兜住 `onConn` 的意外抛错：销毁 socket 并发 `clientError` 上抛（core 零日志），避免 unhandledRejection。

## 本目录 Gotchas

- `http.Server` 的 `connect` socket 是 `Duplex` 不是 `net.Socket` —— 全链路用 `Duplex`。
- Status-line 等待（CONNECT 的 200、Upgrade 的 101）统一走 `awaitStatusLine`；`upstreamTimeout` 只兜时间不兜内存（另有字节封顶）。
- SOCKS 域名是客户端原始字节（不过 HTTP 解析器）：解析/建握手前必过白名单。
- SOCKS4a 哨兵判 `DSTIP ∈ 0.0.0.0/24`：规范草稿写全 0、curl/PySocks 发 `0.0.0.1`，两者都得认；漏全 0 会误判纯4、域名残渣被当载荷打进隧道（客户端拿假 90 后收到 400）。护栏在 `tests/integration/socks-handshake.test.ts`，脚手架 `socks4aRequest(..., dstip)` 可改哨兵。
- client 模式经 http/https 上游的 Upgrade 报文保留 absolute-form + 注入 `Proxy-Authorization`（`buildUpgradeReq(..., toUpstreamProxy)`）；经 SOCKS/直连用 origin-form 且绝不带上游凭证。分流唯一依据是 `resolveRoute` 的**有效模式**（`route.mode`）：client 配置命中 `upstream` 路由名单即回落 server（直拨真实目标），请求路径不许裸读 `proxyMode`（见上方 `helpers/` 条）。
- 拨号失败成因区分：超时（`DialTimeoutError`）→ 504，其余 → 502；SOCKS 回 FAIL 不区分。catch 里一刀切 502 会吃掉超时成因。
- **转发报文 authority 一律经 `formatAuthority` 补 IPv6 方括号**：解析侧 `parseTargetParts`/`parseAuthority` 刻意剥方括号以便 `net.connect` 直用，拼装侧不补会产出 `CONNECT ::1:443` / `Host: ::1:443` 畸形报文。已收口：`buildConnectRequest`、`buildUpgradeReq` 的 Host 回写、`http.dialViaSocksAndForward` 的 Host 重写。
- `tunnel.handle` 解析 authority 失败回 **400**（客户端请求报文非法，与 http/websocket 解析失败语义一致）；502 只留给网关侧失败。
- `WsForwarder.relay` 非 101：透传 `head`+`rest` 后按 `upstream.readableEnded` 分流——已 EOF 则 `client.end()`，否则 `upstream.pipe(client)` 续传剩余 body（`Content-Length` 大于首包时客户端不挂等）；**`readableEnded` 分支不可删**（`'end'` 可能早于续体挂 pipe 前发出）；上游错误/关闭收尾归 `guardDialing` 既有 handler，不额外 destroy。
- `cfg/users.json` / `cfg/acl.json` 热加载语义（1s 节流、坏文件保留旧值、缺失=空；仅 `ENOENT`/`ENOTDIR`/非普通文件算缺失，其它 stat 错误如 `EACCES` 保留旧值并发 error，ACL 不静默全放行；相对路径先绝对化）见 `src/config/AGENTS.md`。
- **core 零日志禁区（保留一条既有例外）**：`src/core/**` 禁止直接打印日志（生命周期行也不行），**请求期**事实一律经事件上抛（`pipe`/`serverError`/`auth`/`forward`…），落盘收在 `src/server/index.ts:bindProxyEventLogs`。**唯一保留的例外**：`core/server` 在**握手/接入期**（请求尚未成立、无 pipe 事件可挂）把 SOCKS 非法握手、首包超时、TLS 握手失败经 `@/core/log-events.js` 的 `logBadRequest` / `logClientTimeout` / `logTlsClientError` **直接写进当前实例注入的 `this.log`**。这是「进程内告警端口」而非转发管道落盘，DI 契约被 `tests/integration/tls-client-auth.test.ts` 锁定（直构 core 并 spy 注入实例的 `warn`），改这里必须同步改那个测试。`this.log` 的其余唯一用途是把 logger 显式传给 `@/utils/tls/index.js:loadCerts` 等告警端口；**不得**调用 `getLogger()` 或任何全局 logger 回退。事件码词汇表 `LogEvent` 与各事件文本格式住在 `core/log-events.ts`（**不在** `server/log/`），`server/index.ts:bindProxyEventLogs` 也从那里取事件函数。**事件码是类型级唯一真相源**：`LogEventCode = (typeof LogEvent)[keyof typeof LogEvent]`，`makeEvent` / `makeExtraEvent` 的 `code` 形参一律收口到它（表外或拼错的码在编译期即失败，新增码只加 `LogEvent` 一行）。
- 串联矩阵回归：新增入站×上游×证书组合时必须在 `tests/integration/upstream-matrix.test.ts` 补一档；名单语义与 `[route]` 路由事件护栏在 `tests/integration/client-mode-acl.test.ts`、`[route]` 落盘全链路在 `tests/integration/log-structured.test.ts`。

## 事件内核（`events/`）

- `src/core/events/types.ts` 是新事件契约的类型单一来源：`AppEventMap` 以元组声明参数，`EventData` 取元组首项作为实际 payload；`EventEnvelope` 携带只读事件名、关联上下文、payload 和时间戳，`EventContext.runtimeId` 必填，connection/request 作用域可选。
- `EventHub` 只公开 `publish` / `subscribe` / `once` / `listenerCount` / `removeAll` / `EventHub.merge`，内部订阅表和分发实现不得暴露 Node `EventEmitter`；runtimeId 缺省由 `crypto.randomUUID()` 生成。发布时 context 浅拷贝并补齐 runtimeId，订阅返回的 `EventSubscription.dispose()` 幂等。
- 分发使用 listener 快照：emit 期间新增或 dispose 不改变当前这次迭代；单个 listener 抛错会被隔离并交给 `onListenerError`。缺省完全静默，既不打印也不读取 `process.env.NODE_ENV`；只有显式 `reportListenerErrors: true` 才走 `process.emitWarning`，或由调用方直接传 `onListenerError`。listener 异常不得影响其它 listener 或 `publish` 返回；`removeAll()` 释放全部订阅，后续 publish 是安全空操作。
- 作用域层级固定为 `runtime → connection → request`：`EventScope.child()` 继承父级 id，可覆写/补 protocol/client/user/target；`toContext()` 只返回不含 runtimeId 的 publish 上下文，`withIdentity()` 返回身份补全后的独立快照。作用域只承载关联事实，不保存日志或控制状态。
- 事件只发布已经发生的事实，不驱动控制流：鉴权、访问控制、路由、请求完成/拒绝/失败等结果由生产方发布，订阅方只观察；事件内核不直接打印日志，日志落盘仍收在 server 层。
- 当前 `AppEventMap` 事件清单：`runtime.starting`、`runtime.started`、`runtime.stopping`、`runtime.stopped`、`runtime.error`、`lifecycle.changed`、`config.loaded`、`config.changed`、`config.restart-required`、`config.file-error`、`config.file-recovered`、`config.file-reloaded`、`auth.decided`、`access.client-denied`、`access.target-denied`、`route.selected`、`request.started`、`request.completed`、`request.rejected`、`request.failed`。

## 配置访问器（`ConfigAccessor`）

- `src/config/context.ts` 是 core 读配置的**唯一端口**（一律经 `@/config/index.js` barrel 引用）：`ConfigAccessor` **只有泛型 `get`**，没有 `getAll`、`set` 或任何隐式全局状态；`configAccessorFromStore(store)` 从调用方实例派生 live reader。core 不创建配置状态、不导入模块级 Map，也不存在 `globalConfigAccessor`。
- **数据层与策略层分离**：`config/files/acl.ts` 只负责读文件、校验结构、返回 `AclConfig`；**请求期判定全在 `core/access-control.ts`**（`checkClientIp`/`checkTargetHost`/`checkUpstreamRoute` + 按 accessor 隔离的编译缓存 `WeakMap` + `bindAclFileEvents`）。core 侧只 import 判定层，config 侧不认识请求语义；改名单语义只动 core，改文件格式只动 config。**名单条目原语**（`normalizeIp`/`ipToString`/`parseIpRule`/`compileIpRules`/`ipMatches` 与 `normalizeHost`/`parseHostRule`/`compileHostRules`/`hostMatches`）住在 `config/files/rules/{ip,host}.ts`（acl.json 的规则/数据层，原 `utils/ip-list.ts` + `utils/host-list.ts`），core 侧（`access-control.ts`、`forward/{dial,socks}.ts`、`helpers/self-loop.ts`）一律经 `@/config/files/rules/index.js` 取，config 目录内部则用相对路径。
- **core 全链路只经必填访问器读配置**：`helpers/{route,predial,headers}`（路由/自环/凭证剥离）、`forward/{base,dial,http,tunnel,socks,websocket,socks-reader}`、`auth.ts`、`server/{base,http,socks-base}` 一律读构造期注入的 `this.config` / `this.options.config`；HTTP/SOCKS server 把它透传给转发器、鉴权、ACL 与 `RequestTerminal`，`ForwarderBase` 再原样透传给 `Dialer`，保证同一实例全链路读同一 accessor。
- **所有会读配置的参数/选项均必填，不设全局默认**：`resolveRoute(dest, config)`、`resolveForwardTargets(url, host, config)`、`isSelfLoop(h, p, config)`、`upstreamAuthValue(config)`、`upstreamAuthHeaderLine(config)`、凭证判定/清洗函数、`guardPreDial({ config, ... })`、`createAuthProvider(options, config)`、`createAuthFromConfig(config)`、`ForwarderBase(sink, config)`、`Dialer(config)`、函数式转发入口、`readAcl/readAuthUsers` 的 `opts.config` 以及 ACL load/check 函数都必须显式传 `ConfigAccessor`。`loadCerts` 自身不读配置键（材料来自显式 `TlsInput`）；`readUpstreamCa(config)` / `upstreamTlsOptions(..., config)` 才读取配置。三者现统一从 `@/utils/tls/index.js` 取（原 `utils/cert.ts` 已拆成 `tls/{certs,server-options,upstream}.ts` + barrel）。
- **`ProxyOptions.config` 是强制隔离位**：`BaseProxy` 将其原样归一进 `Required<ProxyOptions>`，不做 `?? global` 或其它回退。runtime/CLI/server 由各自 `ConfigContext.accessor` 注入；低层调用方则从自己的 `ConfigStore` 派生 accessor。
- **日志同样显式**：`ProxyOptions.logger` 可注入但缺省为 noop。`HttpsProxy` / `TlsSocksProxy` 只把归一后的 `this.log` 传给证书加载（`loadCerts`）与 TLS 握手告警（`bindTlsClientError`）；文本格式经 `core/log-events.ts` 翻译，不在此层拼字符串；不得使用 `getLogger()`、默认 logger 或任何配置全局量。
- **生效模式唯一入口仍是 `resolveRoute(dest, config)`**：判定使用该 accessor 的 `proxyMode` + `checkUpstreamRoute(host, config)`，判定对象、server 模式短路、名单命中回落、真值表与 `[route]` 事件「过 preDial 每请求恰一条、server 模式零条」全部不变。请求路径仍禁止绕过该入口裸读配置；websocket 的 socks 上游早分支也必须调用同一 `resolveRoute`。
- 本节 Gotchas：显式 config **只决定「读哪份 store」**；runtime accessor 对 runtime 相位字段现读 live store，对 startup 字段读 runtime 构造时冻结值。`UPSTREAM_URL` 也属于 startup，loadConfig/纯内存 runtime 必须共用校验/拆项入口。`readJsonCached` 仍 1s 节流，ACL 编译结果按 `WeakMap<ConfigAccessor, CompiledAcl>` 隔离；相对路径在进入缓存前绝对化，只有 `ENOENT`/`ENOTDIR`/非普通文件算 missing，`EACCES` 等其它 stat 错误保留上一份有效值并发 error。`https.ts`/`TlsSocksProxy` 的 `loadCerts(this.options.tls, this.log, protocol)` 保持显式，不回落到 accessor 读取。回归护栏：`tests/unit/config-access.test.ts`（无全局、实例隔离、热改现读、ProxyOptions/auth/route 显式绑定）、`tests/unit/proxy-helpers.test.ts`、`tests/unit/self-loop.test.ts`（自环归一与 ACL 名单归一同一份实现）、`tests/unit/log-events.test.ts`（事件码与文本格式）、`auth.test.ts`、`base-lifecycle.test.ts`、`integration/tls-client-auth.test.ts`（显式 logger + 握手告警直写注入实例）。

## 管道事件判别联合（`PipeEvent`）

- `PipeEvent` 以 `type` 为字面量判别键的 14 变体判别联合取代原弱类型事件袋：每个变体只暴露已声明字段，不带索引签名；生产者与消费者必须按同一契约演进，禁止恢复 `Record<string, unknown>` 式任意字段。
- 生产者为 `src/core/forward/*`、`src/core/guard.ts` 等 core 事实产生方，统一经 `ForwarderBase.emit` / `HelperEventSink` 上抛；消费者为 `src/server/index.ts:bindProxyEventLogs`，按 `type` 分支落盘，不做未知强转。
- 变体清单：`PipeTargetUnresolvedEvent`（`target-unresolved`）、`PipeLoopDetectedEvent`（`loop-detected`）、`PipeRouteEvent`（`route`）、`PipeUpstreamRefusedEvent`（`upstream-refused`）、`PipeUpstreamErrorEvent`（`upstream-error`）、`PipeUpstreamTimeoutEvent`（`upstream-timeout`）、`PipeIpDeniedEvent`（`ip-denied`）、`PipeTargetDeniedEvent`（`target-denied`）、`PipeSocksEvent`（`socks`）、`PipeBadRequestEvent`（`bad-request`）、`PipeDialEvent`（`dial`）、`PipeEstablishedEvent`（`established`）、`PipeClientErrorEvent`（`client-error`）、`PipeDebugEvent`（`debug`）。
- **与 `LogEvent` 重名的 9 个判别键不另写字面量**：`types/proxy.ts` 以 `import type { LogEvent } from "../log-events.js"` 引入（**编译期擦除，零运行时边**；`log-events.ts` 不 import `types/proxy.ts`，故不成环），`type` 写成 `typeof LogEvent.TargetUnresolved` 等 9 处（`target-unresolved`/`loop-detected`/`upstream-refused`/`upstream-error`/`upstream-timeout`/`ip-denied`/`target-denied`/`bad-request`/`client-error`）。运行时字符串值一字未变；改码只动 `LogEvent` 一处。**两侧差集是事实差异，禁止补齐**：`client-timeout`/`tls-client-error` 只属握手/接入期日志（没有对应 pipe 事件），`route`/`socks`/`dial`/`established`/`debug` 是落盘不走的内部细节事件。
- `PipeRouteEvent.mode` 必填且限 `"server" | "client"`，`PipeRouteEvent.route` 必填且限 `"direct" | "upstream"`；`route` 事件与 server 层 `[route]` 日志行保持 1:1，不得删字段、改为可选或扩大为任意 `string`。
- 消费者覆盖全部 14 个 `case` 后须在 `default` 使用 `e satisfies never` 做穷尽性收口；新增变体时若遗漏消费分支，必须在编译期失败。
- `HelperEvent` 是 `PipeEvent` 的真子集，仅覆盖 `dial`、`established`、`upstream-timeout`、`upstream-error`、`client-error` 五个拨号守卫变体，可直接进入 pipe 事件槽，无须恢复索引签名或额外强转。
- 上述类型契约的回归护栏在 `tests/unit/pipe-event.test.ts`：固定 14 变体清单、route 必填字面量、公共可选维度、switch 收窄与穷尽性、HelperEvent 子集及无索引签名。

## 错误边界（`ErrorBoundary`）

- `error-boundary.ts` 是纯库错误基建：只做分类、生成安全消息，并可选经注入的 `EventHub` 发布 `request.failed` / `request.rejected` / `runtime.error`；不读环境或文件、不写协议、不打印日志，观察者异常不得改变分类结果或调用方控制流。
- 分类表：`DialTimeoutError` → `timeout` / `504` / expected；Node 网络错误码（如 `ECONNREFUSED`、`ENOTFOUND`、`EAI_AGAIN`、`ECONNRESET`、`EPIPE`、`EHOSTUNREACH`、`ENETUNREACH` 等）→ `upstream` / `502` / expected；`SyntaxError`/`URIError` 或明确的 bad request/协议解析语义 → `protocol` / `502` / expected；显式客户端入口 → `client` / `400` / expected；其余 → `internal` / `502` / unexpected。
- `statusForCause` 只表达拨号收尾的 504/502 分工：超时与其余错误的 502 语义必须复用 `classifyError`，不能让调用方在 catch 中再复制一套判断。
- 拒绝与失败分工：ACL、鉴权、解析等预期内拒绝走 `rejectRequest(reason, stage, status)`（400/403/407 等由协议调用方明确给出）；已发生但需归因的请求异常走 `failRequest(error, stage)`；运行时异常走 `failRuntime(error)`。`classifyError` 不猜测客户端 400。
- 分类结果的 `message` 取原始 `Error.message` 或 `String(error)`，复用 `core/helpers/headers` 的出站头剥离判据识别 `proxy-authorization`，并遮蔽 `authorization` / `cookie` 及 Basic/Bearer 形态后截断到 200 字符；原始值只保留在 `cause` 供调用方继续判断，不得直接展示。
- 错误边界已通过 `RequestTerminal` 接入 HTTP / SOCKS / WebSocket 的请求终态：协议入口只负责记录已经发生的 completed/rejected/failed，分类、脱敏与公共事件发布统一复用本模块；不得在协议 catch 中恢复分散的 502/504 判断。

## 请求作用域标识（`scope-ids.ts`）

- `connectionIdFor(socket)`：按连接对象缓存复用（`WeakMap`，socket 回收即释放），keep-alive 下同一 TCP 连接共享；`newRequestId()`：每请求一个 UUID。
- **注入点仅两处**：`core/server/http.ts:handleForward`（`connectionId` 来自 socket、`requestId` 每请求新建，同步注入 `RequestTerminal` 上下文 + 逐请求 pipe 事件槽 + `AuthContext`）与 `core/server/socks-base.ts:onConn`（SOCKS 一连接一会话一请求，两者同值；经 `sessionHost` 的 `authorize` 包装注入）。
- **SOCKS 的 forwarder 是跨会话共享单例**，绝不在其上存会话态或闭包捕获 id（会串号）；id 一律经 `terminal` / `AuthContext` 逐会话传递。
- id 随**事件载荷**走（`PipeEventBase.requestId/connectionId`、`ProxyAuthEvent`、`AuthContext`），由 `runtime/bridge.ts` 读取并写入公共 `EventContext`，使 `auth.decided` / `route.selected` 与 `request.completed` 终态可按 requestId 串联。缺失即不带（core 直构无入口注入时不臆造）。
- 回归护栏：`tests/unit/scope-ids.test.ts`、`tests/integration/request-scope-ids.test.ts`。

## 请求终态事件

- `request-terminal.ts:RequestTerminal` 是每个入站请求/连接的一次性终态守卫：`completed`、`rejected`、`failed` 首次 `claim` 成功后互斥且唯一；`complete` / `reject` / `fail` 在抢占后才发布，观察面异常不会反向改变协议收尾。
- **终态唯一来源原则**：每个请求终态**只由 `RequestTerminal` 抢占并发布一次**。`PipeEvent` 侧不得再单独为同一事实发一条公共拒绝/失败事件。典型：`target-unresolved` 的 `request.rejected(stage:"parse")/400` 由 `forward/http.ts` 的 `requestTerminal.reject(...)` 发布，同一时刻发出的 `pipe: target-unresolved` **只服务日志面**（`[target-unresolved]` warn），`runtime/bridge.ts` 刻意不桥它（历史上桥过，靠反查是否已结算去重，那条去重通路已删）。新增任何 pipe 变体前先确认它没有已由终态 publisher 覆盖的公共形状。
- **publisher 注册表按 accessor 隔离**：`registerRequestTerminalPublisher` / `createRequestTerminal` 走模块级 `WeakMap<ConfigAccessor, Map<protocol, publisher>>`，隔离**只**建立在「每个 runtime 派生自己的 accessor 对象」（`runtime/bridge.ts` 的 `bindRuntimeContext` 每次 `Object.freeze` 造新对象）这个隐含约定上；同 protocol 下后注册的会顶掉前一个，前者终态将静默消失。退订函数幂等且**不误删他人** publisher（`current?.get(protocol) !== publisher` 保护）。护栏在 `tests/unit/proxy-runtime.test.ts`（共享同一 context 的两个 runtime 各自持有自己的 publisher）。
- **`requestTerminals` WeakMap 的职责是跨事件通道，不是去重**：Node `clientError` 事件**只给 socket、拿不到 req**，`server/http.ts` 的 clientError handler 靠 `requestTerminalFor(socket)` 判断该连接上是否已有在途请求、有则复用其 guard（避免 malformed 拒绝与请求自身终态互相抢抢占），没有才新建一个专用于该次拒绝。请求自身不需要反查——id 与 guard 都由入口经参数逐层传递。
- runtime `CoreEventBridge` 按 `ConfigAccessor + protocol` 注册内部 publisher：`rejected` / `failed` 经 `ErrorBoundary` 发布到公共 `EventHub`，`completed` 直接使用既有 `request.completed` 契约；CLI 的 `pipe` 日志面不新增 core 事件。
- HTTP 接入点：`HttpProxy.handleForward` 的客户端名单/鉴权/入口异常与 `clientError`；`HttpForwarder` 的目标解析/目标名单、响应 `finish`、上游 error/timeout/提前 close；CONNECT 在 200 建隧、解析/名单和拨号失败收尾；Upgrade 在 101、非 101、状态行等待及拨号失败收尾。
- SOCKS 接入点：`SocksProxyBase.onConn` 的客户端名单与连接异常；`socks-session` 的非法握手/鉴权；`SocksForwarder.connect` 的目标校验/名单、建隧成功与上游失败。所有 SOCKS reply 仍由原 `replySuccess` / `replyFail` 写字节。
- HTTP 状态码、ServerResponse 早失败、SOCKS 二进制 reply、CONNECT 200、Upgrade 101 等既有判定与写报文逻辑不改；事件只在其旁边记录已经发生的终态。
- **`request.started` 已加入**（原「暂不加入，公共契约以终态事实为最小观察面」的判断已撤销）：`handleForward` 在准入三关全过、委派 forwarder 之前发 `forward` 事件，`runtime/bridge.ts` 桥成 `request.started`，`data` 只带 `kind`（`http`/`tunnel`/`upgrade`），身份维度走 context。**这是公共事件面唯一的非终态请求级事件**——`auth.decided` 要开了鉴权才有、`route.selected` 要 client 模式才有，所以在 **server 模式直连 + 关闭鉴权**这个最常见部署下，加它之前一次请求只剩终态，慢上游/长连接无法判断卡在哪一步。终态三件套是**结果**，`started` 是**过程**，缺过程的结果不可诊断。
- **`ProxyForwardEvent` 带 `requestId` / `connectionId`**（由 `handleForward` 注入）：`request.started` 据此与同请求的 `request.completed|rejected|failed` 串成一条链；core 直构（无入口注入）时缺失即不带，桥接器不臆造 id。注意 `request.started` 与终态事件的 `context.target` **同源于 `getAuthority(req)`**（非 CONNECT 只认 Host 头），absolute-form 请求下它是客户端写来的代理自身 authority；**真实目标要看 `route.selected` 的 context**（那是解析后的 dest）。
- `handleForward` **只把 terminal 关联到 socket，不关联 req**：Node `clientError` 只给 socket、拿不到 req，这是跨事件通道取回 guard 的唯一路径。req 不必关联——terminal 已作为参数逐层传给 `forwardXxx`，三个 forwarder 入口自己会再关联一次。
- 回归护栏：`tests/unit/request-terminal.test.ts` 锁定互斥语义；`tests/integration/request-terminal-events.test.ts` 通过真实 `ProxyRuntime` 验证 HTTP/SOCKS 的 completed/rejected/failed 生产与唯一性。
