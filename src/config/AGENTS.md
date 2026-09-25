# src/config — 配置加载

`store.ts`（零 IO 的 Map 单例 + `commitConfig` 原子 candidate 提交）+ `fields.ts`（FIELDS 表）+ `loader.ts`（表驱动初始化与 runtime candidate 校验）+ `config-helpers.ts`（CLI 归一/`.env` 读取/`toBoolean`）+ `auth-users.ts` + `acl.ts` + `json-file-log.ts`（热加载事件 → notice 日志）。FIELDS 表是 env 名的唯一真相源，不许在别处再建第二张表。

## 初始化流程

1. 配置初始化不再依赖模块导入副作用：CLI 的 `start()` 先调用 `ConfigService.load()`；库兼容入口 `runServer()` 在判断 cluster 角色前显式调用 `initConfig()`。`loader.ts` 只导出初始化函数，不再在模块末尾裸调用。
2. `store.ts` 单例 `Map<ConfigKey, AppConfig[ConfigKey]>`，由 `defaults` 做种子。
3. `loader.ts:initConfig()`（幂等，表驱动）：
   - `useHomeConfig` 先决（CLI > env），决定配置目录（`~/.proxy` vs `cwd`）。
   - `loadEnvFiles()`：低→高 `.env.production` → `.env.development` → `.env.<NODE_ENV>`（去重保留后者），`dotenv.parse` 后写 `process.env` —— **终端已设变量永不覆盖**（后文件仍胜过前文件）。
   - `parseRawArgv()` 归一 `--key value` / `--key=value` / `KEY=VALUE`（两种 `=` 形态都在**第一个** `=` 处切分，值可含 `=`）。显式给的值解析失败即 abort 启动 —— CLI 与 env 一视同仁，永不静默回退（布尔拼写错误也一样，`AUTH_ENABLED=treu` 会报错而不是悄悄变 `false`）。
   - FIELDS 解析循环是共享的：`fields.ts:resolveFieldEntries(source)` 返回 `{ resolved, bad }`；`initConfig()` 喂 CLI>env 再补 `def`/`defaults` 回退，`parseStartupArgs()` 喂解析后的 argv（仅显式键），runtime candidate 则用同一 parser 做 typed 值校验——各自保留 range 检查 + 抛错。布尔解析只活在 `config-helpers.ts:toBoolean`（`fields.ts` 的 `parse: toBoolean` 行与早期 `USE_HOME_CONFIG` 查找共用）——不许本地复制。
   - 整数范围由 `FieldDef.int` 逐字段声明，解析后统一过 `collectIntRangeErrors()`（`port`/`upstreamPort` 1-65535，`upstreamTimeout` >=1，`clusterWorkers` 0-1024）——`parseStartupArgs()` 跑同一检查，不另建校验 schema。
   - 两个可热加载 JSON（`cfg/users.json` / `cfg/acl.json`）在写 store 前强制读 + 校验：`initConfig()` 调 `readAuthUsers({ force, path })` / `readAcl({ force, path })`（显式传 path，因 store 里还是旧默认值）——非法内容 abort（`配置校验失败: AUTH_USERS_FILE=<path> ...` / `ACL_FILE=<path> ...`）。store 里只存**路径**；解析值住在 `json-file` 缓存层，保持热加载。
   - 跨字段守卫 `assertAuthConfig({ authEnabled, authType, accountCount, jwtSecret })`：`authEnabled && (basic|uid) && accountCount === 0` 即 abort（指向 `AUTH_USERS_FILE`；空账号表否则是静默“全拒绝”）。
   - `_inited` 只在全部检查通过且 store 写完后翻 `true` —— 初始化失败会重抛而不是静默返回默认值。
