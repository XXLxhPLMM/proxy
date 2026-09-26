# src/utils — 基础设施

零业务语义的可复用底座：日志、网络传输、地址/名单、文件读取、进程容错、协议常量。
**一个职责一个目录，不设平级散文件**（新增能力先找对应目录，确实没有新职责才开目录）。
`utils/` 只允许依赖 `config/store`（只读取值键）与其它 `utils/`；**禁止反向依赖 `server/`、`core/`、`runtime/`**
（`config/` 内部的解析器如 `upstream-url.ts` 也不属于这里，见 `src/config/AGENTS.md`）。

```
log/       logger.ts(门面+Logger 类) level.ts(两道门限+轮转) text.ts(净化/渲染) events.ts([event-code] 目录)
net/       listen.ts(listen-and-wait) socket.ts(活体 socket 事实) tls.ts(入站 mTLS) upstream-tls.ts(出站 TLS)
addr/      address.ts(IP 文本↔字节) cidr.ts(IP/CIDR 规则) host.ts(域名/通配名单)
           request.ts(入站请求头事实) loop.ts(自环判定)
file/      json.ts(节流热加载读取) json-event.ts(状态迁移事件契约) json-error-text.ts(错误文本去敏)
           path.ts(配置相对路径解析)
process/   guards.ts(进程级容错 lease)
protocol/  http.ts(HTTP 报文常量) socks.ts(SOCKS4/5 字节常量)
```

**别按行数拆文件**：本目录注释占 15-75%（`net/tls.ts` 263 行只有 78 行代码、`protocol/http.ts` 227 行只有 51 行），
按总行数判断「太大」会拆出假抽象。判据是**职责数**与**代码行数**：`json.ts` 曾有 285 代码行且混了
缓存/节流/解析/事件/去敏五件事才值得拆；`logger.ts` 199 行是**一个类**、`guards.ts` 161 行是**一个
lease 状态机**，拆开只会更碎。

不属于 utils 的东西（**别再往回塞**）：终端 Banner 在 `src/server/banner.ts`（构建期生成 + 启动期呈现）；
启动期配置快照在 `src/server/config-log.ts`；`UPSTREAM_URL` 解析器在 `src/config/upstream-url.ts`。

## 日志（`log/`）

