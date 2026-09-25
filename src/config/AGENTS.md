# src/config — 配置加载

`store.ts`（唯一配置状态 `ConfigStore`）+ `accessor.ts`（单键读取端口与 `ConfigContext`）+ `load.ts`（唯一 async 加载器）+ `runtime-config.ts`（纯内存路径/URL 归一化）+ `fields.ts`（FIELDS 表）+ `config-helpers.ts`（配置目录/env 文件/CLI 归一/`toBoolean`）+ `auth-users.ts` + `acl.ts` + `json-file-log.ts`（热加载事件 → 显式 logger）。FIELDS 表是 env 名的唯一真相源，不许在别处再建第二张表。

## 初始化流程

1. `src/index.ts`、`src/config/load.ts` 与 `src/cli.ts` 的 import 都不读取配置。`loadConfig()` 只在调用方显式调用且 await 时执行；库入口没有自动初始化、模块级配置 Map 或默认 store。
2. `src/cli.ts:main()` 是**唯一读取宿主 `process.env` / `process.argv` / `NO_COLOR` 的组合根**，且仅在 `require.main === module` 的执行路径进入。它在第一次 `await` 前分别快照 `{ ...process.env }`、`process.argv.slice(2)`、`process.cwd()` 与 `NO_COLOR`。
3. CLI 用 `defaultEnvFileNames(env.NODE_ENV)` 显式生成低→高候选：原始顺序固定为 `.env.production` → `.env.development` → `.env.<NODE_ENV>`，后者覆盖前者；重复名只保留最后一次。因此 `NODE_ENV=production` 去重后的实际读取顺序是 `.env.development` → `.env.production`（production 仍胜出）。该函数只产名字，不扫描也不读取文件。`start/start:dev/start:prod` 仅设置 `NODE_ENV`，不再用 Node `--env-file` 预注入。
4. `loadConfig({ env, envFiles, argv, cwd, store?, skipFileValidation? })` 是唯一加载器且返回 `Promise<ConfigContext>`：
   - 三类来源都完全显式；`env`/`envFiles`/`argv` 省略分别为空对象/空数组/`[]`，绝不读取 `process.env`/`process.argv` 或自动生成默认文件。
   - `cwd` 省略时才用 `process.cwd()`；`USE_HOME_CONFIG` 在读 env 文件前由 CLI > 显式 env 先决，home 模式固定 `~/.proxy`，其它模式用显式 cwd/进程 cwd；只解析路径，不创建目录。
   - `parseRawArgv()` 归一 `--key value` / `--key=value` / `KEY=VALUE`（在第一个 `=` 切分，值可含 `=`）。`resolveFieldEntries()` 按 FIELDS 解析显式值，非法值（含布尔拼写与整数越界）直接失败，绝不静默回退；布尔实现只保留 `toBoolean()` 一份。
   - `readEnvFiles()` 按调用方给出的顺序读取，后文件覆盖前文件；显式 `env` 的键始终优先。相对 env 文件路径相对最终 `configDir` 解析，绝对路径原样使用；缺失文件跳过，其它读取/解析错误拒绝。
   - 合并优先级固定为 **argv > 显式 env > env 文件（低→高）> `FIELDS.def`/`defaults`**。
   - 缺省启动校验直接异步强读 `users.json` / `acl.json`（绕过 `readJsonCached` 热加载缓存与事件），非法内容在落库前 abort；随后执行 `assertAuthConfig()` 的 auth 交叉校验。`skipFileValidation=true` 时跳过两文件读取及整段 auth 交叉校验。
   - 所有解析、范围、文件与交叉校验全部成功后，才执行**唯一一次** `store.merge(resolved)`；任一步失败都不留下半份新状态，也绝不写 `process.env`。
