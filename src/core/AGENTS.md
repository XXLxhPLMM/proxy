# src/core — 代理内核

`types/`（唯一类型源）→ `server/`（建服骨架）→ `forward/`（转发器）+ `auth.ts` / `guard.ts` / `proxy-helpers.ts`（共享工具）。各文件头 `@fileoverview` 是第一手说明，本文件只收敛跨文件的约定与禁区。

## 类型（`types/`）

- `proxy.ts` 是 Single Source of Truth；`auth.ts` / `pipe.ts` 叶模块只做 `export type` 转发，禁止新增独立类型。
- 已删除、无需兼容：`types/connector.ts`、`types/server.ts` 整文件，`ProxyHttpServer`、`TokenExtractor`、`UpstreamTarget`、`DialHandle`、`ConnectorDial` 等，`AuthOptions.extractor` 假扩展点。

## 鉴权（`auth.ts`）

- 账号住在 `AUTH_USERS_FILE`（`cfg/users.json`），**不在** env。`createAuthFromConfig()` 每请求重读 store + 账号文件（热加载），改配置下次请求即生效。
- `basic` 命中任一账号的用户名+密码；`uid` 只比用户名；`jwt` 用户名取 token 的 `sub/username/user/uid/id`。凭证索引住在 `proxy-helpers.ts`（`buildCredentialIndexes`/`matchBasicCredential`/`matchUidCredential`，`Auth` 只做薄委托，保证出站头剥离与鉴权用同一判据），结果带回 `username` 供逐连接日志。
- 失败闭环：账号形状非法 abort 启动（`validateAuthUsers`）；`authEnabled + basic|uid + 空表` abort（`assertAuthConfig`，见 `src/config/AGENTS.md`）；`authenticate()` 内异常一律 deny（`BaseProxy.authorize()` 捕获）。
- Token：`Proxy-Authorization` 优先、`Authorization` 回退（RFC 7235，scheme 大小写不敏感）。
- 凭证防泄漏：`isProxyCredentialValue()` 命中代理自身凭证（走**整份账号表**比对）时，`sanitizeHeaders` / Upgrade 报文必须剥掉该 `Authorization`；其余 `Authorization`（如目标 `Bearer`）原样转发。判据唯一收口在 `isStrippableOutboundHeader`（任意 `proxy-` 前缀 + 凭证形态）。
- JWT：默认注入内置 HS256 校验 `defaultJwtVerify`（`node:crypto` 零依赖：验签 + `exp`，永不抛）；显式注入优先；直构 `Auth` 未注入即 deny（审计照打）。
- `basic` 在 socks4/sockss4 额外接受 `USERID == username`（无密码字段）。
- 审计 `tag` 为 `"tunnel"` 仅当 `method === "CONNECT"` / `socks*` 协议 —— 不许用 `authority.includes(":")` 判定。`Auth` 零日志，审计经 `onAuthEvent` → proxy `auth` 事件 → server 层落盘。
- SOCKS 鉴权发生在握手后：socks5/sockss5 走 RFC1929 user/pass（auth 启用时），socks4/sockss4 用 USERID。

## 转发器（`forward/`）

