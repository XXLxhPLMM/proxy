# src/config — 配置加载

按**职责**分层，每层一个文件夹或一个单一职责文件；依赖严格单向，由下至上：

```
types.ts        字段契约（纯类型，零运行时值）
store.ts        唯一配置状态 ConfigStore + 默认种子 defaults（零 IO）
schema/         字段元数据与校验
sources/        外部输入 → ENV 风格键值
normalize/      配置副本的路径 / UPSTREAM_URL 归一化（纯内存）
context.ts      ConfigAccessor 只读端口 + ConfigContext 冻结快照
files/          磁盘配置资源（users.json / acl.json）+ 热加载事件日志
presets.ts      配置预设
load.ts         唯一 async 加载器（唯一做 IO 编排的入口）
index.ts        唯一对外 barrel
```

## 引用规约（硬规则）

- **跨目录只引 `@/config/index.js`**（根级入口 `src/index.ts` / `src/cli.ts` 同样走 `@/config/index.js`，它们位于 `src/` 根上，不使用 `./` 相对导入）。禁止写 `@/config/store.js`、`@/config/files/users.js` 这类深路径：目录重构时调用方必须零改动。
- **config 内部用相对路径**（`./store.js`、`../schema/fields.js`），不自我引用 barrel，避免循环依赖。
- **FIELDS 表是 env 名的唯一真相源**，不许在别处再建第二张表。新增配置：`types.ts:AppConfig` + `store.ts:defaults` 加字段，再在 `schema/fields.ts:FIELDS` 加**一行**（`{ key, env, parse, phase, int?, def?, path? }`，`phase` 必填；有界整数加 `int: { min, max }`；路径字段加 `path: true`）。`src/core/types/proxy.ts:ProxyProtocol` 与 `types.ts` 保持同步。
- **访问控制判定不在本目录**：名单数据在 `files/acl.ts`，请求期判定（`checkClientIp` / `checkTargetHost` / `checkUpstreamRoute`）在 `src/core/access-control.ts`。改名单语义动 core，改文件格式动 config。

## 分层职责

### `types.ts` — 字段契约

只有类型、零运行时值，可被任何层安全 type-only 引用。`AppConfig` 全字段 + `ConfigKey` + `AuthType` / `LogLevel` / `CacheType` + `ConfigChangeListener`。

### `store.ts` — 唯一配置状态

- `defaults` 是新建 store 的种子；`constructor(initial?)` 的补丁只覆盖给出的键，`undefined` 按「未提供」跳过。每个实例自持私有 Map，实例之间不共享状态。
- `get`/`set`/`getAll`/`has`/`merge`/`onChange` 都是实例方法；**`getAll()` 恒返回新对象**（浅拷贝），调用方 mutate 不得影响 store。
- `merge(patch)` 就地合并并返回实际变更的键（写同值 / `undefined` 不算变更）；`loadConfig()` 用它在全部校验成功后完成唯一一次落库。
- `onChange(listener)` 回调签名为 `(changed, snapshot)`，只在值真的变了时触发；退订函数幂等，单个订阅者抛错被隔离。store 不依赖 logger、env 或文件。
- 模块只导出 `defaults` 与 `ConfigStore`；**没有**模块级 config Map、`get/getAll/set`、`defaultConfigStore` 或 `globalConfigAccessor`（类型全在 `types.ts`）。

### `schema/` — 字段元数据与校验

- `parse.ts`：`parseStr` / `parseNum` / `parseEnum` / `toBoolean`。只做「一个字符串解析成什么标量」，不认识任何字段名。**布尔实现全项目只有 `toBoolean` 一份**，禁止再写第二份。
- `fields.ts`：`FieldDef` 类型 + `FIELDS` 表 + `keysByPhase()`。只描述字段，**不做校验**、**不读 env/argv/文件**（`path.join`/`defaults` 引用只是纯字面量计算）。`phase` 必填，避免"哪些改动需要重启"沦为 `get()` 调用位置的偶然产物。
- `validate.ts`：`collectIntRangeErrors`（范围）/ `resolveFieldEntries`（逐字段解析，返回 `{resolved, bad}`）/ `assertAuthConfig`（auth 交叉组合，fail-closed）。全部纯函数。
- `index.ts` 是本层出口，`loadConfig` 与 `server/log/config-log` 从这里取。

### `sources/` — 外部输入