5. 成功后 `createConfigContext({ store, configDir, sources, warnings })` 返回 `{ store, accessor, config, configDir, sources, startupKeys, warnings }`：`store` 是 live 状态，`accessor` 只有泛型 `get`；`config` 是加载完成时复制并 `Object.freeze` 的初始快照，后续热改不改写；`sources` 只记录 `envKeys`/`argvKeys` 和绝对 `envFiles` 路径，绝不复制任何来源值。工厂只接受对象形式且 `configDir` 必填；`startupKeys` 不再是入参，固定由 `keysByPhase().startup` 生成完整集合，调用方不能删减，也不提供位置参数或 cwd 隐式回退。
6. CLI 随后严格执行 `createLogger({ config: context.accessor })` → 输出 `context.warnings` → `runServer(context, logger, noColor)`。`runServer()` 只接收已加载 context（logger 未传时才按该 accessor 新建），按 `clusterWorkers` 进入 master/单进程；`ProxyServer`、cluster 与配置日志都继续显式传同一 context/logger。

CLI cluster 的每个 fork 进程都会重新进入 CLI 组合根并独立加载自己的 `ConfigContext`；master/worker 不跨进程共享内存 store。进程级接线细则见 `src/server/AGENTS.md`。

## 加载优先级与 env 表

- **优先级**：argv > 显式 env > env 文件值（输入顺序低→高）> defaults；库调用方省略来源即空，CLI 负责把宿主快照显式传入。
- **env 键** —— 每字段恰一名（无别名），以 `FIELDS` 每行的 `env` 为准：

| Env Key             | Description |
| ------------------- | ----------- |
| `HOST`              | listen IP, default `0.0.0.0` |
| `PORT`              | listen port |
| `PROXY_PROTOCOL`    | `http`\|`https`\|`socks4`\|`socks5`\|`sockss4`\|`sockss5` |
| `PROXY_MODE`        | `server`\|`client` |
| `AUTH_ENABLED`      | `true`/`false` |
| `AUTH_TYPE`         | `none`\|`basic`\|`jwt`\|`uid` |
| `AUTH_USERS_FILE`   | path to the multi-account JSON (`[{ "username": "alice", "password": "pw1" }]`), default `<configDir>/cfg/users.json` |
| `JWT_SECRET`        | jwt credential |
| `AUTH_LOGGING`      | `true`/`false` |
| `ACL_FILE`          | path to the ACL JSON (`clientIp`/`target`/`upstream` × `whitelist`/`blacklist`), default `<configDir>/cfg/acl.json` |
| `LOG_LEVEL`         | console level: `debug`\|`info`\|`warn`\|`error`\|`silent`, default `error` |
| `LOG_FILE_LEVEL`    | file level, same values, default `info` — independent from `LOG_LEVEL` |
| `LOG_FILE`          | dir or file path → hourly JSONL `YYYY-MM-DD-HH.jsonl` |
| `CACHE_TYPE`        | `memory`\|`redis` |
| `UPSTREAM_TIMEOUT`  | ms, default 10000（同时是 cluster 停机 grace 基数，见 `src/server/AGENTS.md`） |
| `TLS_KEY` / `TLS_CERT` / `TLS_PASSPHRASE` | TLS server cert paths (only `https`/`sockss4`/`sockss5`) |
| `TLS_CA`            | client-cert CA = **mTLS switch**. Empty (default) = server-only TLS; set = client certs **required** on `https`/`sockss4`/`sockss5`, unreadable file aborts startup. No default file（机制见 `src/utils/AGENTS.md`） |
| `UPSTREAM_URL`      | **startup** `scheme://[user:pass@]host[:port]` — overrides the six endpoint fields below |
| `UPSTREAM_HOST` / `UPSTREAM_PORT` / `UPSTREAM_SECURE` / `UPSTREAM_USERNAME` / `UPSTREAM_PASSWORD` / `UPSTREAM_PROTOCOL` | **startup** endpoint fields derived/normalized with `UPSTREAM_URL`; rebuilding a runtime is required after changes |
| `UPSTREAM_CA` / `UPSTREAM_INSECURE` | runtime TLS verification overrides（路径/布尔语义见 `src/utils/AGENTS.md`） |
| `CLUSTER_WORKERS`   | 0 (=CPU cores) .. 1024 |
| `USE_HOME_CONFIG`   | `true` → `~/.proxy/` |

