# src/config — 配置加载

`store.ts`（零 IO 的 Map 单例）+ `fields.ts`（FIELDS 表）+ `loader.ts`（表驱动初始化）+ `config-helpers.ts`（CLI 归一/`.env` 读取/`toBoolean`）+ `auth-users.ts` + `acl.ts` + `json-file-log.ts`（热加载事件 → notice 日志）。FIELDS 表是 env 名的唯一真相源，不许在别处再建第二张表。

## 初始化流程

1. `src/cli.ts` 仅在 `require.main === module` 时调用 `runServer()`；import CLI 模块本身不初始化配置。
2. `runServer()` 显式动态 import `config/loader.ts` 并调用 `initConfig()`；这一步才允许读取 `process.argv`、`process.env` 与 `.env` 文件并写 CLI 全局 store。
3. `store.ts` 单例 `Map<ConfigKey, AppConfig[ConfigKey]>`，由 `defaults` 做种子。
4. `loader.ts:initConfig()`（显式调用、幂等、表驱动）：
   - `useHomeConfig` 先决（CLI > env），决定配置目录（`~/.proxy` vs `cwd`）。
   - `loadEnvFiles()`：低→高 `.env.production` → `.env.development` → `.env.<NODE_ENV>`（去重保留后者），`dotenv.parse` 后写 `process.env` —— **终端已设变量永不覆盖**（后文件仍胜过前文件）。
   - `parseRawArgv()` 归一 `--key value` / `--key=value` / `KEY=VALUE`（两种 `=` 形态都在**第一个** `=` 处切分，值可含 `=`）。显式给的值解析失败即 abort 启动 —— CLI 与 env 一视同仁，永不静默回退（布尔拼写错误也一样，`AUTH_ENABLED=treu` 会报错而不是悄悄变 `false`）。
   - FIELDS 解析循环是共享的：`fields.ts:resolveFieldEntries(source)` 返回 `{ resolved, bad }`；`initConfig()` 喂 CLI>env 再补 `def`/`defaults` 回退，`parseStartupArgs()` 喂解析后的 argv（仅显式键）——各自保留 range 检查 + 抛错。布尔解析只活在 `config-helpers.ts:toBoolean`（`fields.ts` 的 `parse: toBoolean` 行与早期 `USE_HOME_CONFIG` 查找共用）——不许本地复制。
   - 整数范围由 `FieldDef.int` 逐字段声明，解析后统一过 `collectIntRangeErrors()`（`port`/`upstreamPort` 1-65535，`upstreamTimeout` >=1，`clusterWorkers` 0-1024）——`parseStartupArgs()` 跑同一检查，不另建校验 schema。
   - 两个可热加载 JSON（`cfg/users.json` / `cfg/acl.json`）在写 store 前强制读 + 校验：`initConfig()` 调 `readAuthUsers({ force, path })` / `readAcl({ force, path })`（显式传 path，因 store 里还是旧默认值）——非法内容 abort（`配置校验失败: AUTH_USERS_FILE=<path> ...` / `ACL_FILE=<path> ...`）。store 里只存**路径**；解析值住在 `json-file` 缓存层，保持热加载。
   - 跨字段守卫 `assertAuthConfig({ authEnabled, authType, accountCount, jwtSecret })`：`authEnabled && (basic|uid) && accountCount === 0` 即 abort（指向 `AUTH_USERS_FILE`；空账号表否则是静默“全拒绝”）。
   - `_inited` 只在全部检查通过且 store 写完后翻 `true` —— 初始化失败会重抛而不是静默返回默认值。
5. 初始化完成后，`runServer()` 按 `clusterWorkers>1` 决定 fork master 或直接 `new ProxyServer().start()`。
6. `ProxyServer.start()` → `setupProcessGuards()` → 打掩码配置 → 创建 runtime → `runtime.start()`。

库入口 `src/index.ts` 的任何 import（包括 `loader.ts` 本身）都不会调用 `initConfig()`；此时全局 `get()` 仍是 defaults，库调用方只应使用私有 `ConfigStore` / 显式 `loadConfig()`。CLI 构建入口仍是 `src/cli.ts`。

## 加载优先级与 env 表