- `config-dir.ts`：`HOME_CONFIG_KEY` + `getConfigDir(useHome, cwd?)`。必须在读 env 文件**之前**确定（相对路径与各 path 字段默认值都以它为锚）；只解析路径、绝不创建目录。
- `env-files.ts`：`defaultEnvFileNames(nodeEnv?)` 只**产名字**不扫描不读取；`readEnvFiles(files, baseEnv)` 按输入顺序读，后文件覆盖前文件，显式 `baseEnv` 的键恒优先，缺失跳过、其它错误抛出。**绝不写宿主环境**。
- `argv.ts`：`parseRawArgv(argv)` 归一 `--key value` / `--key=value` / `KEY=VALUE`（在第一个 `=` 切分，值可含 `=`）。纯字符串处理，不读 `process.argv`。
- 全部函数要求**显式入参**，没有任何一个去读 `process.env` / `process.argv`。

### `normalize/` — 归一化（纯内存）

- `record.ts`：把泛型配置对象收窄成可按 `ConfigKey` 索引的 record（层内共享，避免各写各的强转）。
- `paths.ts`：`resolveConfigPaths(config, configDir)` 按 `FIELDS.path` 把相对路径绝对化。空串保留、绝对路径原样、只在副本上写。
- `upstream.ts`：`applyUpstreamUrlToConfig(target, raw, explicitlyProvided?)` 是 **UPSTREAM_URL 拆项的唯一实现**，返回「显式拆项被覆盖」的 warning 列表。先 parse 再触碰 target，非法 URL 不会部分改写。
- `prepare.ts`：`prepareRuntimeConfig`（纯内存副本）/ `prepareRuntimeConfigStore`（只把真正变化的字段 merge 回 store，先在副本上校验，失败不半写）。
- `loadConfig` 与纯内存 runtime 共用这一套实现，两条路径永不对同一 URL 得出不同结果。

### `context.ts` — 读取端口与上下文

- `ConfigAccessor` 是消费者的最小端口，**只有泛型 `get`**：没有 `getAll`、没有 `set`，也没有隐式全局回退。`configAccessorFromStore()` 每次创建稳定、冻结且只含 `get` 的适配对象，store 后续热改立即反映。
- `ConfigContext` 固定含 `{ store, accessor, config, configDir, sources, startupKeys, warnings }`：`store`/`accessor` 是 live 读取面；`config` 是创建时复制并 `Object.freeze` 的初始快照；`startupKeys`/`warnings` 与来源数组也冻结。
- `ConfigSourceMetadata` 只含 `envKeys`、`argvKeys` 与已转绝对路径的 `envFiles`；**原始来源值不进入元数据**，避免密码/JWT secret 被诊断来源复制。
- `createConfigContext` 是唯一手工 context 工厂：对象参数只含 `store`、必填 `configDir` 及可选 `sources/warnings`；`startupKeys` 不是入参，固定取完整 `keysByPhase().startup`。工厂先 `path.resolve(configDir)`，再按绝对目录归一化 store 中所有 path 字段。

### `files/` — 磁盘配置资源

- `users.ts`：`AuthAccount` + `validateAuthUsers`（形状校验）+ `readAuthUsersAsync`（启动期 fail-cedure 强校验，绕过热加载缓存与事件）+ `readAuthUsers` / `loadAuthUsers`（同步热加载面，`opts.config` 必填）。
- `acl.ts`：`AclList` / `AclConfig` + `validateAcl` + `readAclAsync` + `readAcl` / `loadAcl`。**只管拿数据，不做判定**。
- `event-log.ts`：`createJsonFileEventHandler(logger)` / `logJsonFileEvent`，把 `readJsonCached` 的 `error`/`missing`/`recovered`/`reloaded` 渲染成日志。本模块**不持有任何 logger 单例**，logger 由调用方显式注入。
- 两个文件的读取都经 `utils/json-file/index.ts:readJsonCached` 做每文件最多 1s 一次的 stat 节流（`maxBytes=1MiB`），缓存键严格为 `label + path`。

### `presets.ts` — 配置预设