- **Phase**：每 `FIELDS` 行必填 `phase`。`loadConfig()` 把 startup 键名写入 `context.startupKeys`；`createProxyRuntime()` 构造时由 runtime accessor 固定这些键的启动值，随后 store 改动发布 `config.restart-required`、不改变当前实例。`UPSTREAM_URL` 与六个 endpoint 拆项（host/port/protocol/secure/username/password）都属于 startup；纯内存 runtime 修改任一项都需重建 runtime，URL 拆项覆盖 warning 仍保留。`UPSTREAM_CA/INSECURE/TIMEOUT` 等 runtime 键继续经同一 live store 每请求/每日志调用现读，发布 `config.changed`。`logConfig()` 打印初始冻结快照与 phase 清单，`keysByPhase()` 是机器可读源。
- 新增配置：`AppConfig` + `store.ts:defaults` 加字段，再在 `fields.ts:FIELDS` 加**一行**（`{ key, env, parse, phase, int?, def?, path? }`，`phase` 必填；有界整数加 `int: { min, max }`；路径字段加 `path: true`）。`src/core/types/proxy.ts:ProxyProtocol` 与 `store.ts:ProxyProtocol` 保持同步；用户可见键同步更新本文件 env 表。

## 访问控制（ACL）

三组名单同住 `ACL_FILE`（`cfg/acl.json`），一次热加载、一次校验：

```json
{
  "clientIp": { "whitelist": ["127.0.0.1", "10.0.0.0/8"], "blacklist": ["203.0.113.7"] },
  "target":   { "whitelist": ["*.example.com"], "blacklist": ["ads.example.net", "198.51.100.0/24"] },
  "upstream": { "whitelist": ["intranet.example.com"], "blacklist": ["127.0.0.1"] }
}
```