- 所有 `src/` 代码用 `logger` / `getLogger(prefix)`，不用 `console.*`（ESLint `no-console`，白名单只有 `log/logger.ts`）。
- 四个文件的职责切分是硬边界：**`level.ts` 只取值与算文件名**（不写盘）、**`text.ts` 只做纯文本净化/渲染**（不碰等级与文件）、**`logger.ts` 只做编排**（门限、通道、child）、**`events.ts` 只放稳定事件码**。新增日志能力按这四类落位，不许塞进 `logger.ts`。
- console 与文件两道独立门限：`get("logLevel")`（console，默认 `error`）与 `get("logFileLevel")`（file，默认 `info`）每调用现取；console 走人类可读文本（`<ISO> <LEVEL> <prefix> <msg> k=v`），文件走 **JSONL**（`log/YYYY-MM-DD-HH.jsonl`，每小时轮转）。直接写、无队列；每次 appendFile 登记进 `logger.ts` 的模块级在途集合（全实例共享），`await logger.flush()` 等齐在途落盘后返回（`ProxyServer.stop()`/CLI 致命路径/cluster master 收尾在 `process.exit` 前调用；强退路径不等；正常事件循环退出无需）。`logger.raw()`（banner）/`logger.file(level,…)`（只落盘）/`logger.both(level,…)`（双通道）bypass 两道门；`logger.notice(level,…)`（生命周期/配置通知：启动摘要、worker 就绪、ACL·账号表热加载）绕控制台门限（`silent` 除外）、落盘仍按 `fileLevel`；file/both/notice 落盘走与常规行完全相同的 JSONL 管线（同一 schema/保留键/净化/小时轮转）。调用永不抛：循环/BigInt/Symbol 有回退，两通道 try/catch。所有字符串参数做控制字符转义（线数据不得伪造日志行或注入终端转义）；日志目录/文件 `0o700`/`0o600`。
- **结构化字段**：`logger.info("msg", { ...fields })` —— 最后一个纯对象参数即字段（`text.ts:isPlainObject` 原型检查天然排除 `Error`/`Array`/`Buffer`/`Date`）。文件通道合并进记录顶层，console 渲染 `k=v`。保留键 `ts/level/pid/prefix/msg` 优先，同名字段被忽略。行形态：`{"ts":"2026-09-20T14:03:11.201Z","level":"info","pid":1234,"prefix":"[proxy]","msg":"[forward]","client":"1.2.3.4","target":"example.com:80","method":"GET","user":"alice"}`。查询：`jq -r 'select(.user=="alice") | .msg, .target' log/*.jsonl`；`jq -r 'select(.msg=="[auth] deny") | .client' log/*.jsonl | sort | uniq -c`；`jq 'select(.level=="warn")' log/*.jsonl`。
- **值渲染只有一份实现**：`text.ts:renderValue` 是 msg 参数与结构化字段共用的唯一入口（`renderFieldValue` 只多一层「null/undefined 跳过该键」）。**禁止再写第二份 stringify/字段渲染**——`NaN`/`Infinity` 因此保真为 `"NaN"`（不塌成 `JSON.stringify` 的 `null`），改这里等于改全部日志形态。`Error` 特判为可读单行 `name: message [code=...] [stack 首帧]`（`renderErrorText`，经 `sanitizeLogText` 净化）——`JSON.stringify(Error)` 只会得到 `{}`，转发层 502 的成因（ECONNREFUSED/TLS 校验失败）不能丢；控制台 msg 通道不变，Error 仍原样交给 `console.*`（原生堆栈可读）。fields 判定不受影响（Error 仍不是 fields）。
- **两种控制字符净化语义不可混用**：`sanitizeLogText`（转义为 `\n`/`\x1b` 等可见形式，保单行可读）与 `stripControlChars`（原地折叠为空格）。`file/json.ts` 的去敏错误文本用后者 + 空白折叠，**不得**改用前者（错误文本要的是「压平」不是「可读转义」）。
- **事件码**（`events.ts`）：`[ip-denied]` / `[target-denied]`（warn，带 `client`/`target`/`reason`）；`[tls-client-error]`（warn，TLS 握手失败含 mTLS 拒绝，带 `code`/`authorizationError`）；forward/auth 行带 `user`。事件码是**稳定 grep 契约**，重命名即 breaking change；同一语义只写一次格式，新增事件 = `LogEvent` 一行 + 工厂调用一行。`EventLog` 因此含 `debug`；`makeEvent`/`makeExtraEvent` 的最后一个参数是 `LevelOverride`（只允许 `"debug"`，不得借它把事件改成 error，也不得借它删字段）。`events.ts` 是零依赖叶模块（自带最小 `EventLog` 接口），因此 `net/tls.ts`、`core/server/socks-base.ts`、`server/index.ts` 都能直接引它——**它曾是 `server/log/events-log.ts`，为了让 utils 不反向依赖 server 才下沉的**。
- `setupProcessGuards()`（`process/guards.ts`）捕获 `uncaughtException`/`unhandledRejection`/`warning`（只记不退出），由 `ProxyServer.start()` 取得一个幂等 lease/disposer；同一进程只安装一组物理 listener，最后一个 lease 释放时移除，避免重复日志与 RuntimeHandle.stop() 后的宿主 handler 残留；不另加 `uncaughtExceptionMonitor`。安装回滚与 lease disposer 均逐项执行，某一个 `removeListener` 抛错不会跳过后续 handler；清理错误由 guard 记录并以聚合错误交给资源所有者，不能静默吞掉；失败时保留可重试的物理 listener 引用，下一 lease 先重试移除，避免下一 start 误判已绑定或重复安装。

## 网络与 TLS（`net/`）