- `ProxyPreset` 是 `name + Partial<AppConfig> + description`；`definePreset` 仅为类型推导与链式友好的 identity 函数，**不做运行时校验**。值域与交叉字段合法性仍由 `ConfigStore` / `loadConfig` 负责。
- `builtinPresets` 与扩展注册共用一张**静态内存 Map**（本目录唯一的模块级可变状态）；模块加载期只创建内置字面量，禁止动态 `require/import` 插件、读 env/argv/文件、注册进程事件或产生日志/IO。
- `applyPreset` 固定按 **base → preset → overrides** 展开，返回新 `Partial<AppConfig>`；未知名称直接抛 `Preset not found`。`registerPreset` 默认拒绝重名，`override: true` 才可覆盖，退订函数幂等且只移除自己的当前注册项。

### `load.ts` — 唯一 async 加载器

```ts
loadConfig({ env?, envFiles?, argv?, cwd?, store?, skipFileValidation? }): Promise<ConfigContext>
```

- **import 期零副作用**：不读宿主 env/argv，不扫描文件，不写宿主环境。模块加载本身不初始化配置。
- **三类来源完全显式**：`env`/`envFiles`/`argv` 省略分别为 `{}`/`[]`/`[]`，绝不回落 `process.env`/`process.argv`，也不会扫描 `.env.*`。`cwd` 省略才用 `process.cwd()`；`USE_HOME_CONFIG` 在读 env 文件前由 CLI > 显式 env 先决，home 模式固定 `~/.proxy`。加载器绝不创建配置目录。
- **编排顺序**（每步只操作局部副本）：`sources/`（argv 归一 → 定 configDir → 读 env 文件）→ `schema/`（逐字段解析 → 补 def/defaults → 范围校验）→ `normalize/`（路径绝对化 → UPSTREAM_URL 拆项，只收集 warning）→ `files/`（users/acl 启动期强校验 + auth 交叉校验）→ **唯一一次** `store.merge()` + `createConfigContext()`。
- **原子落库**：所有读取、解析、范围、文件与交叉校验全部成功后才 merge。失败时传入 store 保持原样，绝不产生半份状态。
- **`skipFileValidation`**：缺省 `false`。传 `true` 时完全不读 `users.json`/`acl.json`，并跳过依赖账号数的整段 `assertAuthConfig`；调用方自行承担文件形状与鉴权组合合法性。
- 相对 env 文件路径相对最终 `configDir` 解析，绝对路径原样；来源元数据保留调用方给出的文件顺序与绝对路径（文件不存在也记录）。`config.loaded` 的 `sourceName` 按 `argv` > `environment` > `env-files` > `memory` 识别。

## 初始化流程（CLI 路径）

1. `src/index.ts`、`src/config/load.ts` 与 `src/cli.ts` 的 import 都不读取配置。
2. `src/cli.ts:main()` 是**唯一读取宿主 `process.env` / `process.argv` / `NO_COLOR` 的组合根**，且仅在 `require.main === module` 的执行路径进入。它在第一次 `await` 前分别快照 `{ ...process.env }`、`process.argv.slice(2)`、`process.cwd()` 与 `NO_COLOR`。
3. CLI 用 `defaultEnvFileNames(env.NODE_ENV)` 显式生成低→高候选：原始顺序固定为 `.env.production` → `.env.development` → `.env.<NODE_ENV>`，后者覆盖前者；重复名只保留最后一次。因此 `NODE_ENV=production` 去重后的实际读取顺序是 `.env.development` → `.env.production`（production 仍胜出）。该函数只产名字，不扫描也不读取文件。`start/start:dev/start:prod` 仅设置 `NODE_ENV`，不再用 Node `--env-file` 预注入。
4. `loadConfig` 返回 context 后，CLI 严格执行 `createLogger({ config: context.accessor })` → 输出 `context.warnings` → `runServer(context, logger, noColor)`。
5. CLI cluster 的每个 fork 进程都会重新进入 CLI 组合根并独立加载自己的 `ConfigContext`；master/worker 不跨进程共享内存 store。进程级接线细则见 `src/server/AGENTS.md`。

## 加载优先级与 env 表

- **优先级**：argv > 显式 env > env 文件值（输入顺序低→高）> `FIELDS.def`/`defaults`；库调用方省略来源即空，CLI 负责把宿主快照显式传入。
- **env 键** —— 每字段恰一名（无别名），以 `schema/fields.ts:FIELDS` 每行的 `env` 为准：

