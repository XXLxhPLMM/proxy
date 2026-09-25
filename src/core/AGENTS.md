# src/core — 代理内核

`types/`（唯一类型源）→ `server/`（建服骨架）→ `forward/`（转发器）+ `auth.ts` / `guard.ts` / `proxy-helpers.ts`（共享工具）。各文件头 `@fileoverview` 是第一手说明，本文件只收敛跨文件的约定与禁区。

## 类型（`types/`）

- `proxy.ts` 是 Single Source of Truth；`auth.ts` / `pipe.ts` 叶模块只做 `export type` 转发，禁止新增独立类型。
- 已删除、无需兼容：`types/connector.ts`、`types/server.ts` 整文件，`ProxyHttpServer`、`TokenExtractor`、`UpstreamTarget`、`DialHandle`、`ConnectorDial` 等，`AuthOptions.extractor` 假扩展点。

## 鉴权（`auth.ts`）

- 账号住在 `AUTH_USERS_FILE`（`cfg/users.json`），**不在** env。`createAuthFromConfig()` 每请求重读 store + 账号文件（热加载），改配置下次请求即生效。
- `basic` 命中任一账号的用户名+密码；`uid` 只比用户名；`jwt` 用户名取 token 的 `sub/username/user/uid/id`。凭证索引住在 `proxy-helpers.ts`（`buildCredentialIndexes` / `credentialIndexesFor` 单槽记忆 / `matchBasicCredential` / `matchUidCredential`，`Auth` 只做薄委托，保证出站头剥离与鉴权用同一判据），结果带回 `username` 供逐连接日志。
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
- `dial.ts:Dialer`：`dialDirect` / `dialTls` / `choose` / `dialViaHttpUpstream`（tunnel/socks 共用：拨 http(s) 上游 → 发 CONNECT → 等状态行；**绝不向客户端写字节**，成败应答归调用方；超时抛 `DialTimeoutError` 供调用方回 504）/ `dialSocks`（版本与 TLS 由 `socksVersionOf` / `isTlsUpstreamProto` 推导）/ `bridge`。`readReply` 用 pause + `read(n)` 精确消费（跨 TCP 分段与余量回灌；**不许**在 data 回调里 `unshift`）。`handshakeSocks5` 的 CONNECT ATYP 按 `normalizeIp` 判族：family 6 用 `SOCKS5_ATYP_IPV6` + 16 字节地址（域名型是字符串、无 v6 语义），IPv4/域名沿用 `SOCKS5_ATYP_DOMAIN`（刻意简化）；SOCKS4a 无地址族字段，IPv6 亦按域名串交给上游（不加分支）。
- `socks.ts:SocksForwarder`：握手解析（`readGreeting` / `readUserPass` / `parseSocks4` / CONNECT）+ `connect()`（`connectVia` 收敛三条上游分支模板；`badRequest` 收敛握手非法；`establish` 回灌余量后桥接）。
- `socks-reader.ts:SocksHandshakeReader`：握手缓冲读取器（`readExactly` / `readUntil` / `takeBuffered` + `dispose`），server 与 forwarder 共用，解决分段与 pipelining。
- `guard.ts`：`guardDialing`（上下游超时/错误/半关闭联动；`keepClientOnFailure` 置位 → 只毁上游、客户端留给调用方应答；**空 reply ≠ 调用方会写**，必须显式置位）/ `socksUpstreamGuard`（空回复 + 保客户端 + 成因上抛的选项工厂）/ `readResponseHead`（字节封顶 + CRLFCRLF + 严格状态码，**不毁 socket 不写应答**）/ `awaitStatusLine`（返回 `StatusLineResult` 判别联合，失败时毁上游，客户端收尾归调用方）。零日志，事件上抛。
- `proxy-helpers.ts`：纯函数优先（`guardPreDial` / `resolveForwardTargets` / `resolveRoute` 例外，读 store/ACL）。**有效模式唯一入口是 `resolveRoute(dest)`**：配置 server 短路 `{mode:"server", route:"direct"}`（不查 `upstream` 组）；配置 client → `acl:checkUpstreamRoute`，名单命中回落 `{mode:"server", route:"direct", reason}`（dial/path/凭证/Host/secure 全按 server 语义自然回落），否则 `{mode:"client", route:"upstream"}`。`resolveForwardTargets` 成对给出 `{dial, dest, route}`（dial 按有效模式选），四个转发器后续分支一律用 `route.mode`、**禁止在请求路径裸读 `get("proxyMode")`**（唯一例外：websocket 的 socks 上游早分支——目标尚未解析无法判路由，分支内自行 `resolveRoute`）。`resolveRoute` 纯函数不打日志；路由事实经 `forward/base:emitRoute` 发 `route` 事件（**过 preDial 每请求恰一条、拒绝路径与 server 模式短路零条**），`[route]` info 行（字段 `target`/`route`/`reason`）由 `src/server` 落盘、与事件 1:1。目标主机必过 `isValidTargetHost`（字符白名单 + 255B，防 CONNECT/SOCKS 报文注入与长度域截断）。`guardPreDial` 语义：自环看 `dial`、名单看 `dest`（**名单永不判上游**，见 `src/config/AGENTS.md` 访问控制）。