4. `src/cli.ts` 的 `require.main === module` → `start()`：cluster master 走 `runAsMaster({ allowProcessExit: true })`，单进程/worker 走 `src/runtime/bootstrap.ts:startRuntime(createProxyService(new ProxyServer({ allowProcessExit: true })))`；runtime 不设置退出 ownership。
5. `startRuntime()` 创建 Cordis Context 并注册 runtime lifecycle plugin，最终调用旧 `ProxyServer.start()`；master 不挂载代理插件。库兼容入口 `src/server/index.ts:runServer()` 返回 `ProxyServer` 句柄，库默认 `allowProcessExit=false`，master 分支仍只管理 worker。
6. `ProxyServer.start()` → `setupProcessGuards()` → 打掩码配置 → `createProxy()`（按 `proxyProtocol`）→ `proxy.start()`。

`src/index.ts` import 之后的代码可直接 `get()`；只引 `store.ts` 的隔离代码必须显式调 `initConfig()`。CLI 构建入口是 `src/cli.ts`（esbuild 打包出 `dist/app.js`），库入口 `src/index.ts` 不含启动块。

## Runtime ConfigService 与事务边界

- `ConfigService.load()` 是唯一读取 CLI/env/preset 的启动入口；`reload(patch)` 绝不重新读取这些来源，也绝不动态解析 preset 或加载插件。
- `reload()` 只接受 `phase=runtime` 的字段，startup 字段在 patch 中出现时整批拒绝。字段 parser、枚举、整数范围、UPSTREAM_URL 派生和 auth 跨字段校验都委托 `fields.ts`/`loader.ts`，ConfigService 不维护第二份规则。
- loader 先基于 `store.getAll()` 构造完整 candidate，并 force 校验 candidate 指向的 users/ACL；验证全部通过后才调用 `store.commitConfig()` 一次性替换活动 Map。失败不写任何字段，service 保持 `ready`，`lastFailure` 只保留脱敏的 `name/code/message`。
- `load/reload/refreshResource` 共用一条串行队列；成功 reload 只有在实际字段变化时发布 `config/reloaded`，空 patch/等值 patch 不伪造事件。资源事件 listener 的异常和异步拒绝不能反噬配置操作。
- `refreshResource("authUsers"|"acl")` 只是按需 force pull：不创建 watcher、不返回 users/ACL 内容，只返回路径、存在性、transition/outcome、mtime/size 和去敏错误。资源状态仍由 reader 的 last-good/fallback 语义决定。
- ConfigService 是 pull 模型的消费者：事件通知“缓存状态已提交”，需要生效值时再调用 `readAuthUsers`/`readAcl` 或对应 service；事件桥不传 AppConfig、账号、名单、密码、token、cause 或原始 Error。

## 加载优先级与 env 表

- **优先级**：CLI args > 终端 env > env 文件值 > Preset > defaults。
- **Preset**：`PRESET` 选择 `presets.ts` 中的命名配置片段；preset 是 `FIELDS` 默认回退层的一部分，写入后仍走范围、JSON 和鉴权交叉校验，未知名称直接 abort。
- **env 键** —— 每字段恰一名（无别名），以 `FIELDS` 每行的 `env` 为准：

