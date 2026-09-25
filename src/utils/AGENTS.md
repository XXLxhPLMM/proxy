# src/utils — 基础设施

`logger.ts` / `process-guards.ts` / `cert.ts` / `ip.ts` / `ip-list.ts` / `host-list.ts` / `json-file.ts` / `net.ts` / `constants.ts` / `upstream-url.ts`。协议常量一律收敛在 `constants.ts`，禁止内联魔数。

## Logger（`logger.ts`）

- 所有 `src/` 代码用 `logger` / `getLogger(prefix)`，不用 `console.*`（ESLint `no-console`）。
- console 与文件两道独立门限：`get("logLevel")`（console，默认 `error`）与 `get("logFileLevel")`（file，默认 `info`）每调用现取；console 走人类可读文本（`<ISO> <LEVEL> <prefix> <msg> k=v`），文件走 **JSONL**（`log/YYYY-MM-DD-HH.jsonl`，每小时轮转）。直接写、无队列；每次 appendFile 登记进模块级在途集合（全实例共享），`await logger.flush()` 等齐在途落盘后返回（`ProxyServer.stop()`/CLI 致命路径/cluster master 收尾在 `process.exit` 前调用；强退路径不等；正常事件循环退出无需）。`logger.raw()`（banner）/`logger.file(level,…)`（只落盘）/`logger.both(level,…)`（双通道）bypass 两道门；`logger.notice(level,…)`（生命周期/配置通知：启动摘要、worker 就绪、ACL·账号表热加载）绕控制台门限（`silent` 除外）、落盘仍按 `fileLevel`；file/both/notice 落盘走与常规行完全相同的 JSONL 管线（同一 schema/保留键/净化/小时轮转）。调用永不抛：循环/BigInt/Symbol 有回退，两通道 try/catch。所有字符串参数做控制字符转义（线数据不得伪造日志行或注入终端转义）；日志目录/文件 `0o700`/`0o600`。
- **结构化字段**：`logger.info("msg", { ...fields })` —— 最后一个纯对象参数即字段（原型检查天然排除 `Error`/`Array`/`Buffer`/`Date`）。文件通道合并进记录顶层，console 渲染 `k=v`。保留键 `ts/level/pid/prefix/msg` 优先，同名字段被忽略。行形态：`{"ts":"2026-09-20T14:03:11.201Z","level":"info","pid":1234,"prefix":"[proxy]","msg":"[forward]","client":"1.2.3.4","target":"example.com:80","method":"GET","user":"alice"}`。查询：`jq -r 'select(.user=="alice") | .msg, .target' log/*.jsonl`；`jq -r 'select(.msg=="[auth] deny") | .client' log/*.jsonl | sort | uniq -c`；`jq 'select(.level=="warn")' log/*.jsonl`。
- 事件码：`[ip-denied]` / `[target-denied]`（warn，带 `client`/`target`/`reason`）；`[tls-client-error]`（warn，TLS 握手失败含 mTLS 拒绝，带 `code`/`authorizationError`）；forward/auth 行带 `user`。
- **Error 渲染**：`stringify()`（落盘 msg）与控制台字段渲染对 `instanceof Error` 特判为可读单行文本 `name: message [code=...] [stack 首帧]`（经 `sanitizeLogText` 净化）——`JSON.stringify(Error)` 只会得到 `{}`，转发层 502 的成因（ECONNREFUSED/TLS 校验失败）不能丢；控制台 msg 通道不变，Error 仍原样交给 `console.*`（原生堆栈可读）。fields 判定不受影响（Error 仍不是 fields）。
- `setupProcessGuards()` 捕获 `uncaughtException`/`unhandledRejection`/`warning`（只记不退出），由 `ProxyServer.start()` 调一次。

## 证书与网络（`cert.ts` / `ip.ts` / `net.ts`）

- `loadCerts` / `requiresClientCert` + `tlsServerOptions` / `bindTlsClientError`：TLS 建服 options 组装与 `tlsClientError` 告警接线的唯一入口，https 与 TLS SOCKS 共用。`readUpstreamCa` / `upstreamTlsOptions`：出站 TLS 三选项组装，`forward/http.ts` 与 `forward/dial.ts` 共用。
- **`tlsCa` 是 mTLS 开关，不是「可选 CA」**：非空 ⇒ `https`/`sockss4`/`sockss5` 一律 `requestCert + rejectUnauthorized`（只置 `requestCert` 等于白要一张证书）；判定只走 `requiresClientCert`，各 TLS 服务端不得自行解释。文件缺失/不可读 → `loadCerts` 抛错、启动 abort（**绝不静默降级**），默认值必须为空串 —— `keys/` 是随仓库提交私钥的测试 PKI，拿它当默认安全边界是自欺。TLS1.3 下服务端只发 `tlsClientError`、**不发** `secureConnection`（`ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE`），未授权连接进不了协议层。
- **`upstreamCa` 默认空串 = 系统信任库**；一旦配置则**整体替换**系统库（只信任它），公网 CA 上游必然 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` —— 串联公网 HTTPS 上游留空，自签上游才填。读取走 `readUpstreamCa`（非普通文件返回 `undefined`，防 `readFileSync` 抛 EISDIR）。
- `ip.ts`（`getClientAddress`/`getAuthority`/`isSelfLoopAddr`/`getSocketAddress`）、`ip-list.ts`（`normalizeIp` 含 `::ffff:` → IPv4，`parseIpRule`/`compileIpRules`/`ipMatches` 纯函数无 IO）、`host-list.ts`（IP/CIDR + 精确域名 + `*.域名`，不做 DNS）、`json-file.ts`（`readJsonCached` 节流热加载，**不依赖 logger**：坏文件保留旧值并返回 error、**已加载文件「存在 → 缺失」回退空配置（ACL 静默全放行的可见性兜底）、恢复/内容变更热加载** —— 四类状态迁移以 `onEvent` 事件（`error`/`missing`/`recovered`/`reloaded`）抛出、按变化去重，事件携带触发内容的版本标识 `mtimeMs`/`size`（missing 无）；日志呈现归 config 层（`src/config/json-file-log.ts`）；订阅回调抛错被吞，绝不抛）、`net.ts`（`listenAsync`，http/https/socks 共用的 listen-and-wait 封装）。

## 可注入 Logger 端口（库模式）

- `Logger` 是库消费端可替换的最小端口：`debug`/`info`/`warn`/`error` 保持现有实现的 `...args: unknown[]` 形态，`flush?()` 等齐在途落盘；`LogFields` 是结构化字段类型。这样既兼容 Error、extra、末位 plain object fields 等既有调用，又不要求替身实现落盘或配置能力。
- `createNoopLogger()` 是库模式默认：四个方法无操作，`flush` 立即 resolve；不读取 config、不创建文件、不启动定时器、不注册进程事件，也不写 stdout/stderr。
- `createConsoleLogger({ level })` 只按注入的 `level` 门控（省略时沿用 CLI 默认 `error`），不读取 store/env 配置、不落盘、不创建定时器或进程监听；`debug`/`info` 写 stdout，`warn`/`error` 写 stderr，末位结构化字段按 `k=v` 渲染。
- 分工：第三方库调用默认使用 `createNoopLogger()`，需要控制台时注入 `createConsoleLogger()` 或自有 `Logger` 替身；CLI 及现有服务路径继续使用 `logger` 单例（`globalLogger` 是其最小端口视图），保留配置门控、JSONL 小时轮转、敏感信息净化和 `flush` 语义。
