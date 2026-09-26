# src/config — 配置加载

配置层按**职责**分四层，每层职责单一、依赖单向。改哪块就改哪块的文件，不要把
不同职责的东西往同一文件里塞——本目录历史上最大的混乱来源就是 `config-helpers.ts`
这种「什么都在里面、名字什么都不承诺」的文件。

## 目录职责与依赖方向

依赖**自上而下**，禁止反向（同层之间只允许「表 → 校验 → 编排」这类单向）：

```
load.ts            编排层：initConfig / prepareRuntimeConfig（只调度，不含解析规则）
   ├── schema/     解释层：把字符串/typed 值解释成配置字段
   │   ├── field.ts    FieldDef 契约 + 通用解析器（parseStr/parseNum/parseEnum/parseBoolean）
   │   ├── fields.ts   FIELDS 表数据 + 表查询（isConfigKey/getFieldDef/keysByPhase）
   │   ├── validate.ts 表驱动校验（resolveFieldEntries/validateFieldValue/collect*Errors）
   │   └── guards.ts   跨字段守卫（assertAuthConfig）
   ├── source/     来源层：从外部世界取原始字符串
   │   ├── dir.ts       配置目录（getConfigDir/ensureConfigDir/HOME_CONFIG_KEY）
   │   ├── env-file.ts  .env 文件 -> process.env（loadEnvFiles）
   │   └── argv.ts      CLI argv -> env 风格键值 + parseStartupArgs
   ├── resources/  资源层：可热加载 JSON 子系统（读盘/校验/判定/事件/日志）
   │   ├── events.ts    资源事件总线（零框架依赖）+ createJsonFileEventBridge（生产侧）
   │   ├── notice.ts    唯一 notice 呈现路径（消费侧，每实例显式订阅）
   │   ├── pull.ts      强制 pull 端口（refreshConfigResource，返回脱敏元数据）
   │   ├── users/{schema,reader,policy}.ts  账号表：结构校验 / 读盘 / 账号级策略索引
   │   └── acl/{schema,reader,eval,resolve}.ts 名单：结构校验 / 读盘 / 编译缓存与单份判定 / 多来源编排
   ├── scope.ts    状态层：**每实例一份**的 ConfigScope（活动 Map + get/getAll/commit，零 IO）
   ├── types.ts    类型层：AppConfig/ConfigKey/LogLevel…（纯类型，零运行时）
   ├── defaults.ts 数据层：默认值种子 + 魔法值来源说明
   ├── presets.ts  数据层：预设目录（纯数据，不读 env / 不碰 scope）
   └── upstream-url.ts  UPSTREAM_URL 的校验与拆项（纯函数）
```

几条硬规则：

- **`schema/fields.ts` 的 FIELDS 表是 env 名的唯一真相源**，不许在别处再建第二张表。
  用户可见的 env 表在本文件（人工同步），机器可读源是 FIELDS。
- **布尔解析只活在 `schema/field.ts:parseBoolean`**，不许本地复制。
- `types.ts` ↔ `presets.ts` 之间存在**纯类型层**的双向引用（`AppConfig.preset`
  需要 `PresetName`，`PresetDefinition.config` 需要 `Partial<AppConfig>`），两侧都是
  `import type`、编译期擦除、运行时无依赖。刻意为此保留 preset 的字段级类型
  约束，不要用 `Record<string, unknown>` 去消灭这个环。
- `resources/notice.ts` 是唯一 notice 呈现路径；`users/` 与 `acl/` 只负责把 JSON
  事件桥到 `events.ts`，**不得另接 logger 或新增第二条日志路径**。桥工厂
  （`createJsonFileEventBridge`）住在 `events.ts`（生产侧）而不是 `notice.ts`。