- 四个转发器（http/tunnel/websocket/socks）继承 `base.ts:ForwarderBase`：共享 `dialer` / `emit` / `emitWithUser`（身份经参数逐次传入，**不许存字段**，SOCKS server 复用同一转发器实例会串号）/ `preDial` / `denyUpstreamLoop(+Auto)` / `refuse` / `refuseByCause`。事件统一为 `PipeEvent`（泛型已删；`HelperEvent` 带索引签名可直接传入）。
- **刻意不收的**：各协议应答形态（HTTP `ServerResponse` 早失败、SOCKS 二进制应答、tunnel 回 200、websocket 等 101）——强行模板化是假抽象；余量回灌 + 桥接已由 `bridgeWithBuffered` 收口（`establishTunnel`/`establish` 只剩应答 + 委托）。
- `dial.ts:Dialer`：`dialDirect` / `dialTls` / `choose` / `dialViaHttpUpstream`（tunnel/socks 共用：拨 http(s) 上游 → 发 CONNECT → 等状态行；**绝不向客户端写字节**，成败应答归调用方；超时抛 `DialTimeoutError` 供调用方回 504）/ `dialSocks`（版本与 TLS 由 `socksVersionOf` / `isTlsUpstreamProto` 推导）/ `bridge`。`readReply` 用 pause + `read(n)` 精确消费（跨 TCP 分段与余量回灌；**不许**在 data 回调里 `unshift`）。
- `socks.ts:SocksForwarder`：握手解析（`readGreeting` / `readUserPass` / `parseSocks4` / CONNECT）+ `connect()`（`connectVia` 收敛三条上游分支模板；`badRequest` 收敛握手非法；`establish` 回灌余量后桥接）。
- `socks-reader.ts:SocksHandshakeReader`：握手缓冲读取器（`readExactly` / `readUntil` / `takeBuffered` + `dispose`），server 与 forwarder 共用，解决分段与 pipelining。
- `guard.ts`：`guardDialing`（上下游超时/错误/半关闭联动；`keepClientOnFailure` 置位 → 只毁上游、客户端留给调用方应答；**空 reply ≠ 调用方会写**，必须显式置位）/ `socksUpstreamGuard`（空回复 + 保客户端 + 成因上抛的选项工厂）/ `readResponseHead`（字节封顶 + CRLFCRLF + 严格状态码，**不毁 socket 不写应答**）/ `awaitStatusLine`（返回 `StatusLineResult` 判别联合，失败时毁上游，客户端收尾归调用方）。零日志，事件上抛。
- `proxy-helpers.ts`：纯函数优先（`guardPreDial` / `resolveForwardTargets` 例外，读 store/ACL）。目标主机必过 `isValidTargetHost`（字符白名单 + 255B，防 CONNECT/SOCKS 报文注入与长度域截断）。`guardPreDial` 语义：自环看 `dial`、名单看 `dest`（**名单永不判上游**，见 `src/config/AGENTS.md` 访问控制）。

## 服务端骨架（`server/`）

- `base.ts:BaseProxy`：状态机 `idle → starting → running → stopping → stopped`（可重入 `starting`），`start()`/`stop()` 幂等模板方法；`stop()` 在 `starting` 态先等在途 start。`ConnRegistry`（`track`/`drain`，http/socks 共用一份）+ `closeServer()` 关服模板 + `authorize()`（异常转 deny）。根 AGENTS.md 只保留状态机契约。
- `factory.ts` 按 `ProxyProtocol` 建实例；`http.ts`（`HttpProxy`：request/connect/upgrade 三通道 + `handleForward` 名单→鉴权→委派 + `writeRejected`）被 `https.ts` 继承复用（仅重写 `doStart` 建 TLS 服）。
- `socks-base.ts`（`SocksProxyBase` + `PlainSocksProxy` / `TlsSocksProxy`：`createListener` 是明文/TLS 唯一差异点）+ `socks-session.ts`（`runSocks4Session` / `runSocks5Session`，经 `SocksSessionHost` 最小接口注入）。四个 SOCKS server 文件是 21 行薄壳。
- `socks-base.ts:onConn()` 首行过客户端名单（拒绝走 `pipe` 的 `ip-denied`，与 http 同形）；握手后 `authorized` 兜底是保险，主力是 `tlsClientError`（机制见 `src/utils/AGENTS.md`）。

## 本目录 Gotchas

- `http.Server` 的 `connect` socket 是 `Duplex` 不是 `net.Socket` —— 全链路用 `Duplex`。
- Status-line 等待（CONNECT 的 200、Upgrade 的 101）统一走 `awaitStatusLine`；`upstreamTimeout` 只兜时间不兜内存（另有字节封顶）。
- SOCKS 域名是客户端原始字节（不过 HTTP 解析器）：解析/建握手前必过白名单。
- client 模式经 http/https 上游的 Upgrade 报文保留 absolute-form + 注入 `Proxy-Authorization`（`buildUpgradeReq(..., toUpstreamProxy)`）；经 SOCKS/直连用 origin-form 且绝不带上游凭证。分流唯一依据是 `proxyMode`。
- 拨号失败成因区分：超时（`DialTimeoutError`）→ 504，其余 → 502；SOCKS 回 FAIL 不区分。catch 里一刀切 502 会吃掉超时成因。
- `cfg/users.json` / `cfg/acl.json` 热加载语义（1s 节流、坏文件保留旧值、缺失=空）见 `src/config/AGENTS.md`。
- 串联矩阵回归：新增入站×上游×证书组合时必须在 `tests/integration/upstream-matrix.test.ts` 补一档；名单语义护栏在 `tests/integration/client-mode-acl.test.ts`。