- **优先级**：CLI args > 终端 env > env 文件值 > defaults。
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
| `UPSTREAM_URL`      | `scheme://[user:pass@]host[:port]` — overrides granular upstream fields |
| `UPSTREAM_HOST` / `UPSTREAM_PORT` / `UPSTREAM_SECURE` / `UPSTREAM_USERNAME` / `UPSTREAM_PASSWORD` / `UPSTREAM_CA` / `UPSTREAM_INSECURE` / `UPSTREAM_PROTOCOL` | granular upstream（`UPSTREAM_CA` 语义见 `src/utils/AGENTS.md`） |
| `CLUSTER_WORKERS`   | 0 (=CPU cores) .. 1024 |
| `USE_HOME_CONFIG`   | `true` → `~/.proxy/` |

- **Phase**：每 `FIELDS` 行必填 `phase`。`startup` 键只在 `ProxyServer.start()` 读一次进 `ProxyOptions`（`proxyProtocol`/`host`/`port`/`tls*`/`clusterWorkers`）或只影响启动期解析（`useHomeConfig`）——改了要重启进程；`runtime` 键每请求/每日志调用重读，可经 `set()` 热改。`logConfig()` 启动时打印 startup 清单，`keysByPhase()` 是机器可读源。
- 新增配置：`AppConfig` + `store.ts:defaults` 加字段，再在 `fields.ts:FIELDS` 加**一行**（`{ key, env, parse, phase, int?, def? }`，`phase` 必填；有界整数加 `int: { min, max }`）。`src/core/types/proxy.ts:ProxyProtocol` 与 `store.ts:ProxyProtocol` 保持同步；用户可见键同步更新本文件 env 表。

## 访问控制（ACL）

三组名单同住 `ACL_FILE`（`cfg/acl.json`），一次热加载、一次校验：