| Env Key                                                                                                                 | Description                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                                                                                                                  | listen IP, default `0.0.0.0`                                                                                                                                                                                         |
| `PORT`                                                                                                                  | listen port                                                                                                                                                                                                          |
| `PROXY_PROTOCOL`                                                                                                        | `http`\|`https`\|`socks4`\|`socks5`\|`sockss4`\|`sockss5`                                                                                                                                                            |
| `PROXY_MODE`                                                                                                            | `server`\|`client`                                                                                                                                                                                                   |
| `AUTH_ENABLED`                                                                                                          | `true`/`false`                                                                                                                                                                                                       |
| `AUTH_TYPE`                                                                                                             | `none`\|`basic`\|`jwt`\|`uid`                                                                                                                                                                                        |
| `AUTH_USERS_FILE`                                                                                                       | path to the multi-account JSON (`[{ "username": "alice", "password": "pw1" }]`), default `<configDir>/cfg/users.json`                                                                                                |
| `JWT_SECRET`                                                                                                            | jwt credential                                                                                                                                                                                                       |
| `AUTH_LOGGING`                                                                                                          | `true`/`false`                                                                                                                                                                                                       |
| `ACL_FILE`                                                                                                              | path to the ACL JSON (`clientIp`/`target`/`upstream` × `whitelist`/`blacklist`), default `<configDir>/cfg/acl.json`                                                                                                  |
| `LOG_LEVEL`                                                                                                             | console level: `debug`\|`info`\|`warn`\|`error`\|`silent`, default `error`                                                                                                                                           |
| `LOG_FILE_LEVEL`                                                                                                        | file level, same values, default `info` — independent from `LOG_LEVEL`                                                                                                                                               |
| `LOG_FILE`                                                                                                              | dir or file path → hourly JSONL `YYYY-MM-DD-HH.jsonl`                                                                                                                                                                |
| `CACHE_TYPE`                                                                                                            | `memory`\|`redis`                                                                                                                                                                                                    |
| `UPSTREAM_TIMEOUT`                                                                                                      | ms, default 10000（同时是 cluster 停机 grace 基数，见 `src/server/AGENTS.md`）                                                                                                                                       |
| `TLS_KEY` / `TLS_CERT` / `TLS_PASSPHRASE`                                                                               | TLS server cert paths (only `https`/`sockss4`/`sockss5`)                                                                                                                                                             |
| `TLS_CA`                                                                                                                | client-cert CA = **mTLS switch**. Empty (default) = server-only TLS; set = client certs **required** on `https`/`sockss4`/`sockss5`, unreadable file aborts startup. No default file（机制见 `src/utils/AGENTS.md`） |
| `UPSTREAM_URL`                                                                                                          | **startup** `scheme://[user:pass@]host[:port]` — overrides the six endpoint fields below                                                                                                                             |
| `UPSTREAM_HOST` / `UPSTREAM_PORT` / `UPSTREAM_SECURE` / `UPSTREAM_USERNAME` / `UPSTREAM_PASSWORD` / `UPSTREAM_PROTOCOL` | **startup** endpoint fields derived/normalized with `UPSTREAM_URL`; rebuilding a runtime is required after changes                                                                                                   |
| `UPSTREAM_CA` / `UPSTREAM_INSECURE`                                                                                     | runtime TLS verification overrides（路径/布尔语义见 `src/utils/AGENTS.md`）                                                                                                                                          |
| `CLUSTER_WORKERS`                                                                                                       | 0 (=CPU cores) .. 1024                                                                                                                                                                                               |
| `USE_HOME_CONFIG`                                                                                                       | `true` → `~/.proxy/`                                                                                                                                                                                                 |

- **Phase**：每 `FIELDS` 行必填 `phase`。`loadConfig()` 把 startup 键名写入 `context.startupKeys`；`createProxyRuntime()` 构造时由 runtime accessor 固定这些键的启动值，随后 store 改动发布 `config.restart-required`、不改变当前实例。`UPSTREAM_URL` 与六个 endpoint 拆项都属于 startup；纯内存 runtime 修改任一项都需重建 runtime，URL 拆项覆盖 warning 仍保留。`UPSTREAM_CA/INSECURE/TIMEOUT` 等 runtime 键继续经同一 live store 每请求/每日志调用现读，发布 `config.changed`。`logConfig()` 打印初始冻结快照与 phase 清单，`keysByPhase()` 是机器可读源。

## 访问控制（ACL）

三组名单同住 `ACL_FILE`（`cfg/acl.json`），一次热加载、一次校验：

