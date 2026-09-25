# src/utils — 基础设施

`logger.ts` / `process-guards.ts` / `cert.ts` / `ip.ts` / `ip-list.ts` / `host-list.ts` / `json-file/` / `net.ts` / `constants.ts` / `upstream-url.ts`。协议常量一律收敛在 `constants.ts`，禁止内联魔数。

## Logger（`logger.ts`）

- `Logger` 是最小可注入端口（`debug/info/warn/error` + 可选 `flush`）；`LoggerImpl` 是 console/JSONL 完整实现。除 logger 实现与 CLI 组合层外，core/config/runtime/server 都只使用当前实例显式注入的 logger，不读取全局 logger。
- `LoggerOptions.config` 绑定一个 `ConfigAccessor`，每次输出现读 `logLevel` / `logFileLevel` / `logFile`；显式 `level` / `fileLevel` / `file` 优先。`createLogger({ config })` 是 CLI 的正式构造入口；**省略 config 时使用固定默认等级**（console=`error`、file=`info`）且没有 logFile，因此不读 env/store、也不落盘。模块不再导出默认 `logger` / `globalLogger` / `getLogger`；CLI、server 与 core 都必须创建或接收显式实例。
- `createNoopLogger()` 是库 runtime 默认：四方法无操作，`flush` 立即 resolve；不读 config、不创建文件/定时器/进程监听，也不写 stdout/stderr。`createConsoleLogger({ level })` 只按显式等级门控（省略=`error`），不读 store/env、不落盘；debug/info 写 stdout，warn/error 写 stderr。
- console 与文件两道独立门限；console 走人类可读文本（`<ISO> <LEVEL> <prefix> <msg> k=v`），文件走 **JSONL**（`log/YYYY-MM-DD-HH.jsonl`，每小时轮转）。直接写、无队列；每次 appendFile 登记进模块级在途集合，`await logger.flush()` 等齐所有实例的在途落盘（`ProxyServer.stop()`/CLI 致命路径/cluster master 收尾在 `process.exit` 前调用；强退路径不等）。日志目录/文件权限为 `0o700`/`0o600`。
- `logger.raw()`（banner）、`file()`（只落盘）、`both()`（双通道）绕过常规门限；`notice()`（生命周期/配置通知）绕控制台等级（`silent` 仍硬关闭），落盘仍按 fileLevel。file/both/notice 共用同一 JSONL schema、保留键、净化与小时轮转。调用永不抛：循环/BigInt/Symbol 有回退，两通道分别隔离；所有字符串做控制字符转义，线数据不能伪造日志行或注入终端转义。
- **结构化字段**：最后一个 plain object 参数即 fields（原型检查排除 Error/Array/Buffer/Date）。文件通道合并到记录顶层，console 渲染 `k=v`；保留键 `ts/level/pid/prefix/msg` 优先。查询示例：`jq -r 'select(.user=="alice") | .msg, .target' log/*.jsonl`、`jq 'select(.level=="warn")' log/*.jsonl`。
- 事件码：`[ip-denied]` / `[target-denied]`（warn，带 client/target/reason）；`[tls-client-error]`（warn，带 code/authorizationError）；forward/auth 行带 user。`stringify()` 与控制台字段渲染会把 Error 输出为 `name: message [code=...] [stack 首帧]`，避免转发 502 成因只剩 `{}`。
- JSON 热加载日志必须显式注入：runtime 用 `createJsonFileEventHandler(runtime.logger)` 创建回调，再传给 users/ACL 读取；`config/files/event-log.ts` 只接受 logger 参数，不持有全局实例。`setupProcessGuards(logger, label?)` 同样显式接当前 logger，并由 `ProxyServer.start()` 传入。

## 证书与网络（`cert.ts` / `ip.ts` / `net.ts`）