| Env Key                                                                                                                                                       | Description                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                                                                                                                                                        | listen IP, default `0.0.0.0`                                                                                                                                                                                         |
| `PORT`                                                                                                                                                        | listen port                                                                                                                                                                                                          |
| `PROXY_PROTOCOL`                                                                                                                                              | `http`\|`https`\|`socks4`\|`socks5`\|`sockss4`\|`sockss5`                                                                                                                                                            |
| `PROXY_MODE`                                                                                                                                                  | `server`\|`client`                                                                                                                                                                                                   |
| `AUTH_ENABLED`                                                                                                                                                | `true`/`false`                                                                                                                                                                                                       |
| `AUTH_TYPE`                                                                                                                                                   | `none`\|`basic`\|`jwt`\|`uid`                                                                                                                                                                                        |
| `AUTH_USERS_FILE`                                                                                                                                             | path to the multi-account JSON (`[{ "username": "alice", "password": "pw1" }]`), default `<configDir>/cfg/users.json`                                                                                                |
| `JWT_SECRET`                                                                                                                                                  | jwt credential                                                                                                                                                                                                       |
| `AUTH_LOGGING`                                                                                                                                                | `true`/`false`                                                                                                                                                                                                       |
| `ACL_FILE`                                                                                                                                                    | path to the ACL JSON (`clientIp`/`target`/`upstream` × `whitelist`/`blacklist`), default `<configDir>/cfg/acl.json`                                                                                                  |
| `LOG_LEVEL`                                                                                                                                                   | console level: `debug`\|`info`\|`warn`\|`error`\|`silent`, default `error`                                                                                                                                           |
| `LOG_FILE_LEVEL`                                                                                                                                              | file level, same values, default `info` — independent from `LOG_LEVEL`                                                                                                                                               |
| `LOG_FILE`                                                                                                                                                    | dir or file path → hourly JSONL `YYYY-MM-DD-HH.jsonl`                                                                                                                                                                |
| `CACHE_TYPE`                                                                                                                                                  | `memory`\|`redis`                                                                                                                                                                                                    |
| `UPSTREAM_TIMEOUT`                                                                                                                                            | ms, default 10000（同时是 cluster 停机 grace 基数，见 `src/server/AGENTS.md`）                                                                                                                                       |
| `TLS_KEY` / `TLS_CERT` / `TLS_PASSPHRASE`                                                                                                                     | TLS server cert paths (only `https`/`sockss4`/`sockss5`)                                                                                                                                                             |
| `TLS_CA`                                                                                                                                                      | client-cert CA = **mTLS switch**. Empty (default) = server-only TLS; set = client certs **required** on `https`/`sockss4`/`sockss5`, unreadable file aborts startup. No default file（机制见 `src/utils/AGENTS.md`） |
| `UPSTREAM_URL`                                                                                                                                                | `scheme://[user:pass@]host[:port]` — overrides granular upstream fields                                                                                                                                              |
| `UPSTREAM_HOST` / `UPSTREAM_PORT` / `UPSTREAM_SECURE` / `UPSTREAM_USERNAME` / `UPSTREAM_PASSWORD` / `UPSTREAM_CA` / `UPSTREAM_INSECURE` / `UPSTREAM_PROTOCOL` | granular upstream（`UPSTREAM_CA` 语义见 `src/utils/AGENTS.md`）                                                                                                                                                      |
| `CLUSTER_WORKERS`                                                                                                                                             | 0 (=CPU cores) .. 1024                                                                                                                                                                                               |
| `USE_HOME_CONFIG`                                                                                                                                             | `true` → `~/.proxy/`                                                                                                                                                                                                 |
| `PRESET`                                                                                                                                                      | 命名预设，默认空；低于显式 env/CLI，高于 defaults                                                                                                                                                                    |

- **Phase**：每 `FIELDS` 行必填 `phase`。`startup` 键只在 `ProxyServer.start()` 读一次进 `ProxyOptions`（`proxyProtocol`/`host`/`port`/`tls*`/`clusterWorkers`/`preset`）或只影响启动期解析（`useHomeConfig`）——改了要重启进程；`runtime` 键每请求/每日志调用重读，可经 `ConfigService.reload()` 热改。`logConfig()` 启动时打印 startup 清单，`keysByPhase()` 是机器可读源。
- 新增配置：`AppConfig` + `store.ts:defaults` 加字段，再在 `fields.ts:FIELDS` 加**一行**（`{ key, env, parse, phase, int?, def? }`，`phase` 必填；有界整数加 `int: { min, max }`）。`src/core/types/proxy.ts:ProxyProtocol` 与 `store.ts:ProxyProtocol` 保持同步；用户可见键同步更新本文件 env 表。

## 访问控制（ACL）

三组名单同住 `ACL_FILE`（`cfg/acl.json`），一次热加载、一次校验：

```json
{
  "clientIp": { "whitelist": ["127.0.0.1", "10.0.0.0/8"], "blacklist": ["203.0.113.7"] },
  "target": { "whitelist": ["*.example.com"], "blacklist": ["ads.example.net", "198.51.100.0/24"] },
  "upstream": { "whitelist": ["intranet.example.com"], "blacklist": ["127.0.0.1"] }
}
```