- 三组均可缺省（缺省 = 空名单，老文件无 `upstream` 键仍合法）；未知键 / 非法条目 → 默认启动校验中的 `loadConfig()` abort（`配置校验失败: ACL_FILE=<path> ...`）。仅 `ENOENT`、`ENOTDIR` 或非普通文件算文件缺失并回退不拦任何请求；其它 stat 错误不能伪装成缺失。
- `clientIp` 条目**只收 IP/CIDR**（对端永远是 IP，写域名属配置错误），按 **TCP 对端地址**（`socket.remoteAddress`）判定，**刻意不看 `X-Forwarded-For`/`X-Real-IP`**（客户端可伪造，那两个头只用于 auth 审计展示）。`::ffff:1.2.3.4` 归一化为 IPv4 再匹配（Windows/双栈必须）。
- `target` 条目收 **IP/CIDR/域名/`*.域名`**；`*.a.com` 只匹配 `a.com` 的子域、**不含 `a.com` 本身**（子域要单独写）；域名按**客户端请求的 host 字符串**匹配（小写、去尾点、剥方括号），**不做 DNS 解析**，条目**不支持端口**。所以「域名黑名单 + 客户端直接写 IP」能绕过——要两头都堵就两类条目都写。
- 语义（`clientIp`/`target` 两组一致）：黑名单命中 → **拒绝（优先）**；白名单非空且未命中 → 拒绝；皆空 → 放行。
- `upstream` 组（第三组，client 模式路由名单）**动作相反**：黑名单命中 → **直连**（优先）；白名单非空且未命中 → 直连；皆空（含整组缺失）→ 走上游。真值表：走上游 ⇔ 命中 whitelist ∧ 未命中 blacklist；**仅 `PROXY_MODE=client` 有意义**——server 模式由 `core/proxy-helpers:resolveRoute` 短路，不进判定。条目与 `target` 同形（IP/CIDR/域名/`*.域名`，kind `host`，不支持端口、不做 DNS）；判定对象同样是「客户端请求的目标」，上游地址永不进名单。命中直连的请求在 preDial 通过后打一条 info 级 `[route]` 日志（`target`/`route`/`reason`，机制见 `src/core/AGENTS.md`）。
- 被拒行为：HTTP/CONNECT/upgrade 回 **403 Forbidden**；SOCKS 在握手前直接断开（无协议应答，也不为被禁 IP 解析握手）。
- 被拒各打一条 warn：`[ip-denied]`（带 `client`/`reason`）或 `[target-denied]`（带 `target`/`host`/`reason`）。
- 判定入口：`checkClientIp(addr)`（`core/server/http.ts:handleForward()` 最先、`socks-base.ts:onConn()` 首行，均早于鉴权）、`checkTargetHost(host)`（四条转发路径 http/tunnel/websocket/socks，均在目标已解析、尚未拨号处，紧邻现有 `isSelfLoop` 守卫）与 `checkUpstreamRoute(host)`（仅 `core/proxy-helpers:resolveRoute` 调用，client 模式路由判定）。**判定顺序**：clientIp → auth → target ACL（403，永不旁路）→ 路由判定 → 拨号。**判定对象永远是「客户端请求的目标」**：absolute-form 取 request-target 的 authority（RFC 7230 §5.4），缺失时回退 `Host`；**与 `proxyMode` 无关**——client 模式下拨号目标是上游，而上游的协议/地址/端口只来自 `UPSTREAM_*`、**永不进名单**（自环守卫看的才是拨号地址；`upstream` 组命中改的是路由而非名单判定）。回归护栏见 `tests/integration/client-mode-acl.test.ts`（target 名单语义 + upstream 路由语义 + `[route]` 日志）。
- **热加载**：`cfg/acl.json` 与 `cfg/users.json` 都经 `utils/json-file.ts:readJsonCached` 做**每文件最多 1s 一次的 stat 节流**（`maxAgeMs=1000`、`maxBytes=1MiB`），缓存键严格为 `label + path`，同一路径供不同 validator 使用时不会串型；改动最多 1s 生效、**无需重启**。只有 `ENOENT`、`ENOTDIR` 或非普通文件算 missing；其它 stat 错误（如 `EACCES`）保留上一份有效值并发 `error`，不能把 ACL 静默变成全放行。相对路径进入缓存前先绝对化。读取器不持有 logger，只把状态迁移作为 `onEvent` 事件抛出（`error`/`missing`/`recovered`/`reloaded`）；事件去重状态按 **onEvent 回调**隔离，共享缓存不会吞掉其它 runtime/观察者的通知。runtime 将当前实例 logger 显式交给 `json-file-log.ts:createJsonFileEventHandler()`，再把同一 handler 注入 `auth-users.ts` 与 `acl.ts`：坏内容保留上一份有效配置（warn）、已加载文件消失（warn，ACL 静默全放行的兜底）、恢复/内容变更热加载（info）。每行带 `pid` 与可用时的 `mtimeMs`/`size`（missing 无版本字段）；cluster 各 worker 独立加载、独立记录。
- **ACL 编译缓存按 accessor 隔离**：`compiledCaches` 与文件事件 handler 都是 `WeakMap<ConfigAccessor, ...>`，每个 context/runtime accessor 各记一份编译结果；不同实例即使路径相同也不互相挤掉或串用名单。stop 时 runtime 退订 store 与 ACL 文件事件，不碰其它 accessor。
- 两个文件含密码/名单，`.gitignore` 已忽略 `cfg/users.json` / `cfg/acl.json`，仓库只提交 `cfg/users.json.example` / `cfg/acl.json.example`。

## 本目录 Gotchas

- 开发环境 `.env.development` 开启了 `uid` 鉴权且指向 `./cfg/users.json`：账号表为空会**启动即 abort**，所以首次必须先 `cp cfg/users.json.example cfg/users.json`（该文件已被 `.gitignore` 忽略，仓库只提交 `*.example`）。
- `proxyMode` `server` vs `client` 决定 `resolveRoute` 的有效模式（server 读 URL/Host 直拨；client 拨 `upstreamHost`/`upstreamPort`，但 `upstream` 路由名单命中即回落直拨真实目标）——见 `src/core/AGENTS.md`。

## 实例化配置（库模式）

配置层只有**一种状态模型**：`ConfigStore` 实例。CLI 与库模式共用同一张 `FIELDS`、同一套解析器和校验，差别只在谁来显式提供 env/argv/env 文件，以及加载结果注入 runtime 还是 server；不存在 CLI 全局 store、默认 store 或第二条 loader 路径。

### `store.ts:ConfigStore`（唯一配置状态，零 IO）