- **notice 订阅是每实例显式创建的，安装点是 `src/instance.ts` 的
  `subscribeConfigNotices({ logger, paths })`**（早于 `selectAuthProvider` 的账号表读取，
  构造抛错时回滚释放）。总线（`events.ts`）是**进程内单例**，而 notice 的等级、落盘
  路径、日志前缀只属于某个实例的 `Logger`，所以订阅必须由组合根创建——本模块**没有**
  「加载即订阅」的副作用，`setConfigNoticeLogger()` 那种注入槽位也已删除。**绝不能从
  `events.ts` 反向 import notice**（那会让总线依赖 logger，设计就废了），**也不要在各
  reader 里各自 import**（会把唯一日志路径变成 N 条隐式依赖）。
- **`paths` 是 `() => readonly string[]` 而不是数组**：`authUsersFile`/`aclFile` 是 runtime
  字段，reload 后指向新文件，事件到来那一刻现取 scope 才能判对归属。漏了这个就是
  「热重载换文件后 notice 静默」，且没有任何类型检查能发现。
- **同一条事件只落一行**：两个实例读**同一路径**时共享 `readJsonCached` 的缓存条目、
  事件只发布一次，但两个订阅者都会收到。`notice.ts` 用**进程内共享的有界指纹窗口**
  （`NOTICE_FINGERPRINT_WINDOW=64`，指纹 = 资源+路径+transition+outcome+mtimeMs+size+
  去敏 error 文本）去重，先判归属再判指纹（反过来的话，不关心该路径的订阅者会吞掉本该
  落盘的一行）。取舍：那唯一一行归**先落盘的实例**。读不同路径的实例互不影响，各自一行。
- 历史教训：桥工厂从旧 `json-file-log.ts` 迁到 `events.ts` 后，reader 改 import
  `events.ts`，`notice.ts` 一度成为**零 importer 的孤儿**——热加载四态日志静默消失，
  而且没有任何类型检查或测试能发现它。更隐蔽的一版是它靠 `getLogger("config")` 取进程级
  日志器：库消费方从不 `setProcessScope()`，渲染时抛错又被总线吞掉，同样静默。改这条
  链路时务必确认 `instance.ts` 仍在调 `subscribeConfigNotices`。

## 初始化流程

1. 配置初始化不依赖模块导入副作用：**组合根**（CLI 的 `start()` / 库的 `createProxyInstanceFromEnv()`）在判断 cluster 角色、构造任何实例之前显式调用 `initConfig({ argv })`。`load.ts` 只导出初始化函数，不再在模块末尾裸调用。
2. `scope.ts:createConfigScope(seed?)` 产出**一份** `ConfigScope`（活动 `Map<ConfigKey, AppConfig[ConfigKey]>`，`defaults.ts` 做种子，`commit()` 是唯一批量写边界）。此前 `store.ts` 的进程级单例 `export const config = new Map(...)` 已删除——同进程跑第二个实例时它的 `get("authType")` 必然读到第一个实例 reload 后的值，多实例根本不可能。现在每个实例持有自己的 scope，**不存在**模块级 `get`/`set` 自由函数。
3. `load.ts:initConfig()`（表驱动，**无幂等位**：每次调用产出一个全新 scope，同进程可持有任意多个互不可见的实例配置）：
   - `useHomeConfig` 先决（CLI > env，经 `source/dir.ts:HOME_CONFIG_KEY` 单独取），决定配置目录（`~/.proxy` vs `cwd`）。
   - `source/env-file.ts:loadEnvFiles()`：低→高 `.env.production` → `.env.development` → `.env.<NODE_ENV>`（去重保留后者），`dotenv.parse` 后写 `process.env` —— **终端已设变量永不覆盖**（后文件仍胜过前文件）。
   - `source/argv.ts:parseRawArgv()` 归一 `--key value` / `--key=value` / `KEY=VALUE`（两种 `=` 形态都在**第一个** `=` 处切分，值可含 `=`）。显式给的值解析失败即 abort 启动 —— CLI 与 env 一视同仁，永不静默回退（布尔拼写错误也一样，`AUTH_ENABLED=treu` 会报错而不是悄悄变 `false`）。
   - FIELDS 解析循环是共享的：`schema/validate.ts:resolveFieldEntries(source)` 返回 `{ resolved, bad }`；`initConfig()` 喂 CLI>env 再补 `def`/`defaults` 回退，`source/argv.ts:parseStartupArgs()` 喂解析后的 argv（仅显式键），runtime candidate 则用同一 parser 做 typed 值校验——各自保留 range 检查 + 抛错。
   - 整数范围由 `FieldDef.int` 逐字段声明，解析后统一过 `schema/validate.ts:collectIntRangeErrors()`（`port`/`upstreamPort` 1-65535，`upstreamTimeout` >=1，`clusterWorkers` 0-1024）——`parseStartupArgs()` 跑同一检查，不另建校验 schema。
   - 两个可热加载 JSON（`cfg/users.json` / `cfg/acl.json`）在产出 scope 前强制读 + 校验：`initConfig()` 调 `readAuthUsers({ force, path })` / `readAcl({ force, path })`，**path 取刚解析出来的 `resolved.authUsersFile` / `resolved.aclFile`**（此刻配置还没成形，reader 也没有任何默认路径可退）——非法内容 abort（`配置校验失败: AUTH_USERS_FILE=<path> ...` / `ACL_FILE=<path> ...`）。scope 里只存**路径**；解析值住在 `json-file` 缓存层，保持热加载。
   - 跨字段守卫 `schema/guards.ts:assertAuthConfig({ authEnabled, authType, accountCount, jwtSecret })`：`authEnabled && (basic|uid) && accountCount === 0` 即 abort（指向 `AUTH_USERS_FILE`；空账号表否则是静默“全拒绝”）。
   - **任何一步抛错都产不出 scope**：调用方重试会重跑整条链（env 文件重复加载安全，见 `loadEnvFiles` 规定「终端已设变量永不覆盖」）。