## 服务端骨架（`server/`）

- `base.ts:BaseProxy`：状态机 `idle → starting → running → stopping → stopped`（可重入 `starting`），`start()`/`stop()` 幂等模板方法；`stop()` 在 `starting` 态先等在途 start。`ConnRegistry`（`track`/`drain`，http/socks 共用一份）+ `closeServer()` 关服模板 + `authorize()`（异常转 deny）。根 AGENTS.md 只保留状态机契约。
- `factory.ts` 按 `ProxyProtocol` 建实例；`http.ts`（`HttpProxy`：request/connect/upgrade 三通道 + `handleForward` 名单→鉴权→委派 + `writeRejected`）被 `https.ts` 继承复用（仅重写 `doStart` 建 TLS 服）。
- `socks-base.ts`（`SocksProxyBase` + `PlainSocksProxy` / `TlsSocksProxy`：`createListener` 是明文/TLS 唯一差异点）+ `socks-session.ts`（`runSocks4Session` / `runSocks5Session`，经 `SocksSessionHost` 最小接口注入，**不含日志器**）。四个 SOCKS server 文件是 21 行薄壳；监听器 `error` 与 http 同形发 `serverError` 事件。
- `socks-base.ts:onConn()` 首行过客户端名单（拒绝走 `pipe` 的 `ip-denied`，与 http 同形）；握手后 `authorized` 兜底是保险，主力是 `tlsClientError`（机制见 `src/utils/AGENTS.md`）。`doStart` 以 `.catch` 兜住 `onConn` 的意外抛错：销毁 socket 并发 `clientError` 上抛（core 零日志），避免 unhandledRejection。

## 本目录 Gotchas