- 缺省构造以 `defaults` 为种子；`constructor(initial?: Partial<AppConfig>)` 的补丁只覆盖给出的键，`undefined` 按「未提供」跳过。每个实例自持私有 Map，实例之间不共享状态。
- `get`/`set`/`getAll`/`has`/`merge`/`onChange` 都属于实例方法；**`getAll()` 恒返回新对象**（浅拷贝），调用方 mutate 不得影响 store。
- `merge(patch)` 就地合并并返回实际变更的键（写同值 / `undefined` 不算变更）；`loadConfig()` 用它在全部校验成功后完成唯一一次落库。
- `onChange(listener)` 回调签名为 `(changed, snapshot)`，只在值真的变了时触发；退订函数幂等，单个订阅者抛错被隔离，不影响 store 与其它订阅者。store 不依赖 logger、env 或文件。
- 模块只导出类型、`defaults` 与 `ConfigStore`；**没有**模块级 config Map、`get/getAll/set`、`defaultConfigStore` 或 `globalConfigAccessor`。

### `accessor.ts:ConfigAccessor` / `ConfigContext`

- `ConfigAccessor` 是消费者的最小端口，**只有泛型 `get(key)`**：没有 `getAll`、没有 `set`，也没有隐式全局回退。`configAccessorFromStore()` 每次创建稳定、冻结且只含 `get` 的适配对象，store 后续热改会立即反映。
- `ConfigContext` 固定包含 `{ store, accessor, config, configDir, sources, startupKeys, warnings }`：`store`/`accessor` 是 live 读取面；`config` 是创建 context 时从 store 复制出的 `Readonly<AppConfig>` 初始快照并冻结；`startupKeys`/`warnings` 与来源数组也复制冻结。
- `ConfigSourceMetadata` 只含 `envKeys`、`argvKeys` 与已转绝对路径的 `envFiles`；**原始来源值不进入这份元数据**，避免密码/JWT secret 被诊断来源复制。解析后的生效值只存在于 store/accessor 与冻结的 `context.config` 快照中。
- `createConfigContext` 是唯一手工 context 工厂：对象参数只含 `store`、必填 `configDir` 及可选 `sources/warnings`；`startupKeys` 不是入参，固定取完整 `keysByPhase().startup`。工厂先 `path.resolve(configDir)`，再按绝对目录归一化 store 中所有 path 字段；纯内存 runtime 同样在构造时只捕获一次 cwd。
- runtime 的 context 模式会从传入 context 派生一个新的 accessor：startup 键读构造时快照，runtime 键继续读共享 live store；`context.store` 仍是同一个实例。facade 的直接配置入口只有 `runtime.context`，不再复制出 `runtime.config` 或 `runtime.configAccessor` 别名字段；`runtime.options.config` 只是归一化 `ProxyOptions` 中同一个 accessor 的视图。`runtime.options`、`runtime.services` 与派生 accessor 都是只读冻结视图。

### `load.ts:loadConfig(options)`（唯一 async 加载器）

```ts
loadConfig({
  env?, envFiles?, argv?, cwd?, store?, skipFileValidation?
}): Promise<ConfigContext>
```

- **显式来源**：`env`/`envFiles`/`argv` 省略分别为 `{}`/`[]`/`[]`，绝不回落 `process.env`/`process.argv`，也不会扫描 `.env.*`。`cwd` 省略才使用 `process.cwd()`；home 模式固定使用 `~/.proxy`。加载器绝不创建配置目录或写 `process.env`；显式 env/argv 中的相对 path 字段也在最终 `configDir` 下绝对化。
- **文件顺序**：`envFiles` 严格按输入顺序低→高，后文件覆盖前文件；显式 `env` 的同名键始终优先。相对路径相对最终 `configDir` 解析，绝对路径原样使用；来源元数据保留调用方给出的文件顺序与绝对路径（文件不存在也记录）。`config.loaded` 的 `sourceName` 按 `argv` > `environment` > `env-files` > `memory` 识别。
- **解析与校验**：argv/env 的显式值经 `FIELDS` 解析，非法值、整数越界、`UPSTREAM_URL` 派生/覆盖错误都在落库前处理；`UPSTREAM_URL` 是 startup 相位，`loadConfig` 与纯内存 runtime 共用同一套校验/拆项入口；覆盖拆项只进入 `context.warnings`，由 CLI 的显式 logger 呈现。默认再强读校验 users/ACL 并执行 auth 交叉校验。
- **`skipFileValidation`**：缺省 `false`。传 `true` 时完全不读取 `users.json`/`acl.json`，并跳过依赖账号数的整段 `assertAuthConfig`；调用方自行承担文件形状与鉴权组合合法性。
- **原子落库**：所有读取、解析、范围、文件与交叉校验成功后，才执行一次 `store.merge()` 并创建 context。失败时传入 store 保持原样；成功/失败都不改变宿主 env。
- `loadConfig` 是 async（env 文件与启动期 JSON 使用异步 I/O）；import 模块本身不扫描文件、不加载配置。库调用方通常传自己的 store，CLI 传快照后让加载器创建本次进程 store。