```json
{
  "clientIp": { "whitelist": ["127.0.0.1", "10.0.0.0/8"], "blacklist": ["203.0.113.7"] },
  "target":   { "whitelist": ["*.example.com"], "blacklist": ["ads.example.net", "198.51.100.0/24"] },
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
- 判定入口：`checkClientIp(addr)`（`core/server/http.ts:handleForward()` 最先、`socks-base.ts:onConn()` 首行，均早于鉴权）、`checkTargetHost(host)`（四条转发路径 http/tunnel/websocket/socks，均在目标已解析、尚未拨号处，紧邻现有 `isSelfLoop` 守卫）与 `checkUpstreamRoute(host)`（仅 `core/proxy-helpers:resolveRoute` 调用，client 模式路由判定）。**判定顺序**：clientIp → auth → target ACL（403，永不旁路）→ 路由判定 → 拨号。**判定对象永远是「客户端请求的目标」**：absolute-form 取 request-target 的 authority（RFC 7230 §5.4），缺失时回退 `Host`；**与 `proxyMode` 无关**——client 模式下拨号目标是上游，而上游的协议/地址/端口只来自 `UPSTREAM_*`、**永不进名单**（自环守卫看的才是拨号地址；`upstream` 组命中改的是路由而非名单判定）。回归护栏见 `tests/integration/client-mode-acl.test.ts`（target 名单语义 + upstream 路由语义 + `[route]` 日志）。
- **热加载**：`cfg/acl.json` 与 `cfg/users.json` 都经 `utils/json-file.ts:readJsonCached` 做**每文件最多 1s 一次的 stat 节流**（`maxAgeMs=1000`、`maxBytes=1MiB`），改动最多 1s 生效、**无需重启**。`readJsonCached` 不记日志，只把状态迁移作为 `onEvent` 事件抛出（`error`/`missing`/`recovered`/`reloaded`，变化才触发）；`acl.ts`/`auth-users.ts` 统一挂 `json-file-log.ts:logJsonFileEvent` 落 `notice`：坏内容保留上一份有效配置（warn，不接管坏数据）、已加载文件消失（warn，ACL 静默全放行的兜底）、恢复/内容变更热加载（info）——默认 error 级控制台可见，`LOG_LEVEL=silent` 下静音。每行带结构化字段 `pid`（cluster 下每个 worker 各自热加载、各打一行，不做去重/聚合，凭 pid 区分进程）与 `mtimeMs`/`size`（版本标识，区分「同版本被 N 进程加载」与「文件被多次修改」；missing 事件无）。
- 两个文件含密码/名单，`.gitignore` 已忽略 `cfg/users.json` / `cfg/acl.json`，仓库只提交 `cfg/users.json.example` / `cfg/acl.json.example`。

## 本目录 Gotchas

- 开发环境 `.env.development` 开启了 `uid` 鉴权且指向 `./cfg/users.json`：账号表为空会**启动即 abort**，所以首次必须先 `cp cfg/users.json.example cfg/users.json`（该文件已被 `.gitignore` 忽略，仓库只提交 `*.example`）。
- `proxyMode` `server` vs `client` 决定 `resolveRoute` 的有效模式（server 读 URL/Host 直拨；client 拨 `upstreamHost`/`upstreamPort`，但 `upstream` 路由名单命中即回落直拨真实目标）——见 `src/core/AGENTS.md`。

## 实例化配置（库模式）

配置层有**两套并存**的入口：CLI 模式走全局单例，库模式走显式实例。二者共用同一张 `FIELDS` 表、同一套解析器与校验，绝不另立 env 表 / 布尔解析 / 校验 schema。

### `store.ts:ConfigStore`（纯增量，不替代全局单例）

- 缺省构造以 `defaults` 为种子（与全局 `config` Map 起点一致），`constructor(initial?: Partial<AppConfig>)` 的补丁只覆盖给出的键，`undefined` 项按「未提供」跳过。
- `get`/`set`/`getAll`/`has`/`merge`/`onChange` 语义与全局 `get`/`set`/`getAll` 同源；**`getAll()` 恒返回新对象**（浅拷贝），调用方 mutate 不得影响 store。
- `merge(patch)` 就地合并并**返回实际变更的键**（写同值 / `undefined` 不算变更），`loadConfig` 用它落库。
- `onChange(listener)` 回调签名 `(changed: readonly ConfigKey[], snapshot: Readonly<AppConfig>) => void`，**只在值真的变了时触发**（写同值不触发），退订函数幂等；单个订阅者抛错被吞（store 刻意零依赖：`utils/logger` 反向依赖 `get()`，引入即成环），不影响 store 与其它订阅者。
- `export const defaultConfigStore = new ConfigStore()`：模块级便利实例。**刻意不与全局 `config` 共享任何状态**，`loadConfig` 写它不影响 `get()`。
- 现有 `config`/`get`/`set`/`getAll` 仍是裸 Map 实现，**未**转发到任何实例（转发是后续波次的事；现在动会让 ~15 个 src 文件 + 30+ 测试的全局读值路径承担行为漂移风险）。

### `load.ts:loadConfig(options)`（显式加载，绝不碰全局单例）

```ts
loadConfig({ env?, argv?, cwd?, store?, writeProcessEnv?, skipFileValidation? })
  => { store, configDir, startupKeys }