4. `src/cli.ts` 的 `require.main === module` → `main()`：`initConfig({ argv })` → 按 `shouldRunAsMaster(scope.get("clusterWorkers"))` 分流。master 走 `runAsMaster({ allowProcessExit: true, config: createInstanceConfigProvider(scope), logger: createInstanceLoggerProvider(scope, "proxy") })`（**不装配协议内核**）；单进程/worker 走 `createProxyInstance({ name, config: scope.getAll(), allowProcessExit: true })` → `setProcessScope(instance.config.scope)` → `instance.attachSignals()`（**必须在 start 之前**）→ `instance.start()`。CLI 不再调 `startRuntime()`，也不自己 `new ProxyServer()`。
5. 库入口是 `src/index.ts` 的 `createProxyInstance`（不读 env/CLI，配置以对象给出）与 `createProxyInstanceFromEnv`（走完整加载链，**库消费方必须传 `argv: []`**，否则宿主进程 argv 会被当代理配置解析）。组合根在 `src/instance.ts`；master 分支只借用它导出的两个 Provider 工厂。
6. `ProxyServer.start()` → `setupProcessGuards()` → 打掩码配置 → 经协议注册表 `createCore()` → `proxy.start()`。

配置**只能经 `ConfigScope` 读**（`scope.get()` 现取、`scope.getAll()` 浅拷贝快照）；没有无参 `get()` 可用，也**不要**再加回来。CLI 构建入口是 `src/cli.ts`（esbuild 打包出 `dist/app.js`），库入口 `src/index.ts` 是纯导出、不含启动块。

## runtime 热重载与事务边界