- `loadCerts` / `requiresClientCert` + `tlsServerOptions` / `bindTlsClientError`：TLS 建服 options 与握手告警的唯一入口，HTTPS 与 TLS SOCKS 共用。`https.ts` / `TlsSocksProxy` 必须把当前 `this.log` 传给证书加载和握手告警；不得调用 `getLogger()` 或默认 logger。`loadCerts` 的 key/cert/ca 全由显式 `TlsInput` 提供，自身不读配置。
- `readUpstreamCa(config)` / `upstreamTlsOptions(host, config)` 是读出站配置的两个入口，config 必填；`forward/http.ts` 与 `forward/dial.ts` 必须传同一实例 accessor。
- **`tlsCa` 是 mTLS 开关，不是“可选 CA”**：非空 ⇒ `https`/`sockss4`/`sockss5` 一律 `requestCert + rejectUnauthorized`；判定只走 `requiresClientCert`。文件缺失/不可读 → `loadCerts` 抛错、启动 abort，绝不静默降级；默认空串。TLS1.3 下服务端只发 `tlsClientError`，未授权连接进不了协议层。
- **`upstreamCa` 默认空串 = 系统信任库**；一旦配置则整体替换系统库。读取走 `readUpstreamCa(config)`，非普通文件/不可读返回 `undefined`。公网 CA 上游留空，自签上游才填。
- `ip.ts`（`getClientAddress`/`getAuthority`/`isSelfLoopAddr`/`getSocketAddress`）、`ip-list.ts`（IPv4/IPv6 归一与纯规则编译）、`host-list.ts`（IP/CIDR + 精确域名 + `*.域名`，不做 DNS）、`net.ts`（`listenAsync`）保持无配置全局依赖。
- `json-file/` 是按职责分层的目录，跨目录只引 `@/utils/json-file/index.js`（层内用相对路径，禁止自引 barrel）：
  | 文件               | 只负责                                                                                                              |
  | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
  | `types.ts`         | 公共类型契约（`JsonFileEvent` / `JsonFileEventType` / `JsonFileOptions` / `JsonFileRead`），零运行时值              |
  | `cache.ts`         | 缓存键、缓存条目、16 条 LRU 写入与淘汰                                                                              |
  | `subscriber.ts`    | per-subscriber 去重状态 + `ALLOWED_TRANSITIONS` + **全目录唯一的「要不要报事件」判定点** `notifyTransition`         |
  | `probe.ts`         | stat 三态分类（`ok` / `missing` / `stat-error`）                                                                    |
  | `read-validate.ts` | 读文件 + 大小上限 + parse + 形状校验，不抛                                                                          |
  | `json-file.ts`     | **只做编排**：probe → 节流 → 未变更 → 读取 → 落缓存 → 通知；`readJsonCached` 本体约 87 行，体内不得出现任何事件判定 |
  | `index.ts`         | 目录出口，只出 `readJsonCached` + 4 个公共类型；`CacheEntry` / `SubscriberState` / 判定面允许集刻意不导出           |
  - **新增判定面时改 `ALLOWED_TRANSITIONS` 表，不要在 `json-file.ts` 里加 if**：五个判定面（`throttled` / `stat-error` / `missing` / `unchanged` / `read`）各自声明允许触发哪几种迁移，这是「各分支能知道的事实不同」的显式表达（节流面没 stat 过；stat 失败面**只允许 error**，这就是「绝不伪装成 missing」的代码化；未变更面不报 `reloaded`）。
  - `readJsonCached` 不依赖 logger：相对路径在进入缓存前先绝对化；只有 `ENOENT`、`ENOTDIR` 或非普通文件算 missing，坏内容或其它 stat 错误（如 `EACCES`）保留上一份有效值（没有历史时使用 fallback）并返回/发出 `error`，不能让 ACL 因权限错误静默全放行；已加载文件“存在→缺失”才回退空配置。恢复/内容变更可热加载。缓存键为 **label + path**，同路径不同配置类别不串型；事件去重状态按 **onEvent 回调**隔离，共享缓存不吞其它观察者。回调抛错被吞，读取路径绝不抛；呈现归 config/runtime 显式注入的 handler。
  - **两条易踩的等价性口径**：① `error` 一律按**真值**判定（空串等于「无错误」），与全仓 `cached.error` 用法一致；② 事件带不带 `mtimeMs`/`size` 版本由 `current.exists` 决定（`exists === true` 才带），所以 missing 与**首次** stat 失败都不带版本——改判定时别按「其余事件都带版本」的直觉写。`putCache` 必须在 notify **之后**（订阅回调重入同键时看到旧缓存）。回归护栏：`tests/unit/json-file.test.ts`（17 例，断言不得改动，只许改 import 路径）。

## 可注入 Logger 端口（库模式）

- 第三方库默认使用 `createNoopLogger()`；需要控制台时注入 `createConsoleLogger()` 或自有 `Logger` 替身。runtime 不会自行升级为 CLI logger，core 直构缺省也仍是 noop。
- CLI 顺序固定为 `await loadConfig(...)` → `createLogger({ config: context.accessor })` → `runServer(context, logger, noColor)`；server/cluster/logConfig/进程守卫/TLS 告警继续透传同一实例，banner 也显式接收 logger 与 noColor。模块没有任何隐式 logger 回退。