- 三组均可缺省（缺省 = 空名单，老文件无 `upstream` 键仍合法）；未知键 / 非法条目 → `initConfig()` abort（`配置校验失败: ACL_FILE=<path> ...`）。文件缺失 = 不拦任何请求。
- `clientIp` 条目**只收 IP/CIDR**（对端永远是 IP，写域名属配置错误），按 **TCP 对端地址**（`socket.remoteAddress`）判定，**刻意不看 `X-Forwarded-For`/`X-Real-IP`**（客户端可伪造，那两个头只用于 auth 审计展示）。`::ffff:1.2.3.4` 归一化为 IPv4 再匹配（Windows/双栈必须）。
- `target` 条目收 **IP/CIDR/域名/`*.域名`**；`*.a.com` 只匹配 `a.com` 的子域、**不含 `a.com` 本身**（子域要单独写）；域名按**客户端请求的 host 字符串**匹配（小写、去尾点、剥方括号），**不做 DNS 解析**，条目**不支持端口**。所以「域名黑名单 + 客户端直接写 IP」能绕过——要两头都堵就两类条目都写。
- 语义（`clientIp`/`target` 两组一致）：黑名单命中 → **拒绝（优先）**；白名单非空且未命中 → 拒绝；皆空 → 放行。
- `upstream` 组（第三组，client 模式路由名单）**动作相反**：黑名单命中 → **直连**（优先）；白名单非空且未命中 → 直连；皆空（含整组缺失）→ 走上游。真值表：走上游 ⇔ 命中 whitelist ∧ 未命中 blacklist；**仅 `PROXY_MODE=client` 有意义**——server 模式由 `core/proxy-helpers:resolveRoute` 短路，不进判定。条目与 `target` 同形（IP/CIDR/域名/`*.域名`，kind `host`，不支持端口、不做 DNS）；判定对象同样是「客户端请求的目标」，上游地址永不进名单。命中直连的请求在 preDial 通过后打一条 info 级 `[route]` 日志（`target`/`route`/`reason`，机制见 `src/core/AGENTS.md`）。
- 被拒行为：HTTP/CONNECT/upgrade 回 **403 Forbidden**；SOCKS 在握手前直接断开（无协议应答，也不为被禁 IP 解析握手）。
- 被拒各打一条 warn：`[ip-denied]`（带 `client`/`reason`）或 `[target-denied]`（带 `target`/`host`/`reason`）。
- 判定入口：`checkClientIp(addr)`（`core/server/http.ts:handleForward()` 最先、`socks-base.ts:onConn()` 首行，均早于鉴权）、`checkTargetHost(host)`（四条转发路径 http/tunnel/websocket/socks，均在目标已解析、尚未拨号处，紧邻现有 `isSelfLoop` 守卫）与 `checkUpstreamRoute(host)`（仅 `core/proxy-helpers:resolveRoute` 调用，client 模式路由判定）。**判定顺序**：clientIp → auth → target ACL（403，永不旁路）→ 路由判定 → 拨号。**判定对象永远是「客户端请求的目标」**：absolute-form 取 request-target 的 authority（RFC 7230 §5.4），缺失时回退 `Host`；**与 `proxyMode` 无关**——client 模式下拨号目标是上游，而上游的协议/地址/端口只来自 `UPSTREAM_*`、**永不进名单**（自环守卫看的才是拨号地址；`upstream` 组命中改的是路由而非名单判定）。相关行为需通过黑盒验证覆盖 target 名单语义、upstream 路由语义、拒绝/放行边界及 `[route]` 日志。
- **热加载**：`cfg/acl.json` 与 `cfg/users.json` 都经 `utils/json-file.ts:readJsonCached` 做**每文件最多 1s 一次的 stat 节流**（`maxAgeMs=1000`、`maxBytes=1MiB`），改动最多 1s 生效、**无需重启**。`readJsonCached` 不记日志，只把状态迁移作为 `onEvent` 事件抛出（`error`/`missing`/`recovered`/`reloaded`，变化才触发）；`acl.ts`/`auth-users.ts` 统一挂 `json-file-log.ts:logJsonFileEvent` 落 `notice`：坏内容保留上一份有效配置（warn，不接管坏数据）、已加载文件消失（warn，ACL 静默全放行的兜底）、恢复/内容变更热加载（info）——默认 error 级控制台可见，`LOG_LEVEL=silent` 下静音。每行带结构化字段 `pid`（cluster 下每个 worker 各自热加载、各打一行，不做去重/聚合，凭 pid 区分进程）与 `mtimeMs`/`size`（版本标识，区分「同版本被 N 进程加载」与「文件被多次修改」；missing 事件无）。
- 两个文件含密码/名单，`.gitignore` 已忽略 `cfg/users.json` / `cfg/acl.json`，仓库只提交 `cfg/users.json.example` / `cfg/acl.json.example`。