runtime 配置的**唯一写入口**是 `ConfigProvider.reload(patch)`：契约在 `src/plugins/contracts.ts`，实现在 `src/instance.ts:createInstanceConfigProvider()`，库消费方经 `instance.reload(patch)` 触达。旧的 `ConfigService`（曾住 `src/runtime/config-service.ts`）已随该目录删除，**没有 `load()`、没有 `state`、也没有任何事件**——加载归组合根。`reload()` 绝不重新读取 CLI/env/preset，也绝不动态解析 preset 或加载插件。
- `reload()` 只接受 `phase=runtime` 的字段，startup 字段在 patch 中出现时整批拒绝（`prepareRuntimeConfig` 先扫一遍 patch 收集 startup env 名再抛，绝不部分写入）。字段 parser、枚举、整数范围、UPSTREAM_URL 派生和 auth 跨字段校验都委托 `schema/` 与 `upstream-url.ts`，reload 路径**不维护第二份规则**。
- `load.ts:prepareRuntimeConfig(current, patch)` 基于 `scope.getAll()` 构造完整 candidate，并 force 校验 candidate 指向的 users/ACL；全部通过后才调用 `scope.commit()` 一次性替换活动 Map。**失败不写任何字段**，scope 里的旧值原样保留。失败只靠抛异常表达——`ConfigReloadResult` 现在只有 `changed` 一个字段，不再有 `lastFailure`/`retained` 之类的失败态。
- **候选构造到 `commit()` 之间没有 await 边界**（纯同步段），因此并发调用 `reload()` 不会丢更新：读快照、校验、提交是一次不可分割的操作。旧实现那条「reload/refreshResource 共用串行队列」的并发前提已随服务层一起消失，不必再找队列。
- 只有字段**实际变化**时才 `commit`；空 patch/等值 patch 直接返回 `changed: []` 且不触碰活动 Map。runtime 配置**不发事件**，热重载的通知面就是 `reload()` 的返回值与调用方自己的日志。
- `ConfigReloadResult` 复用 `src/plugins/contracts.ts` 的同名类型；**不要**在别处另立第二份。
- `refreshConfigResource("authUsers"|"acl", path)`（`resources/pull.ts`）是**强制 pull 端口**：`path` 是必填位置参数，由调用方从自己的 scope 取出；它只按需 force 读盘，不创建 watcher、不返回 users/ACL 内容，只返回路径、存在性、transition/outcome、mtime/size 和去敏错误。资源状态仍由 reader 的 last-good/fallback 语义决定。
- pull 模型对消费者意味着：资源事件只通知「缓存状态已提交」，需要生效值时再显式调 `readAuthUsers({ path })` / `readAcl({ path })`（或 `loadAuthUsers(path)` / `loadAcl(path)`）；事件桥不传 AppConfig、账号、名单、密码、token、cause 或原始 `Error`。资源事件 listener 的异常与异步拒绝由总线隔离，反噬不到配置操作。

## 加载优先级与 env 表

- **优先级**：CLI args > 终端 env > env 文件值 > Preset > defaults。
- **Preset**：`PRESET` 选择 `presets.ts` 中的命名配置片段；preset 是 `FIELDS` 默认回退层的一部分，写入后仍走范围、JSON 和鉴权交叉校验，未知名称直接 abort。
- **env 键** —— 每字段恰一名（无别名），以 `schema/fields.ts` 每行的 `env` 为准：

