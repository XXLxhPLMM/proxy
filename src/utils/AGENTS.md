# src/utils — 基础设施（叶子层）

**硬不变量：`src/utils` 是依赖树的最底层。** 运行期只允许两类依赖：`@/utils/*` 内部互引（叶子之间）与 `@/config/index.js` 的 **type-only** 引用。**禁止** import 任何 `@/core/*` 或 `@/server/*`——那会让最底层反向依赖编排层，形成目录级环（历史上 `utils/cert.ts` 反向 import 当时的 `server/log/events-log.ts` 就犯过这条，该文件现已下沉为 `core/log-events.ts`，环已断）。

当前文件：`constants/`（协议常量）、`logger/`（日志端口+三实现+净化+JSONL 落盘）、`tls/`（证书材料与 TLS 选项拼装）、`ip.ts`（客户端地址提取）、`host-text.ts`（主机文本归一原子）、`json-file/`（JSON 配置热加载读取层）。

**不属于本目录**（各自有更贴切的家，别往这塞）：自环判定 → `@/core/helpers/self-loop.js`；目标地址解析 → `@/core/helpers/target.js`；名单条目规则 → `@/config/files/rules/`；上游 URL 契约 → `@/config/schema/upstream-url.js`；建服/监听 → `@/core/server/base.js`；banner 与进程守卫 → `@/server/`。

## Logger（`logger/`）

跨目录只引 `@/utils/logger/index.js`；层内相对引用、**禁止自引 barrel**。

| 文件           | 只负责                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------- |
| `port.ts`      | 契约层：`Logger` / `LogFields` / 透传 `LogLevel` + 两实现共用的 `ORDER`、`COLOR`                |
| `sanitize.ts`  | 文本净化与参数拆分：`sanitizeLogText`/`renderErrorText`/`isPlainObject`/`splitFields`/`renderFieldValue`/`renderFields`/`stringifyValue` |
| `jsonl.ts`     | 落盘子系统：`toHourlyFile`、在途集合、`persistLine`、`flushPendingWrites`（**barrel 不导出**） |
| `impl.ts`      | `LoggerImpl` + `createLogger` + `LoggerOptions`：唯一「双通道」实现，只做编排                 |
| `console.ts`   | `createConsoleLogger`：只按显式 level 门控的轻量实现（库模式给第三方用）                      |
| `noop.ts`      | `createNoopLogger`：库 runtime 默认，零副作用                                                |

- `Logger` 是最小可注入端口（`debug/info/warn/error` + 可选 `flush`）。除 logger 实现与 CLI 组合层外，core/config/runtime/server 都只使用**当前实例显式注入**的 logger，不读全局 logger。
- `LoggerOptions.config` 绑定一个 `ConfigAccessor`，每次输出现读 `logLevel`/`logFileLevel`/`logFile`；显式 `level`/`fileLevel`/`file` 优先。`createLogger({ config })` 是 CLI 的正式构造入口；**省略 config 时用固定默认等级**（console=`error`、file=`info`）且无 logFile，不读 env/store、不落盘。
- **历史类构造别名 `export const Logger = LoggerImpl` 已删除**（破坏性变更，不留兼容层）：值位置一律用 `LoggerImpl`，类型位置用 `Logger` 接口。护栏见 `tests/unit/logger.test.ts`。
- console 与文件两道独立门限；console 走人类可读文本（`<ISO> <LEVEL> <prefix> <msg> k=v`），文件走 **JSONL**（`log/YYYY-MM-DD-HH.jsonl`，每小时轮转）。直接写、无队列；每次 appendFile 登记进**模块级在途集合**，`await logger.flush()` 等齐所有实例的在途落盘（`ProxyServer.stop()`/CLI 致命路径/cluster master 收尾在 `process.exit` 前调用；强退路径不等）。目录/文件权限 `0o700`/`0o600`。
- `impl.raw()`（banner）、`file()`（只落盘）、`both()`（双通道）绕过常规门限；`notice()`（生命周期/配置通知）绕控制台等级（`silent` 仍硬关闭），落盘仍按 fileLevel。file/both/notice 共用同一 JSONL schema、保留键、净化与小时轮转。调用永不抛：循环/BigInt/Symbol 有回退，两通道分别隔离。
- **结构化字段**：最后一个 plain object 参数即 fields（原型检查排除 Error/Array/Buffer/Date）。文件通道合并到记录顶层，console 渲染 `k=v`；保留键 `ts/level/pid/prefix/msg` 优先。查询示例：`jq -r 'select(.user=="alice") | .msg, .target' log/*.jsonl`。
- **渲染只允许一份实现**：`renderFields` 与 `stringifyValue` 是唯一的字段/参数渲染入口，`impl.fmt` 与 `console.ts` 都调它们（历史上存在逐行同构的 `renderPortableFields`/`formatPortableArgs` 两份副本，已合并）。唯一刻意保留的差异：`impl.fmt` **不**把 Error 转单行，Error 原样交给 `console.*` 以保留原生堆栈。
- 事件码（`[ip-denied]`/`[target-denied]`/`[tls-client-error]` 等）**不在本目录**：词汇表在 `@/core/log-events.js`，落盘 switch 在 `src/server/index.ts:bindProxyEventLogs`。
- JSON 热加载日志必须显式注入：runtime 用 `createJsonFileEventHandler(runtime.logger)` 创建回调再传给 users/ACL 读取；`config/files/event-log.ts` 只接受 logger 参数。`setupProcessGuards(logger, label?)`（已搬到 `@/server/process-guards.js`）同样显式接当前 logger，由 `ProxyServer.start()` 传入。