- `http.Server` 的 `connect` socket 是 `Duplex` 不是 `net.Socket` —— 全链路用 `Duplex`。
- Status-line 等待（CONNECT 的 200、Upgrade 的 101）统一走 `awaitStatusLine`；`upstreamTimeout` 只兜时间不兜内存（另有字节封顶）。
- SOCKS 域名是客户端原始字节（不过 HTTP 解析器）：解析/建握手前必过白名单。
- SOCKS4a 哨兵判 `DSTIP ∈ 0.0.0.0/24`：规范草稿写全 0、curl/PySocks 发 `0.0.0.1`，两者都得认；漏全 0 会误判纯4、域名残渣被当载荷打进隧道（客户端拿假 90 后收到 400）。护栏在 `tests/integration/socks-handshake.test.ts`，脚手架 `socks4aRequest(..., dstip)` 可改哨兵。
- client 模式经 http/https 上游的 Upgrade 报文保留 absolute-form + 注入 `Proxy-Authorization`（`buildUpgradeReq(..., toUpstreamProxy)`）；经 SOCKS/直连用 origin-form 且绝不带上游凭证。分流唯一依据是 `resolveRoute` 的**有效模式**（`route.mode`）：client 配置命中 `upstream` 路由名单即回落 server（直拨真实目标），请求路径不许裸读 `proxyMode`（见上方 proxy-helpers 条）。
- 拨号失败成因区分：超时（`DialTimeoutError`）→ 504，其余 → 502；SOCKS 回 FAIL 不区分。catch 里一刀切 502 会吃掉超时成因。
- **转发报文 authority 一律经 `formatAuthority` 补 IPv6 方括号**：解析侧 `parseTargetParts`/`parseAuthority` 刻意剥方括号以便 `net.connect` 直用，拼装侧不补会产出 `CONNECT ::1:443` / `Host: ::1:443` 畸形报文。已收口：`buildConnectRequest`、`buildUpgradeReq` 的 Host 回写、`http.dialViaSocksAndForward` 的 Host 重写。
- `tunnel.handle` 解析 authority 失败回 **400**（客户端请求报文非法，与 http/websocket 解析失败语义一致）；502 只留给网关侧失败。
- `WsForwarder.relay` 非 101：透传 `head`+`rest` 后按 `upstream.readableEnded` 分流——已 EOF 则 `client.end()`，否则 `upstream.pipe(client)` 续传剩余 body（`Content-Length` 大于首包时客户端不挂等）；**`readableEnded` 分支不可删**（`'end'` 可能早于续体挂 pipe 前发出）；上游错误/关闭收尾归 `guardDialing` 既有 handler，不额外 destroy。
- `cfg/users.json` / `cfg/acl.json` 热加载语义（1s 节流、坏文件保留旧值、缺失=空）见 `src/config/AGENTS.md`。
- **core 零日志禁区**：`src/core/**` 禁止直接打印日志（生命周期行也不行），事实一律经事件上抛（`pipe`/`serverError`/`auth`/`forward`…），落盘收在 `src/server/index.ts:bindProxyEventLogs`；向 utils 注入 logger（`loadCerts`/`bindTlsClientError`）不算打印——打印动作在 utils。
- 串联矩阵回归：新增入站×上游×证书组合时必须在 `tests/integration/upstream-matrix.test.ts` 补一档；名单语义与 `[route]` 路由事件护栏在 `tests/integration/client-mode-acl.test.ts`、`[route]` 落盘全链路在 `tests/integration/log-structured.test.ts`。

## 事件内核（`events/`）

- `src/core/events/types.ts` 是新事件契约的类型单一来源：`AppEventMap` 以元组声明参数，`EventData` 取元组首项作为实际 payload；`EventEnvelope` 携带只读事件名、关联上下文、payload 和时间戳，`EventContext.runtimeId` 必填，connection/request 作用域可选。
- `EventHub` 只公开 `publish` / `subscribe` / `once` / `listenerCount` / `removeAll` / `EventHub.merge`，内部订阅表和分发实现不得暴露 Node `EventEmitter`；runtimeId 缺省由 `crypto.randomUUID()` 生成。发布时 context 浅拷贝并补齐 runtimeId，订阅返回的 `EventSubscription.dispose()` 幂等。
- 分发使用 listener 快照：emit 期间新增或 dispose 不改变当前这次迭代；单个 listener 抛错会被隔离并交给 `onListenerError`（缺省不向控制台打印，开发态可用 `process.emitWarning`），不得影响其它 listener 或 `publish` 返回。`removeAll()` 释放全部订阅，后续 publish 是安全空操作。
- 作用域层级固定为 `runtime → connection → request`：`EventScope.child()` 继承父级 id，可覆写/补 protocol/client/user/target；`toContext()` 只返回不含 runtimeId 的 publish 上下文，`withIdentity()` 返回身份补全后的独立快照。作用域只承载关联事实，不保存日志或控制状态。
- 事件只发布已经发生的事实，不驱动控制流：鉴权、访问控制、路由、请求完成/拒绝/失败等结果由生产方发布，订阅方只观察；事件内核不直接打印日志，日志落盘仍收在 server 层。
- 当前 `AppEventMap` 事件清单：`runtime.starting`、`runtime.started`、`runtime.stopping`、`runtime.stopped`、`runtime.error`、`lifecycle.changed`、`config.loaded`、`config.changed`、`config.restart-required`、`config.file-error`、`config.file-recovered`、`auth.decided`、`access.client-denied`、`access.target-denied`、`route.selected`、`request.completed`、`request.rejected`、`request.failed`。