| Env Key | Description |
| --- | --- |
| `HOST` | listen IP, default `0.0.0.0` |
| `PORT` | listen port |
| `PROXY_PROTOCOL` | `http`\|`https`\|`socks4`\|`socks5`\|`sockss4`\|`sockss5` |
| `PROXY_MODE` | `server`\|`client` |
| `AUTH_ENABLED` | `true`/`false` |
| `AUTH_TYPE` | `none`\|`basic`\|`jwt`\|`uid` |
| `AUTH_USERS_FILE` | path to the multi-account JSON (`[{ "username": "alice", "password": "pw1" }]`), default `<configDir>/cfg/users.json` |
| `JWT_SECRET` | jwt credential |
| `AUTH_LOGGING` | `true`/`false` |
| `ACL_FILE` | path to the ACL JSON (`clientIp`/`target`/`upstream` × `whitelist`/`blacklist`), default `<configDir>/cfg/acl.json` |
| `LOG_LEVEL` | console level: `debug`\|`info`\|`warn`\|`error`\|`silent`, default `error` |
| `LOG_FILE_LEVEL` | file level, same values, default `info` — independent from `LOG_LEVEL` |
| `LOG_FILE` | dir or file path → hourly JSONL `YYYY-MM-DD-HH.jsonl` |
| `CACHE_TYPE` | `memory`\|`redis` |
| `UPSTREAM_TIMEOUT` | ms, default 10000（同时是 cluster 停机 grace 基数，见 `src/server/AGENTS.md`） |
| `TLS_KEY` / `TLS_CERT` / `TLS_PASSPHRASE` | TLS server cert paths (only `https`/`sockss4`/`sockss5`) |
| `TLS_CA` | client-cert CA = **mTLS switch**. Empty (default) = server-only TLS; set = client certs **required** on `https`/`sockss4`/`sockss5`, unreadable file aborts startup. No default file（机制见 `src/utils/AGENTS.md`） |
| `UPSTREAM_URL` | `scheme://[user:pass@]host[:port]` — overrides granular upstream fields |
| `UPSTREAM_HOST` / `UPSTREAM_PORT` / `UPSTREAM_USERNAME` / `UPSTREAM_PASSWORD` / `UPSTREAM_CA` / `UPSTREAM_INSECURE` / `UPSTREAM_PROTOCOL` | granular upstream（`UPSTREAM_CA` 语义见 `src/utils/AGENTS.md`） |
| `UPSTREAM_SECURE` | 显式强制上游走 TLS。**最终 TLS 承载 = 本字段 OR `isTlsUpstreamProto(UPSTREAM_PROTOCOL)`**（`sockss4`/`sockss5` 没有明文形态），在 `plugins/routing-provider.ts:secureForUpstream` 合并成 `ForwardPlan.upstream.secure`。只配 `UPSTREAM_PROTOCOL=sockss5` 而不碰本字段是正常配置；曾有一版重构只读本字段、丢掉协议推导，导致这类拆项配置被静默降级成明文 |
| `CLUSTER_WORKERS` | 0 (=CPU cores) .. 1024 |
| `USE_HOME_CONFIG` | `true` → `~/.proxy/` |
| `PRESET` | 命名预设，默认空；低于显式 env/CLI，高于 defaults |

- **Phase**：每 `FIELDS` 行必填 `phase`（`schema/field.ts:ConfigFieldPhase`）。`startup` 键只在 `ProxyServer.start()` 读一次进 `ProxyOptions`（`proxyProtocol`/`host`/`port`/`tls*`/`clusterWorkers`/`preset`）或只影响启动期解析（`useHomeConfig`）——改了要重启进程；`runtime` 键每请求/每日志调用重读，可经 `instance.reload(patch)`（内部即 `ConfigProvider.reload` → `prepareRuntimeConfig` + `scope.commit`）热改。`logConfig()` 启动时打印 startup 清单，`keysByPhase()` 是机器可读源。
- 新增配置：`types.ts:AppConfig` + `defaults.ts:defaults` 加字段，再在 `schema/fields.ts:FIELDS` 加**一行**（`{ key, env, parse, phase, int?, def? }`，`phase` 必填；有界整数加 `int: { min, max }`）。`src/core/types/proxy.ts:ProxyProtocol` 与 `schema/fields.ts` 的枚举取值保持同步；用户可见键同步更新本文件 env 表。

## 访问控制（ACL）