```

- **不碰全局 `config` Map**：解析结果只落进 `options.store`（缺省新建 `ConfigStore`），`get()`/`set()` 读到的仍是 CLI 那份配置；多份配置可在同一进程并存。
- **`writeProcessEnv`**：缺省 `true`（保持 CLI 现状，会把 `.env` 文件值写进 `process.env`）；**库调用方必须传 `false`**，此时 env 文件值只参与本次解析，一个字节都不写 `process.env`。
- **数据源优先级**与 CLI 完全一致：CLI argv > env 源（`options.env`，缺省 `process.env`）> `.env` 文件（`cwd` 下低→高）> `def`/`defaults`。env 文件候选名与覆盖顺序仍由 `config-helpers.ts:readEnvFileOverrides` 一处实现（`loadEnvFiles` 也已改为复用它，行为不变）。
- **`cwd`**：显式给出即配置目录根（路径类字段的默认值据此解析成绝对路径），此时**不代建目录、不再按 `useHomeConfig` 推导**（目录归调用方）；缺省才沿用 `~/.proxy` vs `process.cwd()` 的现有推导并按需建目录。
- **非法值一律抛错**，错误文案与 `initConfig` 同风格（`配置校验失败: PORT=70000 越界` / `AUTH_ENABLED=treu 非法` / `AUTH_USERS_FILE=<path> ...` / `账号表为空`），绝不静默回退默认值；**校验全部通过才落库**，失败不留半份配置。
- **`skipFileValidation`**：缺省 `false`（保持现有 fail-fast，强读 + 强校验 `users.json`/`acl.json`）。传 `true` 时**完全不碰这两个文件**，并**连带跳过 `assertAuthConfig`**——它的 `accountCount` 分支只能来自账号文件，skip 的语义是「不读文件」，凑一个假的账号数去跑断言属于撒谎；此时鉴权组合合法性由调用方自行保证。
- `loader.ts:initConfig()` 只在 `runServer()` 等进程级入口**显式调用**时执行；import loader/CLI 只定义函数，绝不读配置。它保持「幂等、失败重抛」，成功才写全局 Map。

### 两种模式的分工

| 场景 | 入口 | 落点 | 副作用 |
| ---- | ---- | ---- | ---- |
| CLI / 自建可执行 | 显式调用 `runServer()` → `initConfig()` | 全局 `config` Map（`get`/`set`） | 读终端 env + `.env` 文件并写 `process.env`；初始化抛错即启动中止 |
| 库 / 嵌入第三方 | `loadConfig({ env, argv, cwd, writeProcessEnv: false, store })` | 调用方的 `ConfigStore` | 只读文件（可全关），默认不改 `process.env`、不碰全局单例 |

### 本节 Gotchas

- **import `loader.js` / `cli.js` 绝不初始化配置**：模块加载只定义 `initConfig` / 进程入口；只有显式调用 `runServer()` 才进入 CLI 加载路径。回归护栏 `tests/unit/config-loader-import.test.ts` 会先放入非法 env，再 import 两者；任何偷偷调用 `initConfig()` 都会直接让测试失败。
- `ConfigStore` 零 IO：它不读 `process.env`、不读 env 文件、不校验值域。**「值从哪来」永远由调用方决定**（构造参数 / `loadConfig`）；`loadConfig` 才是那个跑 `resolveFieldEntries` + 越界 + 文件 + auth 交叉校验的入口。
- 回归护栏：`tests/unit/config-instance.test.ts`（实例隔离、`getAll` 拷贝、`onChange` 语义、`process.env`/全局单例不被污染、非法值仍抛错）+ `tests/unit/config-store.test.ts` 与 `tests/unit/config-loader.test.ts` 末尾追加的实例/显式加载用例。改 `ConfigStore` 或 `loadConfig` 必须跑这三个文件。

## 配置预设（`preset.ts`）

- `ProxyPreset` 是 `name + Partial<AppConfig> + description`；`definePreset` 仅为类型推导与链式友好的 identity 函数，**不做运行时校验**。值域与交叉字段合法性仍由既有 `ConfigStore` / `loadConfig` 体系负责，preset 不另建校验 schema。
- `builtinPresets` 与扩展注册共用一张**静态内存 Map**；模块加载期只创建内置字面量，禁止动态 `require/import` 插件，禁止读取 env/argv/配置文件、注册进程事件或产生日志/IO。
- `applyPreset` 固定按 **base → preset → overrides** 展开，返回新 `Partial<AppConfig>`，显式 overrides 胜出；未知名称直接抛出 `Preset not found`，不静默回退。`registerPreset` 默认拒绝重名，`override: true` 才可覆盖，退订函数幂等且只移除自己的当前注册项。
- 与 `loadConfig` 的分工：`loadConfig` 负责确定 env/argv/cwd 等数据来源、执行既有解析与文件校验并落进调用方 `ConfigStore`；preset 不参与这些 IO。与 `createProxyRuntime` 的分工：runtime 可用 `preset` 先铺默认场景，再让显式 `config` 覆盖，最后把合并结果灌入该 runtime 的私有 `ConfigStore`。
- 回归护栏：`tests/unit/preset.test.ts` 覆盖 identity、内置清单、合并/不可变性、未知名称 fail-fast、注册覆盖与幂等退订、ConfigStore 兼容和 import 零副作用；`tests/unit/proxy-runtime.test.ts` 覆盖 preset + 显式 config 的 runtime 接线与启停。