```json
{
  "clientIp": { "whitelist": ["127.0.0.1", "10.0.0.0/8"], "blacklist": ["203.0.113.7"] },
  "target": { "whitelist": ["*.example.com"], "blacklist": ["ads.example.net", "198.51.100.0/24"] },
  "upstream": { "whitelist": ["intranet.example.com"], "blacklist": ["127.0.0.1"] }
}
```

- 三组均可缺省（缺省 = 空名单，老文件无 `upstream` 键仍合法）；未知键 / 非法条目 → 默认启动校验中的 `loadConfig()` abort（`配置校验失败: ACL_FILE=<path> ...`）。仅 `ENOENT`、`ENOTDIR` 或非普通文件算文件缺失并回退不拦任何请求；其它 stat 错误不能伪装成缺失。
- `clientIp` 条目**只收 IP/CIDR**（对端永远是 IP，写域名属配置错误），按 **TCP 对端地址**（`socket.remoteAddress`）判定，**刻意不看 `X-Forwarded-For`/`X-Real-IP`**（客户端可伪造，那两个头只用于 auth 审计展示）。`::ffff:1.2.3.4` 归一化为 IPv4 再匹配（Windows/双栈必须）。
- `target` 条目收 **IP/CIDR/域名/`*.域名`**；`*.a.com` 只匹配 `a.com` 的子域、**不含 `a.com` 本身**（子域要单独写）；域名按**客户端请求的 host 字符串**匹配（小写、去尾点、剥方括号），**不做 DNS 解析**，条目**不支持端口**。所以「域名黑名单 + 客户端直接写 IP」能绕过——要两头都堵就两类条目都写。
- 语义（`clientIp`/`target` 两组一致）：黑名单命中 → **拒绝（优先）**；白名单非空且未命中 → 拒绝；皆空 → 放行。
- `upstream` 组（第三组，client 模式路由名单）**动作相反**：黑名单命中 → **直连**（优先）；白名单非空且未命中 → 直连；皆空（含整组缺失）→ 走上游。真值表：走上游 ⇔ 命中 whitelist ∧ 未命中 blacklist；**仅 `PROXY_MODE=client` 有意义**——server 模式由 `core/proxy-helpers:resolveRoute` 短路，不进判定。条目与 `target` 同形，判定对象同样是「客户端请求的目标」，上游地址永不进名单。命中直连的请求在 preDial 通过后打一条 info 级 `[route]` 日志（`target`/`route`/`reason`，机制见 `src/core/AGENTS.md`）。
- 被拒行为：HTTP/CONNECT/upgrade 回 **403 Forbidden**；SOCKS 在握手前直接断开（无协议应答，也不为被禁 IP 解析握手）。
- 被拒各打一条 warn：`[ip-denied]`（带 `client`/`reason`）或 `[target-denied]`（带 `target`/`host`/`reason`）。
- 判定入口全部在 `src/core/access-control.ts`：`checkClientIp(addr)`（`core/server/http.ts:handleForward()` 最先、`socks-base.ts:onConn()` 首行，均早于鉴权）、`checkTargetHost(host)`（四条转发路径 http/tunnel/websocket/socks，均在目标已解析、尚未拨号处，紧邻现有 `isSelfLoop` 守卫）与 `checkUpstreamRoute(host)`（仅 `core/proxy-helpers:resolveRoute` 调用，client 模式路由判定）。**判定顺序**：clientIp → auth → target ACL（403，永不旁路）→ 路由判定 → 拨号。**判定对象永远是「客户端请求的目标」**：absolute-form 取 request-target 的 authority（RFC 7230 §5.4），缺失时回退 `Host`；**与 `proxyMode` 无关**——client 模式下拨号目标是上游，而上游的协议/地址/端口只来自 `UPSTREAM_*`、**永不进名单**。回归护栏见 `tests/integration/client-mode-acl.test.ts`。
- **热加载**：`cfg/acl.json` 与 `cfg/users.json` 都经 `utils/json-file/index.ts:readJsonCached` 做**每文件最多 1s 一次的 stat 节流**（`maxAgeMs=1000`、`maxBytes=1MiB`），缓存键严格为 `label + path`；改动最多 1s 生效、**无需重启**。只有 `ENOENT`、`ENOTDIR` 或非普通文件算 missing；其它 stat 错误（如 `EACCES`）保留上一份有效值并发 `error`，不能把 ACL 静默变成全放行。相对路径进入缓存前先绝对化。读取器不持有 logger，只把状态迁移作为 `onEvent` 事件抛出；事件去重状态按 **onEvent 回调**隔离。runtime 将当前实例 logger 显式交给 `files/event-log.ts:createJsonFileEventHandler()`，再把同一 handler 注入 `core/access-control.ts:bindAclFileEvents` 与 `auth-users` 读取面：坏内容保留上一份有效配置（warn）、已加载文件消失（warn）、恢复/内容变更热加载（info）。每行带 `pid` 与可用时的 `mtimeMs`/`size`（missing 无版本字段）；cluster 各 worker 独立加载、独立记录。
- **ACL 编译缓存按 accessor 隔离**：`core/access-control.ts` 的 `compiledCaches` 与 `fileEventHandlers` 都是 `WeakMap<ConfigAccessor, ...>`，每个 context/runtime accessor 各记一份编译结果；不同实例即使路径相同也不互相挤掉或串用名单。stop 时 runtime 退订 store 与 ACL 文件事件，不碰其它 accessor。
- 两个文件含密码/名单，`.gitignore` 已忽略 `cfg/users.json` / `cfg/acl.json`，仓库只提交 `cfg/users.json.example` / `cfg/acl.json.example`。