三组名单同住 `ACL_FILE`（`cfg/acl.json`），一次热加载、一次校验。四个文件各司其职：
`acl/schema.ts`（纯校验，零 IO）、`acl/reader.ts`（读盘 + 节流缓存 + 事件桥）、
`acl/eval.ts`（编译缓存 + **单份名单**的三个判定入口，**零 IO：不认识路径**）、
`acl/resolve.ts`（**多来源编排**：两道闸门按固定顺序各判一次）。

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
- 判定入口（**两层，每层三入口**）：`acl/eval.ts` 收 `AclConfig` **值**（`evaluateClientIp` / `evaluateTargetHost` / `evaluateUpstreamRoute`，**零 IO**），`acl/resolve.ts` 收 `(instance, user, value)` 做**两道串联**（`resolveClientIp` / `resolveTargetHost` / `resolveUpstreamRoute`）。**取快照的路径参数一律由调用方现取**（`instance.ts:createAccessControlProvider` 从自己的 scope 取 `aclFile` 与 `authUsersFile`）——判定绝不允许回读进程级状态。调用点分布：`checkClientIp` 在 `core/server/base.ts:rejectByClientIp`（**auth 前后各一次**，见「账号级访问控制」）、`checkTargetHost`/`checkUpstreamRoute` 在 `plugins/routing-provider.ts:plan()`（client/server 两模式都判目标，`upstream` 组仅 client 模式有意义）。
- **账号级访问控制（`users.json` 内联 `acl`）**：每个账号可带一份**与 `acl.json` 顶层同构**的三组名单，形状由 `users/schema.ts` **直接复用 `validateAcl` 校验**（不维护第二份名单校验规则），按账号取出的入口是 `users/policy.ts:userAcl(accounts, username)`（`WeakMap` 按**账号表快照身份**记忆索引，与 `acl/eval.ts` 的编译缓存同一纪律）。**语义是「两道独立闸门」，不是「一份合并名单」**（`acl/resolve.ts` 是唯一收口）：
  1. **固定顺序**：实例级先判、账号级后判（外层原因优先，便于排障）。
  2. **任一命中即拒**：账号名单**只能在全局之上收窄，永远不能豁免全局的拒绝**。**override 语义被明确否掉**——全局 `target.blacklist=[ads.example.net]` 时，某账号写 `"acl":{"target":{}}`（「空=不限制」）就等于一个账号条目废掉公司级策略。
  3. **缺省 = 不额外限制**：账号没写某组 / 不在账号表里（jwt 的未知 `sub`）/ 实例没开鉴权 → 该维度只判实例级那一道。**策略缺失 ≠ 拒绝**。
  - `upstream` 组动作相反但形状不变：走上游要求**两道都同意**，任一道要求直连即直连。
  - `AclDecision.scope`（`instance` / `user`）**如实报出是哪一道拦下的**——这是「不做结果归约」的唯一理由：把两次判定塌成一个结果就丢掉了这个唯一有运维价值的事实。事件与日志字段是 `scope`（`[ip-denied]` / `[target-denied]` / `[route]` 三处都带）。
  - **判定顺序**（`clientIp → auth → clientIp(账号) → target(两道) → route(两道) → 配额 → dial`）：账号级 `clientIp` **只能在 auth 之后**判（此前没有身份），回 **403 绝不 407**（凭证有效，拒绝来自名单）。