- **`tls.ts` 是入站 mTLS 唯一入口**：`loadCerts` / `requiresClientCert` / `tlsServerOptions` / `bindTlsClientError` 供 https 与 TLS SOCKS 共用；`upstream-tls.ts` 是出站 TLS 唯一入口：`readUpstreamCa` / `upstreamTlsOptions`，`forward/http.ts` 与 `forward/dial.ts` 共用。**入站失败 abort 启动、出站失败回退系统信任库**，两者语义相反，绝不互相引用或合并。
- **`tlsCa` 是 mTLS 开关，不是「可选 CA」**：非空 ⇒ `https`/`sockss4`/`sockss5` 一律 `requestCert + rejectUnauthorized`（只置 `requestCert` 等于白要一张证书）；判定只走 `requiresClientCert`，各 TLS 服务端不得自行解释。文件缺失/不可读 → `loadCerts` 抛错、启动 abort（**绝不静默降级**），默认值必须为空串 —— `keys/` 是随仓库提交私钥的测试 PKI，拿它当默认安全边界是自欺。TLS1.3 下服务端只发 `tlsClientError`、**不发** `secureConnection`（`ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE`），未授权连接进不了协议层。
- **`[tls-client-error]` 的等级只由 `err.code` 决定**：`bindTlsClientError` 仅对 **`ECONNRESET`**（socket hang up，对端没完成 TLS 握手就断开；端口扫描/健康检查的裸 TCP connect+close 只产生这一种码）传 `override = "debug"` 降级，**其余一律维持 warn**——`ERR_SSL_*`（`ERR_SSL_HTTP_REQUEST` 明文打 TLS 端口、`ERR_SSL_UNEXPECTED_MESSAGE` 畸形记录、`ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE` mTLS 缺客户端证书）意味着双方真交换过 TLS 字节，是有效诊断，**必须保持可见**（改前恒 warn）。**判据绝不能用「已读字节数」**：`tlsClientError(err, socket)` 给的 `socket` 是 **TLSSocket 包装器**，TLS 状态机经底层 handle 读字节并累加到 **raw socket** 的计数器，包装层自己的 `bytesRead` 从不递增、恒为 0（实测：裸探活 0B / 明文 38B / 畸形记录 85B / mTLS 拒绝全部为 0），拿它当判据会把**所有**握手失败与 mTLS 配置错误静默成 debug。读私有 API（`_handle`/`_parent`）或给 raw socket 挂 `data` 监听自己计数都**禁用**（后者扰动 TLS 状态机读路径）。已知代价：握手期间已交换字节、随后被 RST 的对端同样是 `ECONNRESET`，会一并降级（与裸探活在错误码上不可区分），取向是宁可少记噪音。`code`/`authorizationError` 字段与事件名形状不变。SOCKS 握手的**同形目标但不同判据**（那边用读取器自维护的 `bytesReceived`，可靠）见 `src/core/AGENTS.md`。
- **`upstreamCa` 默认空串 = 系统信任库**；一旦配置则**整体替换**系统库（只信任它），公网 CA 上游必然 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` —— 串联公网 HTTPS 上游留空，自签上游才填。读取走 `readUpstreamCa`（非普通文件返回 `undefined`，防 `readFileSync` 抛 EISDIR）。
- `listen.ts`（`listenAsync`）：监听期 error（如 EADDRINUSE）直接 reject；就绪后解绑临时 error 监听，避免启动失败监听器常驻。
- `socket.ts`（`getSocketAddress` / `getSocketLocalBinding`）：**只有面向日志/审计的 `getSocketAddress` 才返回 `"unknown"` 哨兵**；协议字段（`getSocketLocalBinding` 喂 SOCKS 应答 BND）取不到就省略该键由调用方回退，**绝不返回哨兵**，那会污染 SOCKS 应答的协议字段。

## 地址与名单（`addr/`）

- **`address.ts` 是 IP 字节语义的唯一来源**：`normalizeIp`（剥方括号与 `%zone`、统一小写、`::ffff:a.b.c.d` 与 `::ffff:7f00:1` 一律还原为 IPv4）、`ipv4BytesToString` / `ipv6BytesToString`。**禁止在任何其它文件重写 v4-mapped 还原或 IPv6 文本格式化**——双栈下写错一次就是「名单永不命中 / 自环漏判」这类静默故障。
- **`cidr.ts` 只管规则**：`parseIpRule`/`compileIpRules`/`ipMatches` 与 `IpRule` 类型，前缀比对按位掩码（故 `10.0.0.5/24` 与 `10.0.0.0/24` 等价），族不同直接跳过，非法条目返回 undefined 由调用方 fail-closed（本项目一律启动期 abort）。归一一律委托 `address.ts:normalizeIp`，**本模块不重写地址语义**。编译结果只读，可被多会话并发共享。
- **`host.ts:normalizeHost` 是主机文本归一的唯一来源**（小写、剥方括号含 `[v6]:port`、去尾点、剥 `%zone`），`loop.ts` 的自环比对复用它。域名一律小写去尾点、IDN 需写 punycode（ASCII 白名单正则天然拒绝非 ASCII）；`*.a.com` 只匹配 a.com 的子域、不含 a.com 本身（精确与通配职责分离）；**域名按请求 host 字符串匹配、不做 DNS**（解析结果可被 DNS rebinding 绕过；已知边界是「域名条目拦不住客户端直写 IP」，两类条目都写才两头都堵）。
- `request.ts`（`getClientAddress`/`getAuthority`）：`X-Forwarded-For` > `X-Real-IP` > `Forwarded`（归一为裸 IP，剥 `[v6]` 与 `:port`）> socket 远端地址；CONNECT 取 `req.url`、普通请求取 `Host` 头。**这两个值仅供展示与审计**，ACL 的客户端 IP 判定刻意不看它们（可伪造，见 `src/config/AGENTS.md`）。
- `loop.ts`（`isSelfLoopAddr`）：端口不同直接否；监听通配（`0.0.0.0`/`::`）→ 同端口即自环；归一后全等 → 自环；双方都属 loopback 别名族（`localhost`/`127.0.0.1`/`::1`/v4-mapped）→ 自环；目标通配 + 监听 loopback → 自环（`connect(0.0.0.0)` 实际连到 127.0.0.1）。纯函数，监听地址由调用方注入。

## 文件资源（`file/`）

`json.ts` 只做**编排**（缓存 + 节流 + 状态机），三个同目录兄弟模块各管一段，**别把它们合回去**：

- `json-event.ts` — 状态迁移事件的**唯一类型源**与发布器。四类迁移（`error`/`missing`/`recovered`/`reloaded`）× 三种生效值来源（`adopted`/`retained`/`fallback`）；事件只带标量元数据（路径/状态/版本/去敏错误文本），**绝不携带解析值、密码、快照或原始 `Error`**；**发布发生在缓存提交之后**（订阅者回调内 pull 必须看到本轮状态）；订阅方同步异常与异步拒绝都吞掉。事件码新增只改这里。
- `json-error-text.ts` — 错误文本离开缓存层前的唯一净化点，外加 `isMissingError`（**只有** `ENOENT`/`ENOTDIR` 算缺失，`EACCES`/`EPERM`/`EIO` 与非普通文件都归 `error`）与 `ioErrorText`（只从异常取错误码，不带 message/stack）。脱敏用 `log/text.ts:stripControlChars`（压平）而非 `sanitizeLogText`（转义）。
- `json.ts` — `readJsonCached` 主流程 + 缓存条目 + 节流 + `readAndValidate`（读文本→parse→校验，三类失败各有固定文案）。**绝不抛**是硬契约（调用点在每连接 ACL 与每请求鉴权路径上）。失败语义：坏文件保留旧值并返回 error、**已加载文件「存在 → 缺失」回退空配置（ACL 静默全放行的可见性兜底）**、恢复/内容变更热加载。`publishTransition` 是四类迁移判定的唯一收口（按变化去重）。日志呈现归 config 层（`src/config/resources/notice.ts`），**本模块不依赖 logger**。
- `path.ts`（`resolveFromCwd`）：配置里的相对路径按 `process.cwd()` 解析，与 `config/source/dir.ts` 的 `configDir` 语义对齐；只做字符串运算，不碰文件系统，**不存在/不可读的处置归调用方**（入站证书缺失即 abort，上游 CA 缺失即回退系统信任库）。

## 协议常量（`protocol/`）

- `http.ts`（CRLF/版本/原因短语/状态码/默认端口/头名/鉴权 scheme/预拼响应报文/目标主机校验与缓冲上限/`RE_*`）与 `socks.ts`（SOCKS4/5 字节常量、预置应答 Buffer、逐连接成功应答构造、长度常量）都是**零依赖纯值**，`core/` 只读不写、不手写偏移与魔术值。预拼报文（`HTTP_*`）只收真实在用的几种，**新增导出前先确认有调用点**（无调用点的常量是纯负债）。
- **非协议值一律不归这里**：日志控制字符净化在 `log/text.ts`、CLI 参数归一正则（`RE_LEADING_DASHES`/`RE_DASH_GLOBAL`）就地内联在 `config/source/argv.ts`、终端 ANSI 清理就地内联在 `server/banner.ts`。把不属于协议的值塞进 `protocol/` 是本目录被叫「垃圾桶」的根因，别复发。
- 目标主机安全边界（`RE_VALID_TARGET_HOST` 字符白名单 + `MAX_TARGET_HOST_BYTES` 255B）**必须成对使用**：CONNECT 请求行/头与 SOCKS 请求报文的主机名都靠它防注入与 SOCKS5 一字节长度域截断（`Buffer.from([...len])` 会按 256 取模，256 → 0 直接让协议失步）。