## 常量（`constants/`）

跨目录只引 `@/utils/constants/index.js`；层内相对引用、**禁止自引 barrel**。协议常量一律收敛在此，**禁止内联魔数**（连 `^\d+$` 这种也要走 `RE_DIGITS`）。

| 文件        | 只负责                                                  |
| ----------- | ------------------------------------------------------- |
| `http.ts`   | CRLF/HTTP 版本/状态码/原因短语/预拼响应报文/头名头值/鉴权 scheme/默认端口 |
| `socks.ts`  | SOCKS4/5 全部常量与预置应答 Buffer                      |
| `limits.ts` | 安全边界上限与白名单（目标主机长度/字符集、状态行字节上限、日志控制字符） |
| `regex.ts`  | 全部预编译正则                                          |

- 四个子文件**互不引用**，各自自足；跨文件需要共享的值请放回对应域或提升到调用点，不要造第三条依赖。
- **零函数**：`buildProxyAuthValue` 已搬到 `@/core/helpers/credentials.js` → 调用方应经 barrel 引 `@/core/helpers/index.js`（它拼的是头值，属凭证原语）。本目录只出纯值。
- **禁止导出仅内部使用的值**：`STATUS_LINE_PREFIX`、`REASON_CONNECTION_ESTABLISHED`、`REASON_SWITCHING_PROTOCOLS`、`REASON_GATEWAY_TIMEOUT` 是模块私有。新增常量前先确认外部有引用再 export。
- 已删除的零引用死值（勿复活）：`BODY_BAD_REQUEST`、`HTTP_101_SWITCHING_PROTOCOLS`（101 由上游回给客户端，代理从不写裸 101 串）、`HTTP_500_INTERNAL_ERROR`、`SOCKS5_METHOD_REJECT`（被 `SOCKS5_AUTH_REJECT` 取代）、`SOCKS5_REP_FAILURE`、`build407Response()`。
- 缺省端口只有一份：`DEFAULT_PORT_HTTP`/`DEFAULT_PORT_HTTPS`。上游 URL 的 scheme 表（`config/schema/upstream-url.ts`）必须引它们，不要再写第二份 80/443。

## TLS（`tls/`）

跨目录只引 `@/utils/tls/index.js`；层内相对引用、**禁止自引 barrel**。本目录**零跨层依赖**（只 type-only 引用 `ConfigAccessor`）。

| 文件               | 只负责                                                          | 配置依赖 |
| ------------------ | --------------------------------------------------------------- | -------- |
| `certs.ts`         | `TlsKeyCert`/`TlsInput`/`LoadedTlsCerts` + `loadCerts`（读不到必抛） | 无       |
| `server-options.ts`| `requiresClientCert` / `tlsServerOptions`（零 IO 纯拼装）        | 无       |
| `upstream.ts`      | `readUpstreamCa` / `upstreamTlsOptions`（出站建链）             | 必填     |

- `loadCerts`/`requiresClientCert` + `tlsServerOptions` 是入站建服选项的唯一入口，HTTPS 与 TLS SOCKS 共用。`https.ts`/`TlsSocksProxy` 必须把当前 `this.log` 传给证书加载。
- **握手失败告警不在本目录**：`bindTlsClientError` 住在 `@/core/server/tls-alarm.js`（建服骨架的一部分，依赖 `@/core/log-events.js`）。放这里会迫使 utils 依赖 core/server。
- **路径绝对化只有配置层一个权威**：`tlsKey`/`tlsCert`/`tlsCa`/`upstreamCa` 在 `FIELDS` 里都标了 `path: true`，`resolveConfigPaths(config, configDir)` 已在构造期按 configDir 解析。本模块**不再自己 `path.resolve`**（历史上的 `resolvePath` 以 cwd 为基准，与 configDir 语义分叉，已删）；直接把入参路径交给 `readFileSync`/`statSync`（Node 自身仍按 cwd 解析相对路径，行为不变）。
- **`tlsCa` 是 mTLS 开关，不是「可选 CA」**：非空 ⇒ `https`/`socks4`/`socks5` 一律 `requestCert + rejectUnauthorized`；判定只走 `requiresClientCert`。文件缺失/不可读 → `loadCerts` 抛错、启动 abort，绝不静默降级；默认空串。
- **`upstreamCa` 默认空串 = 系统信任库**；一旦配置则**整体替换**系统库。读取走 `readUpstreamCa(config)`，非普通文件/不可读返回 `undefined`。公网 CA 上游留空，自签上游才填。
- 出站 TLS 三选项（`servername`/`rejectUnauthorized`/`ca`）必须经 `upstreamTlsOptions`：校验锚定**建链目标**而非转发 Host 头；IP 按 RFC6066 置空 SNI。