## 资源事件桥与 pull 模型

- `resource-events.ts` 是 **Cordis-free** 的进程内配置领域事件总线，资源身份固定区分 `authUsers` 与 `acl`；`json-file.ts` 的缓存键是「资源 + 路径」，同一路径的两种资源不能共享值、错误或 missing 状态。总线只承载标量事实（`path`、`transition`、`outcome`、`mtimeMs`、`size`、去敏 `error`），不携带账号/名单内容、密码、配置快照或原始 `Error`。
- `readJsonCached` 仍是唯一的按需读取入口：每个资源/路径最多 1s 一次 `stat`，没有 `fs.watch` 或 timer watcher；事件在缓存条目提交之后发布，因此订阅者若在回调中再次 pull，看到的是本轮已提交状态。`error` / `missing` / `recovered` / `reloaded` 按变化去重，`outcome` 明确为 `adopted`、`retained` 或 `fallback`。
- 只有真正的 `ENOENT` / `ENOTDIR` 才是 `missing`（按既有安全语义回退空配置）；`EACCES`、`EPERM`、`EIO`、其它 I/O、非普通文件和 schema 错误统一是 `error`，有上一份有效值就 `retained`，否则 `fallback`。错误文本在缓存层去敏，事件不携带原始异常。
- 事件总线采用 **pull 模型**：事件只是“资源状态已变化”的通知，调用方仍通过 `readAuthUsers` / `readAcl`（或 ConfigService）按需读取当前生效值；ConfigService/config-plugin 现在只把安全元数据桥到 Cordis，不把资源值塞进事件。`subscribeConfigResourceEvents` 返回幂等 disposer，订阅者同步异常与异步拒绝均隔离，Context 停止时由 `ctx.effect` 取消订阅。
- `json-file-log.ts` 是唯一 notice 呈现路径：它订阅资源总线一次，`auth-users.ts` / `acl.ts` 只负责把 JSON 事件桥上总线，不得另接 logger 或新增第二条日志路径。

## Preset 事件语义

- preset 只在启动合并阶段选择并校验；runtime reload 遇到 `preset` 或其它 startup 字段会整批失败，不会切换 preset、改变插件图或动态加载插件。
- `preset/applied` 这个事件名表达的是“启动时选择了 catalog 定义”的既成事实；只有确实存在 active preset 才发布，事件中的 `plugins` 是目录元数据，不代表事件消费者应当动态加载它们。无 active preset 时不发布。

## 本目录 Gotchas

- 开发环境 `.env.development` 开启了 `uid` 鉴权且指向 `./cfg/users.json`：账号表为空会**启动即 abort**，所以首次必须先 `cp cfg/users.json.example cfg/users.json`（该文件已被 `.gitignore` 忽略，仓库只提交 `*.example`）。
- `proxyMode` `server` vs `client` 决定 `resolveRoute` 的有效模式（server 读 URL/Host 直拨；client 拨 `upstreamHost`/`upstreamPort`，但 `upstream` 路由名单命中即回落直拨真实目标）——见 `src/core/AGENTS.md`。