## 配置访问器（`ConfigAccessor`）

- `config-access.ts` 是 core 读配置的**唯一端口**：`ConfigAccessor` 只有 `get`/`getAll`（**刻意不含 `set`**——core 只消费配置，写入归 `config/store` 与 `loader`）；`globalConfigAccessor` 绑定全局单例，`configAccessorFromStore(store)` 派生实例访问器。它是 core 内对 `config/store` 的**唯一**运行时依赖，`types/proxy.ts` 只做 type-only 引用。
- **core 全链路只经访问器读配置，禁止再 `import { get } from "@/config/store.js"`**：`proxy-helpers`（路由/自环/凭证剥离）、`forward/{base,dial,http,tunnel,socks,websocket,socks-reader}`、`auth.ts`、`server/{base,http,socks-base}` 一律读 `this.config`（转发器）或构造期注入的访问器；`server/http.ts` 与 `socks-base.ts` 把 `this.options.config` 透传给转发器、鉴权与 `checkClientIp`，`ForwarderBase` 再原样透传给 `Dialer`（保证转发器与拨号器读同一份配置）。
- **缺省即全局单例，行为逐字不变**：所有新增参数一律可选且默认 `globalConfigAccessor`——`resolveRoute(dest, config?)` / `resolveForwardTargets(url, host, config?)` / `isSelfLoop(h, p, config?)` / `upstreamAuthValue(config?)` / `upstreamAuthHeaderLine(config?)` / `isStrippableOutboundHeader(name, value?, config?)` / `sanitizeHeaders` / `stripProxyHeaders` / `guardPreDial`（走 `PreDialOptions.config`）末尾追加；`Auth`/`createAuthProvider`/`createAuthFromConfig`/`ForwarderBase`/`Dialer` 加第 2 个可选构造参数；`forward/{http,tunnel,websocket}` 的函数式入口加末位可选 `config`；`readAcl`/`readAuthUsers` 的 `opts.config` 与 `loadAcl`/`loadAuthUsers`/`checkClientIp`/`checkTargetHost`/`checkUpstreamRoute` 的末位可选参数同规。`loadCerts` **不加**该参数（key/cert/ca 全由 `TlsInput` 显式传入、自身不读配置键），`readUpstreamCa`/`upstreamTlsOptions` 才是读配置的那两个。
- **`ProxyOptions.config` 是库模式多 Runtime 隔离的注入位**：`BaseProxy` 构造期归一 `config: options.config ?? globalConfigAccessor` 进 `Required<ProxyOptions>`，故 core 内部可无条件透传、无需判空。库模式传 `config: configAccessorFromStore(runtimeStore)`，各 Runtime 的上游/鉴权/名单/自环监听地址互不串号；CLI 侧不传即读全局单例。
- **生效模式唯一入口仍是 `resolveRoute(dest)`**（本节不改变任何路由语义）：判定改为 `config.get("proxyMode")` + `checkUpstreamRoute(host, config)`，判定对象、server 模式短路、名单命中回落、真值表与 `[route]` 事件「过 preDial 每请求恰一条、server 模式零条」全部原样成立。**请求路径仍禁止裸读 `proxyMode`**，唯一例外依旧是 websocket 的 socks 上游早分支（它现在读的是本转发器注入的访问器，仍属同一例外）。
- 本节 Gotchas：`config` **只影响「读哪份配置」，不改变读取时机**——`createAuthFromConfig` 仍每请求现读、`readJsonCached` 仍 1s 节流、`acl.ts` 编译结果仍按快照身份单槽记忆（不同访问器指向不同文件时快照身份不同、缓存自然失效重建，不会串用别实例的名单）；`startup` 相位字段（`host/port/tls*`）仍由调用方经 `ProxyOptions` 显式注入、不经访问器（`https.ts`/`TlsSocksProxy` 的 `loadCerts(this.options.tls)` 保持原样，回落到读取会改变「缺 tls 即抛错」的启动语义）。回归护栏在 `tests/unit/config-access.test.ts`（实例隔离、全局不被污染、缺省等值）+ `tests/unit/proxy-helpers.test.ts` / `auth.test.ts` / `base-lifecycle.test.ts` 末尾追加的注入用例。