### 两种模式的分工

| 场景 | 入口 | 落点 | 宿主副作用 |
| ---- | ---- | ---- | ---- |
| CLI / 自建可执行 | `cli.main()` 快照宿主来源 → `loadConfig` → `createLogger` → `runServer(context, logger, noColor)` | 本进程独占 `ConfigStore` + `ConfigContext` | 仅 CLI 组合根读取 env/argv/cwd/NO_COLOR；加载器不写 `process.env`；server 层才安装守卫/信号/cluster |
| 库 / 嵌入第三方 | `await loadConfig({ env, envFiles, argv, cwd, store })` 或直接 `new ConfigStore(...)` | 调用方 store / runtime 私有 store | 无进程监听、无输出、无 env/argv 猜测；可完全跳过文件 IO |

### 本节 Gotchas

- **import `load.js` 绝不初始化配置**：唯一 import 护栏 `tests/unit/config-loader-import.test.ts` 先放入非法宿主 env，再动态 import `loadConfig`；import 与显式空来源调用都不得读取/污染宿主 env 或预改 store。`tests/unit/config-loader.test.ts` 另覆盖省略来源、文件顺序、优先级与原子失败。
- `ConfigStore` 零 IO：值从哪来永远由构造参数或 `loadConfig` 决定；实例化不执行 FIELDS 解析、范围、文件或 auth 交叉校验。
- `ConfigContext.config` 是**初始冻结快照**，不是 live store 的替代品；热读必须经 `context.accessor` 或 `context.store`。`tests/unit/config-instance.test.ts` 锁定 context/accessor 隔离与快照冻结。
- 无全局回归护栏：`tests/unit/config-store.test.ts` 断言模块不导出 `defaultConfigStore`；`tests/unit/config-access.test.ts` 断言两个 accessor 隔离、热改现读、`ProxyOptions.config`/auth/路由必须显式注入；`tests/unit/library-entry.test.ts` 与 `tests/library/entry.test.ts` 断言包入口没有 `get/getAll/set/globalConfigAccessor`。

## 配置预设（`preset.ts`）

- `ProxyPreset` 是 `name + Partial<AppConfig> + description`；`definePreset` 仅为类型推导与链式友好的 identity 函数，**不做运行时校验**。值域与交叉字段合法性仍由既有 `ConfigStore` / `loadConfig` 体系负责，preset 不另建校验 schema。
- `builtinPresets` 与扩展注册共用一张**静态内存 Map**；模块加载期只创建内置字面量，禁止动态 `require/import` 插件，禁止读取 env/argv/配置文件、注册进程事件或产生日志/IO。
- `applyPreset` 固定按 **base → preset → overrides** 展开，返回新 `Partial<AppConfig>`，显式 overrides 胜出；未知名称直接抛出 `Preset not found`，不静默回退。`registerPreset` 默认拒绝重名，`override: true` 才可覆盖，退订函数幂等且只移除自己的当前注册项。
- 与 `loadConfig` 的分工：`loadConfig` 负责确定 env/argv/cwd 等数据来源、执行既有解析与文件校验并落进调用方 `ConfigStore`；preset 不参与这些 IO。与 `createProxyRuntime` 的分工：构造来源二选一——传 `context` 时直接共享该 context 的 live store；或传 `config`/`preset` 纯内存组合，由 runtime 内部新建私有 `ConfigStore`。
- 回归护栏：`tests/unit/preset.test.ts` 覆盖 identity、内置清单、合并/不可变性、未知名称 fail-fast、注册覆盖与幂等退订、ConfigStore 兼容和 import 零副作用；`tests/unit/proxy-runtime.test.ts` 覆盖 preset + 显式 config 的 runtime 接线与启停。