- **流量配额（`users.json` 内联 `quota`）**：**总量**（非速率），形状 `UserQuota { bytes, period }`，`period` ∈ `hourly|daily|monthly|total`。**`bytes` 与 `period` 都必填、不给缺省值**（`{"bytes":N}` 在配置里是歧义，本项目对歧义一律 abort）；`bytes: 0` 非法（**0 不是「不限」**，不限请省略整个 `quota` 字段）。计量与判定**刻意不放在本目录**：判定契约在 `plugins/contracts.ts:UsageProvider`、实现（进程内存计量）在 `plugins/usage-store.ts`、字节计量桶在 `core/forward/meter.ts`。**三条诚实性边界**（写在实现里而非只写在文档里）：不持久化（重启归零）、不跨进程（**cluster 多 worker 各算各的，不是全局 N 倍额度**）、不掐进行中的传输（只在 `reserve` 阶段拒绝**新**请求）。
- **编译缓存**：`acl/eval.ts` 用 `WeakMap<AclConfig, CompiledAcl>` 按**快照对象身份**记忆编译结果（键 = 传入的 `AclConfig` 快照对象；实例级与账号级共用同一份缓存），命中后不重建。**刻意不用单个模块级槽**：多实例下 A/B 各读各的路径，单槽会被轮流冲掉、退化成每连接重编译。改用 WeakMap 后「同一路径恒命中同一条编译结果」由 `readJsonCached` 的值身份保证（缓存按「资源 + 路径」分条目，路径不变则 `value` 恒为同一对象），也**无需手工上界**——键随 json 缓存条目淘汰（16 条上限）一起回收。编译结果是只读共享对象，多会话并发无竞态。`acl/schema.ts` 的 `EMPTY_LIST` 被读盘与编译共享，改它会同时影响缺省组与编译空匹配器。
- **热加载**：`cfg/acl.json` 与 `cfg/users.json` 都经 `utils/file/json.ts:readJsonCached` 做**每文件最多 1s 一次的 stat 节流**（`maxAgeMs=1000`、`maxBytes=1MiB`），改动最多 1s 生效、**无需重启**。`readJsonCached` 不记日志，只把状态迁移作为 `onEvent` 事件抛出（`error`/`missing`/`recovered`/`reloaded`，变化才触发）；`acl/reader.ts` 与 `users/reader.ts` 经 `events.ts:createJsonFileEventBridge` 上总线，由 `resources/notice.ts` 统一落 `notice`。**严重度只由「生效值来源」决定，不与「哪个资源」混在一起**：`outcome=retained`（沿用上一份，名单/账号表**仍在生效**）→ warn；**回退空配置 → error**（该资源当前不生效：ACL 侧等于访问控制静默全放行、账号表侧等于空表全拒），文案必须带可操作说明（缺的是哪个文件、期望路径来自 `ACL_FILE`/`AUTH_USERS_FILE` 哪个键、怎么恢复——恢复后 1s 内自动热加载）。因此「解析失败沿用上一份」与「文件消失回退空配置」**不同级、不同文案**，绝不混成一条。**fail-open 语义不变**：缺文件绝不改成 fail-closed，只把「控制当前没生效」这件事升级到 error 级并说清怎么修。每行带结构化字段 `pid`（cluster 下每个 worker 各自热加载、各打一行，不做去重/聚合，凭 pid 区分进程）与 `mtimeMs`/`size`（版本标识，区分「同版本被 N 进程加载」与「文件被多次修改」；missing 事件无）。默认 error 级控制台可见，`LOG_LEVEL=silent` 下静音。
- 两个文件含密码/名单，`.gitignore` 已忽略 `cfg/users.json` / `cfg/acl.json`，仓库只提交 `cfg/users.json.example` / `cfg/acl.json.example`。

## 资源事件桥与 pull 模型

- `resources/events.ts` 是**零框架依赖**（无容器、无插件框架）的进程内配置领域事件总线，资源身份固定区分 `authUsers` 与 `acl`；`json-file.ts` 的缓存键是「资源 + 路径」，同一路径的两种资源不能共享值、错误或 missing 状态。总线只承载标量事实（`path`、`transition`、`outcome`、`mtimeMs`、`size`、去敏 `error`），不携带账号/名单内容、密码、配置快照或原始 `Error`。
- `readJsonCached` 仍是唯一的按需读取入口：每个资源/路径最多 1s 一次 `stat`，没有 `fs.watch` 或 timer watcher；事件在缓存条目提交之后发布，因此订阅者若在回调中再次 pull，看到的是本轮已提交状态。`error` / `missing` / `recovered` / `reloaded` 按变化去重，`outcome` 明确为 `adopted`、`retained` 或 `fallback`。
- 只有真正的 `ENOENT` / `ENOTDIR` 才是 `missing`（按既有安全语义回退空配置）；`EACCES`、`EPERM`、`EIO`、其它 I/O、非普通文件和 schema 错误统一是 `error`，有上一份有效值就 `retained`，否则 `fallback`。错误文本在缓存层去敏，事件不携带原始异常。
- 事件总线采用 **pull 模型**：事件只是“资源状态已变化”的通知，调用方仍通过 `loadAuthUsers(path)` / `loadAcl(path)` 按需读取当前生效值；订阅方（如 notice 渲染、`refreshConfigResource`）只消费安全元数据，不把资源值塞进事件。`subscribeConfigResourceEvents` 返回幂等 disposer，订阅者同步异常与异步拒绝均隔离，disposer 就是唯一的退订手段（没有容器去 `ctx.effect` 取消）。
- `resources/notice.ts` 是唯一 notice 呈现路径：它**按实例**被 `src/instance.ts` 订阅一次（`subscribeConfigNotices`，返回幂等 disposer，由 `ProxyInstance.dispose()` 释放，**不随 `stop()` 收放**——start/stop/start 重入期间 notice 必须一直在位），`users/` / `acl/` 只负责把 JSON 事件桥上总线，不得另接 logger 或新增第二条日志路径。
- `resources/pull.ts` 的 `refreshConfigResource(resource, path)` 是**强制 pull 端口**（`path` 必填，由调用方从自己的 scope 取出）：临时订阅总线只为保留本轮 transition/version，返回前 dispose，不创建 watcher。读盘委托 `users/reader.ts` 与 `acl/reader.ts`，本文件只做元数据脱敏与 DTO 组装。