## 管道事件判别联合（`PipeEvent`）

- `PipeEvent` 以 `type` 为字面量判别键的 14 变体判别联合取代原弱类型事件袋：每个变体只暴露已声明字段，不带索引签名；生产者与消费者必须按同一契约演进，禁止恢复 `Record<string, unknown>` 式任意字段。
- 生产者为 `src/core/forward/*`、`src/core/guard.ts` 等 core 事实产生方，统一经 `ForwarderBase.emit` / `HelperEventSink` 上抛；消费者为 `src/server/index.ts:bindProxyEventLogs`，按 `type` 分支落盘，不做未知强转。
- 变体清单：`PipeTargetUnresolvedEvent`（`target-unresolved`）、`PipeLoopDetectedEvent`（`loop-detected`）、`PipeRouteEvent`（`route`）、`PipeUpstreamRefusedEvent`（`upstream-refused`）、`PipeUpstreamErrorEvent`（`upstream-error`）、`PipeUpstreamTimeoutEvent`（`upstream-timeout`）、`PipeIpDeniedEvent`（`ip-denied`）、`PipeTargetDeniedEvent`（`target-denied`）、`PipeSocksEvent`（`socks`）、`PipeBadRequestEvent`（`bad-request`）、`PipeDialEvent`（`dial`）、`PipeEstablishedEvent`（`established`）、`PipeClientErrorEvent`（`client-error`）、`PipeDebugEvent`（`debug`）。
- `PipeRouteEvent.mode` 必填且限 `"server" | "client"`，`PipeRouteEvent.route` 必填且限 `"direct" | "upstream"`；`route` 事件与 server 层 `[route]` 日志行保持 1:1，不得删字段、改为可选或扩大为任意 `string`。
- 消费者覆盖全部 14 个 `case` 后须在 `default` 使用 `e satisfies never` 做穷尽性收口；新增变体时若遗漏消费分支，必须在编译期失败。
- `HelperEvent` 是 `PipeEvent` 的真子集，仅覆盖 `dial`、`established`、`upstream-timeout`、`upstream-error`、`client-error` 五个拨号守卫变体，可直接进入 pipe 事件槽，无须恢复索引签名或额外强转。
- 上述类型契约的回归护栏在 `tests/unit/pipe-event.test.ts`：固定 14 变体清单、route 必填字面量、公共可选维度、switch 收窄与穷尽性、HelperEvent 子集及无索引签名。

## 错误边界（`ErrorBoundary`）

- `error-boundary.ts` 是纯库错误基建：只做分类、生成安全消息，并可选经注入的 `EventHub` 发布 `request.failed` / `request.rejected` / `runtime.error`；不读环境或文件、不写协议、不打印日志，观察者异常不得改变分类结果或调用方控制流。
- 分类表：`DialTimeoutError` → `timeout` / `504` / expected；Node 网络错误码（如 `ECONNREFUSED`、`ENOTFOUND`、`EAI_AGAIN`、`ECONNRESET`、`EPIPE`、`EHOSTUNREACH`、`ENETUNREACH` 等）→ `upstream` / `502` / expected；`SyntaxError`/`URIError` 或明确的 bad request/协议解析语义 → `protocol` / `502` / expected；显式客户端入口 → `client` / `400` / expected；其余 → `internal` / `502` / unexpected。
- `statusForCause` 只表达拨号收尾的 504/502 分工：超时与其余错误的 502 语义必须复用 `classifyError`，不能让调用方在 catch 中再复制一套判断。
- 拒绝与失败分工：ACL、鉴权、解析等预期内拒绝走 `rejectRequest(reason, stage, status)`（400/403/407 等由协议调用方明确给出）；已发生但需归因的请求异常走 `failRequest(error, stage)`；运行时异常走 `failRuntime(error)`。`classifyError` 不猜测客户端 400。
- 分类结果的 `message` 取原始 `Error.message` 或 `String(error)`，复用 `proxy-helpers` 的出站头剥离判据识别 `proxy-authorization`，并遮蔽 `authorization` / `cookie` 及 Basic/Bearer 形态后截断到 200 字符；原始值只保留在 `cause` 供调用方继续判断，不得直接展示。
- 本波只交付并测试错误边界基建，尚未接入任何 HTTP / SOCKS / WebSocket 协议实现；后续接入时只允许复用本模块的分类与事件发布，不得在协议 catch 中恢复分散的 502/504 判断。