## 地址与文本（`ip.ts` / `host-text.ts`）

- `ip.ts` 只做**取值与轻度归一**：`getClientAddress`（XFF > X-Real-IP > Forwarded > socket）、`getAuthority`、`getSocketAddress`（统一 `"unknown"` 哨兵）。**零配置依赖、零 IO、零日志**；不做自环判定、不做名单匹配、不解析 authority。
- `host-text.ts` 是主机文本归一化的**唯一原子收口点**：`stripIpBrackets`/`stripZone`/`stripTrailingDot`/`lowerTrim`，零项目依赖。规则层、自环判定、`core/helpers/target.ts` 的解析侧共用它；`formatAuthority`（`@/core/helpers/target.js`）是全项目唯一的**反向**（补回 IPv6 方括号）。
- 「防循环转发」是转发策略不是地址原语：`isSelfLoopAddr` 住在 `@/core/helpers/self-loop.js`，其归一链与 ACL 名单**同一份实现**（`normalizeHost` + `normalizeIp` + `ipToString`）。

## `json-file/` — 目录出口与唯一判定点（本目录的范式样板）

按职责分层的目录，跨目录只引 `@/utils/json-file/index.js`（层内相对引用，禁止自引 barrel）：

| 文件               | 只负责                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `types.ts`         | 公共类型契约（`JsonFileEvent`/`JsonFileEventType`/`JsonFileOptions`/`JsonFileRead`），零运行时值                      |
| `cache.ts`         | 缓存键、缓存条目、16 条 LRU 写入与淘汰                                                                              |
| `subscriber.ts`    | per-subscriber 去重状态 + `ALLOWED_TRANSITIONS` + **全目录唯一的「要不要报事件」判定点** `notifyTransition`         |
| `probe.ts`         | stat 三态分类（`ok`/`missing`/`stat-error`）                                                                        |
| `read-validate.ts` | 读文件 + 大小上限 + parse + 形状校验，不抛                                                                          |
| `json-file.ts`     | **只做编排**：probe → 节流 → 未变更 → 读取 → 落缓存 → 通知；体内不得出现任何事件判定                                  |
| `index.ts`         | 目录出口，只出 `readJsonCached` + 4 个公共类型                                                                     |

- **新增判定面时改 `ALLOWED_TRANSITIONS` 表，不要在 `json-file.ts` 里加 if**：五个判定面（`throttled`/`stat-error`/`missing`/`unchanged`/`read`）各自声明允许触发哪几种迁移。
- `readJsonCached` 不依赖 logger：相对路径进入缓存前先绝对化；只有 `ENOENT`/`ENOTDIR`/非普通文件算 missing，坏内容或其它 stat 错误（如 `EACCES`）保留上一份有效值并返回/发出 `error`，**不能让 ACL 因权限错误静默全放行**；已加载文件「存在→缺失」才回退空配置。缓存键为 **label + path**；事件去重状态按 **onEvent 回调**隔离。回调抛错被吞，读取路径绝不抛。
- 两条易踩口径：① `error` 一律按**真值**判定；② 事件带不带 `mtimeMs`/`size` 由 `current.exists` 决定。`putCache` 必须在 notify **之后**。护栏：`tests/unit/json-file.test.ts`（17 例，断言不得改动，只许改 import 路径）。

## 本目录 Gotchas

- 新增文件前先自问：**它属于基础设施吗？** 答案通常是「不属于」——带业务概念的（上游、名单、目标、生命周期）都该去 core/config/server。放错层的代价是反向依赖与「叫这个名字的读者会误解」。
- 拆目录的模板照 `json-file/` 与 `logger/` 抄：单一 barrel、层内相对引用、判定面集中在一处、注释写明「为什么不放这里」。
- 生成物（如 banner）不住在本目录：banner 已搬 `@/server/banner.js`，`scripts/gen-banner.mjs` 与 `build.mjs` 的输出路径要同步改，否则构建会自我激活着。