## Preset 的生效语义

- preset 只在启动合并阶段选择并校验（`load.ts:initConfig()` 读 `PRESET` → `presets.ts:resolvePreset()`，位置在 defaults 之上、显式 CLI/env 之下）。
- **没有任何 preset 事件**：旧实现里的 `preset/applied` 随 `PresetService`/`preset-plugin` 一起删除。目录里的 `plugins` 字段是纯元数据，不构成「消费者应当动态装载它们」的承诺，也没有任何代码会去读它。
- runtime reload 遇到 `preset` 或其它 startup 字段会整批失败（`prepareRuntimeConfig` 先收集 startup 字段再一次性拒绝），所以运行期切不了 preset、改不了插件图、不会动态加载插件。**换 preset = 重启进程**。

## 本目录 Gotchas

- 开发环境 `.env.development` 开启了 `uid` 鉴权且指向 `./cfg/users.json`：账号表为空会**启动即 abort**，所以首次必须先 `cp cfg/users.json.example cfg/users.json`（该文件已被 `.gitignore` 忽略，仓库只提交 `*.example`）。
- `proxyMode` `server` vs `client` 决定 `resolveRoute` 的有效模式（server 读 URL/Host 直拨；client 拨 `upstreamHost`/`upstreamPort`，但 `upstream` 路由名单命中即回落直拨真实目标）——见 `src/core/AGENTS.md`。
- `HOME_CONFIG_KEY` 在 `source/dir.ts` 里是**字符串常量**而不是从 FIELDS 推导：它决定 env 文件从哪里读，必须在 env 文件加载之前单独解析，那时还不该把字段表当作可用来源。
- `readAuthUsers`/`readAcl` 的 `path` 是**必填参数，压根没有默认路径可取**（`loadAuthUsers(path)`/`loadAcl(path)` 同理）：路径必须由调用方从**自己的 scope** 现取，reader 绝不回读任何进程级状态。`initConfig()` 这一段最容易被忽略——scope 还没产出，它拿的是 `resolved.authUsersFile`/`resolved.aclFile` 这两个刚解析出来的值，不是「默认」。
- **不要再建「编译缓存单槽记忆」那种进程级状态**：`acl/eval.ts` 的编译缓存是 `WeakMap<AclConfig, CompiledAcl>`，**按快照对象身份**记忆（键就是 `readAcl({ path }).value`），刻意不跨实例共享、也不按路径做单槽——单槽记忆会让同进程第二个实例的第一个请求复用第一个实例的编译结果（名单/域匹配全部串味），或被两个实例轮流冲掉退化成每连接重编译。任何新增缓存都按「快照身份」或「显式注入的 owner」分域。
- **reader 的路径不许从任何隐式默认推导**：`users/reader.ts`、`acl/reader.ts` 的 `path` 必填，来源只能是调用方传入的 scope（`scope.get("authUsersFile")`/`scope.get("aclFile")`，每次现取以跟随热重载）。给 reader 加一个「不传就用 defaults 路径」的形参，等于把多实例隔离重新打开一个口子。
- `parseBoolean`（原 `toBoolean`）住在 `schema/field.ts`，被 `load.ts` 的 `USE_HOME_CONFIG` 早解析与 FIELDS 的布尔行共用；不要在别处再写一份拼写表。
