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

- 四个转发器（http/tunnel/websocket/socks）继承 `base.ts:ForwarderBase`：共享 `dialer` / `emit` / `emitWithUser`（身份经参数逐次传入，**不许存字段**，SOCKS server 复用同一转发器实例会串号）/ `preDial` / `emitRoute`（路由事件，core 零日志）/ `denyUpstreamLoop(+Auto)` / `refuse` / `refuseByCause`。事件统一为 `PipeEvent`（泛型已删；`HelperEvent` 带索引签名可直接传入）。
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