## 两种模式的分工

| 场景             | 入口                                                                                              | 落点                                       | 宿主副作用                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| CLI / 自建可执行 | `cli.main()` 快照宿主来源 → `loadConfig` → `createLogger` → `runServer(context, logger, noColor)` | 本进程独占 `ConfigStore` + `ConfigContext` | 仅 CLI 组合根读取 env/argv/cwd/NO_COLOR；加载器不写 `process.env`；server 层才安装守卫/信号/cluster |
| 库 / 嵌入第三方  | `await loadConfig({ env, envFiles, argv, cwd, store })` 或直接 `new ConfigStore(...)`             | 调用方 store / runtime 私有 store          | 无进程监听、无输出、无 env/argv 猜测；可完全跳过文件 IO                                             |

## 本目录 Gotchas

- **import `load.js` 绝不初始化配置**：唯一 import 护栏 `tests/unit/config-loader-import.test.ts` 先放入非法宿主 env，再动态 import `loadConfig`；import 与显式空来源调用都不得读取/污染宿主 env 或预改 store。`tests/unit/config-loader.test.ts` 另覆盖省略来源、文件顺序、优先级、argv 三种写法与原子失败。
- **无第二套 argv 解析入口**：argv 只有 `sources/argv.ts:parseRawArgv` 一处实现，`loadConfig` 是唯一把它变成配置的入口。历史上的 `parseStartupArgs()` 已删除（生产零调用，纯重复的第二入口），argv 归一与字段解析的回归护栏改为经 `loadConfig` 断言。
- **`ConfigStore` 零 IO**：值从哪来永远由构造参数或 `loadConfig` 决定；实例化不执行 FIELDS 解析、范围、文件或 auth 交叉校验。
- **`ConfigContext.config` 是初始冻结快照**，不是 live store 的替代品；热读必须经 `context.accessor` 或 `context.store`。
- 开发环境 `.env.development` 开启了 `uid` 鉴权且指向 `./cfg/users.json`：账号表为空会**启动即 abort**，所以首次必须先 `cp cfg/users.json.example cfg/users.json`（该文件已被 `.gitignore` 忽略，仓库只提交 `*.example`）。
- `proxyMode` `server` vs `client` 决定 `resolveRoute` 的有效模式（server 读 URL/Host 直拨；client 拨 `upstreamHost`/`upstreamPort`，但 `upstream` 路由名单命中即回落直拨真实目标）——见 `src/core/AGENTS.md`。
- 无全局回归护栏：`tests/unit/config-store.test.ts` 断言模块不导出 `defaultConfigStore`；`tests/unit/config-access.test.ts` 断言两个 accessor 隔离、热改现读、`ProxyOptions.config`/auth/路由必须显式注入；`tests/unit/config-instance.test.ts` 锁定 context/accessor 隔离与快照冻结；`tests/unit/library-entry.test.ts` 与 `tests/library/entry.test.ts` 断言包入口没有 `get/getAll/set/globalConfigAccessor`。