## 请求作用域标识（`scope-ids.ts`）

- `connectionIdFor(socket)`：按连接对象缓存复用（`WeakMap`，socket 回收即释放），keep-alive 下同一 TCP 连接共享；`newRequestId()`：每请求一个 UUID。
- **注入点仅两处**：`core/server/http.ts:handleForward`（`connectionId` 来自 socket、`requestId` 每请求新建，同步注入 `RequestTerminal` 上下文 + 逐请求 pipe 事件槽 + `AuthContext`）与 `core/server/socks-base.ts:onConn`（SOCKS 一连接一会话一请求，两者同值；经 `sessionHost` 的 `authorize` 包装注入）。
- **SOCKS 的 forwarder 是跨会话共享单例**，绝不在其上存会话态或闭包捕获 id（会串号）；id 一律经 `terminal` / `AuthContext` 逐会话传递。
- id 随**事件载荷**走（`PipeEventBase.requestId/connectionId`、`ProxyAuthEvent`、`AuthContext`），由 `runtime/bridge.ts` 读取并写入公共 `EventContext`，使 `auth.decided` / `route.selected` 与 `request.completed` 终态可按 requestId 串联。缺失即不带（core 直构无入口注入时不臆造）。
- 回归护栏：`tests/unit/scope-ids.test.ts`、`tests/integration/request-scope-ids.test.ts`。

## 请求终态事件

- `request-terminal.ts:RequestTerminal` 是每个入站请求/连接的一次性终态守卫：`completed`、`rejected`、`failed` 首次 `claim` 成功后互斥且唯一；`complete` / `reject` / `fail` 在抢占后才发布，观察面异常不会反向改变协议收尾。
- runtime `CoreEventBridge` 按 `ConfigAccessor + protocol` 注册内部 publisher：`rejected` / `failed` 经 `ErrorBoundary` 发布到公共 `EventHub`，`completed` 直接使用既有 `request.completed` 契约；CLI 的 `pipe` 日志面不新增 core 事件。
- HTTP 接入点：`HttpProxy.handleForward` 的客户端名单/鉴权/入口异常与 `clientError`；`HttpForwarder` 的目标解析/目标名单、响应 `finish`、上游 error/timeout/提前 close；CONNECT 在 200 建隧、解析/名单和拨号失败收尾；Upgrade 在 101、非 101、状态行等待及拨号失败收尾。
- SOCKS 接入点：`SocksProxyBase.onConn` 的客户端名单与连接异常；`socks-session` 的非法握手/鉴权；`SocksForwarder.connect` 的目标校验/名单、建隧成功与上游失败。所有 SOCKS reply 仍由原 `replySuccess` / `replyFail` 写字节。
- HTTP 状态码、ServerResponse 早失败、SOCKS 二进制 reply、CONNECT 200、Upgrade 101 等既有判定与写报文逻辑不改；事件只在其旁边记录已经发生的终态。`request.started` 暂不加入：当前公共契约以终态事实为最小观察面，开始转发由既有 `forward` 事实承担。
- 回归护栏：`tests/unit/request-terminal.test.ts` 锁定互斥语义；`tests/integration/request-terminal-events.test.ts` 通过真实 `ProxyRuntime` 验证 HTTP/SOCKS 的 completed/rejected/failed 生产与唯一性。
- 上条 ErrorBoundary 小节中的“尚未接入”是前一阶段快照；当前协议终态事实以本节为准。
