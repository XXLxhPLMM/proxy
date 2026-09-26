# src/config — 配置加载

按**职责**分层，每层一个文件夹或一个单一职责文件；依赖严格单向，由下至上：

```
types.ts        字段契约（纯类型，零运行时值）
store.ts        唯一配置状态 ConfigStore + 默认种子 defaults（零 IO）
schema/         字段元数据与校验（+ upstream-url.ts：UPSTREAM_URL 字段契约的唯一解析/拆项实现）
  └ upstream-url.ts  UPSTREAM_URL 字段契约（校验 + 六项拆项，UPSTREAM_SCHEMES 表在此）
sources/        外部输入 → ENV 风格键值
normalize/      配置副本的路径 / UPSTREAM_URL 归一化（纯内存）
context.ts      ConfigAccessor 只读端口 + ConfigContext 冻结快照
files/          磁盘配置资源（users.json / acl.json）+ 热加载事件日志
  └ rules/     acl.json 条目规则层：IP/CIDR 解析编译 + 主机/通配域名匹配（零 IO 零配置依赖）
presets.ts      配置预设
load.ts         唯一 async 加载器（唯一做 IO 编排的入口）
index.ts        唯一对外 barrel（配置面）+ files/rules/index.js（名单原语，唯一的第二出口）
```

## 引用规约（硬规则）

- **跨目录只引 `@/config/index.js`**（根级入口 `src/index.ts` / `src/cli.ts` 同样走 `@/config/index.js`，它们位于 `src/` 根上，不使用 `./` 相对导入）。禁止写 `@/config/store.js`、`@/config/files/users.js`、`@/config/context.js`、`@/config/normalize/index.js` 这类深路径：目录重构时调用方必须零改动。**barrel 缺什么就往出口加，不要在调用方开深路径口子。**
- **barrel 的对外出口是刻意分层的**（2026-09 起由「7 处深路径违规」收敛而来）：对外出 `defaultEnvFileNames`（CLI 需要自己决定读哪些 env 文件）、`prepareRuntimeConfigStore`（runtime 重建 context 时的跨目录装配入口）、以及 `ConfigStore`/`loadConfig`/`createConfigContext`/`createConfigContext`/名单读取面/presets 等既有出口；`sources` 的 `readEnvFiles`/`parseRawArgv`/`getConfigDir` 与 `normalize` 的纯函数原语（`resolveConfigPaths`/`applyUpstreamUrlToConfig`/`prepareRuntimeConfig`）**刻意不导出**——它们是 `load.ts` 与 `createConfigContext` 的内部编排件，没有跨目录调用方就别扩大公开面。唯一例外仍是 `@/config/files/rules/index.js`。
- **`UPSTREAM_URL` 拆项只有 `normalize/upstream.ts:applyUpstreamUrlToConfig` 一处实现**：`loadConfig` 经它拆一次，纯内存 runtime 经 `prepareRuntimeConfigStore` 拆一次，两条路径共用。**不要**把拆项塞进 `createConfigContext`——那会造出第三套入口，破坏「两条路径对同一 URL 永不出不同结果」的不变量。
- **唯一的第二出口是 `@/config/files/rules/index.js`**：名单条目原语（`compileIpRules`/`ipMatches`/`compileHostRules`/`hostMatches`/`normalizeIp`/`normalizeHost`/`ipToString`/`ipv6BytesToString`）**刻意不进** `@/config/index.js`——它服务的是 core 的判定层，不是配置 API。core 侧（`access-control.ts`、`forward/dial.ts`、`forward/socks.ts`、`helpers/self-loop.ts`）只从这一个 barrel 取，再往深引 `./ip.js` 一律算违规。
- **config 内部用相对路径**（`./store.js`、`../schema/fields.js`），不自我引用 barrel，避免循环依赖。
- **⚠️ 允许且仅允许的出边：`config → core` 的 type-only 引用。** 依赖方向是单向的 `core → config`，但**本目录有三处反向的 `import type`**（编译期擦除、零运行期依赖边，循环依赖不可能形成）：

  | 位置                                                                       | 引的 core 符号                                    | 为什么这条边合理                                                                                                                                                                                                                              |
  | -------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `types.ts:14`                                                              | `@/core/types/proxy.js` 的 `ProxyProtocol`        | `AppConfig.proxyProtocol` / `upstreamProtocol` 的**类型必须与 core 的协议联结合一份**。抄一份字面量联合，core 加协议时配置层会静默停在旧联合上 —— `createProxy` 拿到表外值只会在运行期炸                                                                             |
  | `schema/upstream-url.ts:41`                                                | 同上（`UPSTREAM_SCHEMES` 的 `Record` 值类型）     | 同一份联合的第二个消费点（scheme → protocol 的映射表）                                                                                                                                                                                        |
  | `files/users.ts:38`                                                        | `@/core/traffic/index.js` 的 `QuotaWindow`        | `UserQuota.window` 的类型必须与账本窗口键的计算口径同一份。抄一份 `"day"\|"month"` 就会让「校验放行的取值」与「算窗口的取值」在将来漂移成两套                                                                                                                                      |

  **记在这份（看起来像违规的一方）而不是 `src/core/AGENTS.md` 是刻意的**：违规总在**依赖方向的上游**被先看到。`core/AGENTS.md` 答的是「core 允许引什么」，本节答的是「config 允许往哪引」—— 只记一半，另一半的人就会以为 `config → core` 一定是写错了，然后**复制一份字面量联合**（那才是真正的事故）。

  **判据三条，全都要满足**才允许再加一处：① **`import type`**（不是 `import`）—— 编译期擦除，零运行期依赖边；② 收口到 **barrel**（`@/core/traffic/index.js`）而不是深层实现路径；③ 符号必须是**契约的单一真相源**（协议联合、窗口字面量集），**不是**行为或判定 —— 判定与 IO 一律不许反向进 config（`files/users.ts` 只提供数据，「超了没有」的裁决住在 `core/traffic/memory.ts`；名单判定同理在 `core/access-control.ts`）。

  **运行期依赖（值 import）一律禁止**：`@/core/traffic/index.js` 的 barrel 里全是值导出（`windowKey` / `quotaWindow` / `JsonlTrafficLedger` …），所以这条边**必须**是 `import type` —— 改成值 import 会让 config 在 import 期把 core 的整条链拉进来，并让 `config → core` 变成**真**的运行期环。
- **FIELDS 表是 env 名的唯一真相源**，不许在别处再建第二张表。新增配置：`types.ts:AppConfig` + `store.ts:defaults` 加字段，再在 `schema/fields.ts:FIELDS` 加**一行**（`{ key, env, parse, phase, int?, def?, path? }`，`phase` 必填；有界整数加 `int: { min, max }`；路径字段加 `path: true`）。`src/core/types/proxy.ts:ProxyProtocol` 与 `types.ts` 保持同步。
- **访问控制判定不在本目录**：名单数据在 `files/acl.ts`，**条目规则**（解析/编译/匹配，即「什么算合法条目、怎么命中」）在 `files/rules/`，请求期判定（`checkClientIp` / `checkTargetHost` / `checkUpstreamRoute`，黑白名单优先级、整组缺失回退、命中后拒绝还是直连）在 `src/core/access-control.ts`。改名单**语义/动作**动 core，改**文件格式与条目语法**动 `files/rules/`（连带 `files/acl.ts` 的形状校验）。

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
- `upstream-url.ts`（原 `utils/upstream-url.ts`）：`UPSTREAM_URL` 这个**字段**的契约——`parseUpstreamUrl`（FIELDS 的 parse 校验器，非法即阻止启动：空串/不可解析/scheme 不在 `UPSTREAM_SCHEMES` 白名单/无 hostname/带 path·query·hash/端口越界）、`applyUpstreamUrl`（把 URL 拆成 6 个 granular 字段写进 resolved 表，IPv6 字面量剥括号，userinfo 容错解码）与模块私有的 `UPSTREAM_SCHEMES` 表（`protocol`/`secure`/缺省端口，新增上游类型只加一行）。**http/https 的缺省端口引 `@/utils/constants/index.js` 的 `DEFAULT_PORT_HTTP`/`DEFAULT_PORT_HTTPS`**，不许再写第二份 80/443；SOCKS 系列无通用缺省端口常量（1080/443 随明文与 TLS 而变）就地给出。它住 config 是因为只服务这一个字段：通用工具目录不该知道「上游」，也不该为此反向依赖 `@/core/types/proxy.js`（只 type-only 引 `ProxyProtocol`）。
- `index.ts` 是本层出口，`loadConfig` 与 `server/log/config-log` 从这里取。**`upstream-url.ts` 不进本 barrel**（它不是校验原语，只是字段契约），`normalize/upstream.ts` 与单测用相对路径 / 深路径直引。

### `sources/` — 外部输入

- `config-dir.ts`：`HOME_CONFIG_KEY` + `getConfigDir(useHome, cwd?)`。必须在读 env 文件**之前**确定（相对路径与各 path 字段默认值都以它为锚）；只解析路径、绝不创建目录。
- `env-files.ts`：`defaultEnvFileNames(nodeEnv?)` 只**产名字**不扫描不读取；`readEnvFiles(files, baseEnv)` 按输入顺序读，后文件覆盖前文件，显式 `baseEnv` 的键恒优先，缺失跳过、其它错误抛出。**绝不写宿主环境**。
- `argv.ts`：`parseRawArgv(argv)` 归一 `--key value` / `--key=value` / `KEY=VALUE`（在第一个 `=` 切分，值可含 `=`）。纯字符串处理，不读 `process.argv`。
- 全部函数要求**显式入参**，没有任何一个去读 `process.env` / `process.argv`。

### `normalize/` — 归一化（纯内存）

- `record.ts`：把泛型配置对象收窄成可按 `ConfigKey` 索引的 record（层内共享，避免各写各的强转）。
- `paths.ts`：`resolveConfigPaths(config, configDir)` 按 `FIELDS.path` 把相对路径绝对化。空串保留、绝对路径原样、只在副本上写。
- `upstream.ts`：`applyUpstreamUrlToConfig(target, raw, explicitlyProvided?)` 是 **UPSTREAM_URL 拆项的唯一入口**，返回「显式拆项被覆盖」的 warning 列表。它自己**不含拆项实现**——parse 走 `schema/upstream-url.ts:parseUpstreamUrl`、写回走同文件 `applyUpstreamUrl`（字段契约与归一编排因此只有一份实现两处调用）。先 parse 再触碰 target，非法 URL 抛 `配置校验失败: UPSTREAM_URL=... 非法`，不会部分改写；空串 = 未配置，返回空 warning。
- `prepare.ts`：`prepareRuntimeConfig`（纯内存副本）/ `prepareRuntimeConfigStore`（只把真正变化的字段 merge 回 store，先在副本上校验，失败不半写）。
- `loadConfig` 与纯内存 runtime 共用这一套实现，两条路径永不对同一 URL 得出不同结果；`FIELDS.upstreamUrl.parse` 与 `applyUpstreamUrlToConfig` 共用 `schema/upstream-url.ts`，改 URL 契约只需改那一处。

### `context.ts` — 读取端口与上下文

- `ConfigAccessor` 是消费者的最小端口，**只有泛型 `get`**：没有 `getAll`、没有 `set`，也没有隐式全局回退。`configAccessorFromStore()` 每次创建稳定、冻结且只含 `get` 的适配对象，store 后续热改立即反映。
- `ConfigContext` 固定含 `{ store, accessor, config, configDir, sources, startupKeys, warnings }`：`store`/`accessor` 是 live 读取面；`config` 是创建时复制并 `Object.freeze` 的初始快照；`startupKeys`/`warnings` 与来源数组也冻结。
- `ConfigSourceMetadata` 只含 `envKeys`、`argvKeys` 与已转绝对路径的 `envFiles`；**原始来源值不进入元数据**，避免密码/JWT secret 被诊断来源复制。
- `createConfigContext` 是唯一手工 context 工厂：对象参数只含 `store`、必填 `configDir` 及可选 `sources/warnings`；`startupKeys` 不是入参，固定取完整 `keysByPhase().startup`。工厂先 `path.resolve(configDir)`，再按绝对目录归一化 store 中所有 path 字段。

### `files/` — 磁盘配置资源

- `users.ts`：`AuthAccount`（含可选 `acl?: UserPolicy` 与可选 `quota?: UserQuota`）+ `UserPolicy` / `UserPolicyList` / `UserQuota` + `validateAuthUsers`（形状校验）+ `readAuthUsersAsync`（启动期 **fail-closed** 强校验，绕过热加载缓存与事件；**只把 `ENOENT` 当缺失**） + `readAuthUsers` / `loadAuthUsers` / `loadUserPolicy` / `loadUserQuota`（同步热加载面，`opts.config` 必填）。
  - **账号级名单 `acl`（Phase 4a 只读侧 → 4b 已接入请求期判定）**：形状 `{ "target": { "whitelist": [...], "blacklist": [...] } }`，**可选**；旧的 `[{username,password}]` 文件**逐字仍然合法**（不因本字段破坏任何现有部署）。**条目语法与全局 `acl.json` 的 `target` 组完全同形，合法性只经 `rules/host.ts:parseHostRule` 判定**——本文件没有第二套条目解析（护栏：`tests/unit/auth-users.test.ts` 的源码级断言，锁死「全文恰好一处 `parseHostRule`、零 `parseIpRule`/`normalizeHost`/正则」）。任一条目非法 → 整组非法 → 启动期 abort（与全局 ACL 同语义，绝不静默丢字段后当作没配）。**判定在 `core/access-control.ts:checkTargetHost(host, config, user)`，不在本目录**：`放行 ⇔ 全局 target 组放行 ∧ 该用户 target 组放行`（先全局后个人、全局短路、两关都拒报全局那条）；`cfg/users.json.example` 已补一条带 `acl` 的账号作示例。
  - **只允许 `target` 一个组**：`clientIp` / `upstream` / 任何未知键一律**整组非法**（fail-closed）。理由：判定顺序是 **clientIp → auth → target ACL → 路由**，客户端名单判定发生在**鉴权之前**，那时还不知道用户是谁，「按用户限制来源 IP」在当前顺序下不可实现——收下一个永不生效的字段等于给假的安全感，不如启动期报错；`upstream` 是 client 模式的路由名单（与「你是谁」正交）。
  - **`ACCOUNT_KEYS = {username, password, acl, quota}`**：新增可选字段**必须**同步加进这张白名单，否则所有带该字段的文件会被「未知顶层键」判非法（最容易漏的联动点，护栏有专门一条断言 + 变异测试：把 `quota` 删掉 → 10+ 条红）。原有规则一条未放松：用户名非空 / 不含 `:` / 不重复、密码必须 string、元素必须对象、未知顶层键拒绝；旧格式账号的产物**不写 `acl: undefined` / `quota: undefined` 键**。
  - **账号级流量配额 `quota`（读面在 `users.json`，计量与耗尽判定在 `core/traffic/`）**：形状 `{ "bytesUp": N, "bytesDown": N, "bytesTotal": N, "window": "day"|"month" }`，四个子键**各自可选**；三个字节字段缺省补 0，**全 0 或整体缺省 = 该用户不限流**。每字节字段必须**非负安全整数**（`Number.isSafeInteger` 且 `>= 0`），负数/小数/字符串/布尔/`null`/`NaN`/`±Infinity`/超 `2^53-1`/未知子键 → **整组非法 → 启动期 abort**。**刻意没有速率字段**（`rateBps` 之类）——限速必须 `pause()`/`resume()` 整形，会与 `guardDialing` 的半关闭联动形成第三层流控，理由见 `src/core/AGENTS.md` 与 `core/traffic/meter.ts` 文件头。
  - **`quota.window`（Phase 5b-1）只认 `day` / `month` 两个日历窗**，缺省 = `month`。其它取值（`"week"` / `"hour"` / `"rolling"` / 大小写变体 / 非字符串 / `null`）→ **整组非法 → 启动期 abort**：收下「配了、实际按 month 跑」的值等于给假的安全感。**为什么不做滚动窗**（`"30 天内 100GB"`）：① 解释成本——运维看到「已用 98GB/100GB」时答不出「为什么现在被拒」，而配额是**要被运维解释**的东西；② 聚合成本——滚动窗不能只存一个标量，判定要跨多个历史窗口求和，与账本「**滚动即清账**」的惰性模型（无定时器、无后台任务）不相容；③ 本项目处于设计期，**不预留占位值**——塞一个 `window:"rolling"` 却按日历窗跑恰是「配了但没生效」的最坏形态。真要支持必须连同账本形态（滑窗队列 + 落盘格式）一起设计。
  - **缺省 `month` 归一在**消费侧**（`core/traffic/window.ts:quotaWindow`），不在本层**：归一化产物只回显磁盘上写了什么，缺省时**不写 `window` 键**（写了就等于在产物里塞一个运维没配过的值，并让「旧文件产物逐字不变」那条不变量失效）。故 `UserQuota.window` 是**可选**键，`QUOTA_KEYS` 是含 `window` 的**闭合集合**（漏加 → 所有写了窗口的文件因「未知子键」整组作废，护栏有专门断言 + 变异测试）。窗口键的计算与 DST 取舍见 `src/core/traffic/window.ts` 文件头；**`shiftHours` 在那一层被夹到 `[0,23]`**（`ConfigStore` 零校验 → 库路径能塞进非法值，畸形键会一路进落盘账本）。
  - **逐项说明在 `cfg/users.json.example.md`，不在 `users.json.example`**：`users.json` 是 `JSON.parse` 的输入，**任何注释都会让整份文件解析失败 → 启动 abort**。所以「三个上限分别是什么」「全缺省 = 不限流」这类文案只能写进配套 `.md`；示例文件保持逐字可 `cp`。
  - **`quota` 与 `acl` 互不影响但各自独立决定整份文件是否作废**：一个合法一个非法时**整份文件判非法**（fail-closed），**绝不**「只丢非法的那一个、另一个照常生效」——后者会造出「我配了名单但它没生效」这种要读源码才能查出来的问题。护栏：`tests/unit/user-quota.test.ts` 的「quota 与 acl 互不影响」那条。
  - `loadUserQuota(username, config, onFileEvent?)` 与 `loadUserPolicy` **逐字同构**：复用 `readAuthUsers` → `readJsonCached`（缓存键仍是 `label + path`），故热加载语义完全一致（1s stat 节流、坏内容保留上一份有效值、缺失 = 空表）。**热路径零分配**：`consume` 是**每 chunk** 调用（一次大文件传输能调几万次），故同样用下标循环 + `frozenQuotas` WeakMap 按源对象身份记忆冻结副本（连续两次查询返回**同一对象身份**）。源码级护栏锁死「`users.ts` 全文 `readJsonCached` 恰好一处、`loadUserPolicy` 与 `loadUserQuota` 体内都只有 `readAuthUsers(`」——另开读取器会造成两份节流缓存、两份解析、两套坏文件处理并互相污染同一缓存键（已变异测试验证：给 `loadUserQuota` 另开一个 `readJsonCached` → 源码断言 + 「一次内容变更只报一次 `reloaded`」那条行为用例同时红）。
  - `loadUserPolicy(username, config, onFileEvent?)` 是**按用户名取策略**的读取面，**复用账号表同一条路径**（`readAuthUsers` → `readJsonCached`，缓存键仍是 `label + path`）：另开读取器会造成两份节流缓存、两份解析、两套坏文件处理并互相污染同一缓存键。热加载语义因此与账号表逐字一致（1s stat 节流、坏内容保留上一份有效值、缺失 = 空表），返回值**深度冻结**（绝不把缓存里的内部数组引用交出去）。**它是每请求调用的热路径**（4b 起被 `core/access-control.ts` 的个人层消费），故**快照未变时零分配**：定位账号用下标循环（`find` 的闭包也是分配）、冻结结果按**源 policy 对象身份**用 `WeakMap` 记忆（`frozenPolicies`），连续两次查询返回**同一对象身份**（护栏：`tests/unit/auth-users.test.ts`「热路径零分配」那条用 `toBe` 锁；`toEqual` 锁不住分配）。记忆表外仍**新建**一份冻结副本，故「拿到的对象与缓存内部引用无关」这条不变量在任何一次调用上都成立。
  - **`acl` 与 `quota` 对凭证索引都不可见**：`core/helpers/credentials.ts` 消费的是 core 那份两字段 `AuthAccount`（`core/types/proxy.ts`），`acl`/`quota` 既不进 `basic`/`uidUsers` 索引也不改变任何比对行为（护栏断言带 acl/quota 与不带的两份账号表产出**逐项相同**的索引）。
- `acl.ts`：`AclList` / `AclConfig` + `validateAcl` + `readAclAsync` + `readAcl` / `loadAcl`。**只管拿数据与形状校验，不做判定**；条目合法性靠同目录 `rules/` 的 `parseIpRule` / `parseHostRule` 判，任一条非法 → 整组编译失败 → 启动期 abort。
- `event-log.ts`：`createJsonFileEventHandler(logger)` / `logJsonFileEvent`，把 `readJsonCached` 的 `error`/`missing`/`recovered`/`reloaded` 渲染成日志。本模块**不持有任何 logger 单例**，logger 由调用方显式注入。
- 两个文件的读取都经 `utils/json-file/index.ts:readJsonCached` 做每文件最多 1s 一次的 stat 节流（`maxBytes=1MiB`），缓存键严格为 `label + path`；`core/access-control.ts` 也直接从同一 barrel 取 `readJsonCached` 语义（类型 `JsonFileEvent`）。

#### `files/rules/` — 名单条目规则层（数据层，唯一的跨目录第二出口）

来源是已删除的 `utils/ip-list.ts` + `utils/host-list.ts`：**原有导出符号名与签名一字未改**，只有归属从 utils 挪到 config（因为它们是 `acl.json` 的业务契约，不是通用网络基础设施）；`ipToString`（字节 → 文本，审计/诊断用）是本次新增的导出。

- `ip.ts`（服务 `clientIp` 组，以及另两组的 IP/CIDR 分支）：`IpFamily` / `IpValue` / `IpRule` 类型，`normalizeIp`、`ipv6BytesToString`、`ipToString`、`parseIpRule`、`compileIpRules`、`ipMatches`。地址一律以**字节缓冲**表示（v4 4 字节 / v6 16 字节），前缀按位掩码比较，故 `10.0.0.5/24` ≡ `10.0.0.0/24`；`::ffff:a.b.c.d` 与 `::ffff:7f00:1` 一律还原为 IPv4（双栈必需，否则 IPv4 规则永不命中）。
- `host.ts`（服务 `target` / `upstream` 两组）：`HostRule` / `HostMatcher` 类型，`normalizeHost`、`parseHostRule`、`compileHostRules`、`hostMatches`。IP/CIDR 分支直接复用 `ip.ts`，编译成「IP 规则 + 精确域名 `Set` + 通配后缀数组」供热路径零分配匹配；域名 ASCII 白名单正则**刻意拒绝 IDN 与下划线**（要写 punycode）。
- `index.ts` 是本层出口。层内相对引用（`./ip.js`），**禁止自引 barrel**。
- **硬不变量**：零配置依赖（不引 `@/config/index.js`、不读 store/env/文件）、零 IO、零日志、零模块级状态。字符级归一化统一委托叶子模块 `@/utils/host-text.js`（`lowerTrim` / `stripIpBrackets` / `stripZone` / `stripTrailingDot`），两文件只保留各自**一条**语义差异：`normalizeIp` 只认「整体被方括号包裹」，`normalizeHost` 认 `[v6]:port` 并按 `]` 截断且方括号形态不去尾点。

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
- 相对 env 文件路径相对最终 `configDir` 解析，绝对路径原样；来源元数据保留调用方给出的文件顺序与绝对路径（文件不存在也记录）。`config.loaded` 的载荷键是 **`source`**（由 `runtime/runtime.ts:sourceName(context)` 计算），按 `argv` > `environment` > `env-files` > `memory` 识别。

## 初始化流程（CLI 路径）

1. `src/index.ts`、`src/config/load.ts` 与 `src/cli.ts` 的 import 都不读取配置。
2. `src/cli.ts:main()` 是**唯一读取宿主 `process.env` / `process.argv` / `NO_COLOR` 的组合根**，且仅在 `require.main === module` 的执行路径进入。它在第一次 `await` 前分别快照 `{ ...process.env }`、`process.argv.slice(2)`、`process.cwd()` 与 `NO_COLOR`。
3. CLI 用 `defaultEnvFileNames(env.NODE_ENV)` 显式生成低→高候选：原始顺序固定为 `.env.production` → `.env.development` → `.env.<NODE_ENV>`，后者覆盖前者；重复名只保留最后一次。因此 `NODE_ENV=production` 去重后的实际读取顺序是 `.env.development` → `.env.production`（production 仍胜出）。该函数只产名字，不扫描也不读取文件。`start/start:dev/start:prod` 仅设置 `NODE_ENV`，不再用 Node `--env-file` 预注入。
4. `loadConfig` 返回 context 后，CLI 严格执行 `createLogger({ config: context.accessor })` → 输出 `context.warnings` → `runServer(context, logger, noColor, workerSlot)`（第四个形参是流量配额账本槽位号，只从上面那份 env 快照取；细节见 `src/core/AGENTS.md` 的 traffic 一节）。
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
| `QUOTA_LEDGER_DIR`                                                                                                       | **startup** 配额账本目录，默认 `<configDir>/cfg/quota`（标 `path: true`，相对值按 configDir 绝对化）。**必须是 startup**：运行中改目录 = 已打开的 append 句柄仍指向旧文件，改了等于没改；改它要重建 runtime。**5b-2 起被 `core/traffic/ledger.ts` 消费**：`<dir>/worker-<slot>.jsonl`，`slot` 是稳定序号（单进程 `"0"`，cluster worker `1..N`，由 `server/cluster.ts` fork 时注入 `PROXY_WORKER_SLOT`）。**没有用户配非全 0 `quota` 时这个目录不会被创建**（零成本档） |
| `LOG_LEVEL`                                                                                                             | console level: `debug`\|`info`\|`warn`\|`error`\|`silent`, default `error`                                                                                                                                           |
| `LOG_FILE_LEVEL`                                                                                                        | file level, same values, default `info` — independent from `LOG_LEVEL`                                                                                                                                               |
| `LOG_FILE`                                                                                                              | dir or file path → hourly JSONL `YYYY-MM-DD-HH.jsonl`                                                                                                                                                                |
| `CACHE_TYPE`                                                                                                            | `memory`\|`redis`                                                                                                                                                                                                    |
| `UPSTREAM_TIMEOUT`                                                                                                      | ms, default 10000（同时是 cluster 停机 grace 基数，见 `src/server/AGENTS.md`）                                                                                                                                       |
| `TLS_KEY` / `TLS_CERT`                                                                                           | TLS server cert paths (only `https`/`sockss4`/`sockss5`)；**只有这两个**标 `path: true`，**构造期按 `configDir` 绝对化**；读取实现见 `src/utils/AGENTS.md` 的 TLS 一节（`utils/tls/certs.ts`）                                                  |
| `TLS_CA`                                                                                                                | client-cert CA = **mTLS switch**. Empty (default) = server-only TLS; set = client certs **required** on `https`/`sockss4`/`sockss5`, unreadable file aborts startup. No default file（机制见 `src/utils/AGENTS.md` 的 TLS 一节，实现已搬进 `utils/tls/`）；**它标 `path: true`** |
| `TLS_PASSPHRASE`                                                                                                         | TLS 私钥口令（**startup**，默认空串）。**刻意不标 `path: true`**——它是口令不是路径，绝不能给它加 `path.join` 绝对化。全表 `path: true` 只有 8 个：`AUTH_USERS_FILE`/`ACL_FILE`/`QUOTA_LEDGER_DIR`/`LOG_FILE`/`TLS_KEY`/`TLS_CERT`/`TLS_CA`/`UPSTREAM_CA` |
| `UPSTREAM_URL`                                                                                                          | **startup** `scheme://[user:pass@]host[:port]` — overrides the six endpoint fields below（校验与拆项契约在 `schema/upstream-url.ts`）                                           |
| `UPSTREAM_HOST` / `UPSTREAM_PORT` / `UPSTREAM_SECURE` / `UPSTREAM_USERNAME` / `UPSTREAM_PASSWORD` / `UPSTREAM_PROTOCOL` | **startup** endpoint fields derived/normalized with `UPSTREAM_URL`; rebuilding a runtime is required after changes                                                                                                   |
| `UPSTREAM_CA` / `UPSTREAM_INSECURE`                                                                                     | runtime TLS verification overrides（路径/布尔语义见 `src/utils/AGENTS.md` 的 TLS 一节，实现在 `utils/tls/`；布尔解析仍只有 `schema/parse.ts:toBoolean` 一份）                                                                     |
| `CLUSTER_WORKERS`                                                                                                       | 0 (=CPU cores) .. 1024                                                                                                                                                                                               |
| `USE_HOME_CONFIG`                                                                                                       | `true` → `~/.proxy/`                                                                                                                                                                                                 |
| `QUOTA_RESET_HOUR`                                                                                                      | runtime 窗口重置小时 `0..23`（**本地时区**），默认 `0`。`window=day` 时它是新一天的第一刻（`3` → `01:00` 仍算前一天）；**每请求现读**，热改即生效（判定与落盘恢复**同一份**闭包，故两者的边界永远一致）。越界（`-1`/`24`）**启动期 abort**；**库路径 `ConfigStore` 零校验**时非法值由 `core/traffic/window.ts:clampShiftHours` 夹到 `[0,23]`（不产出 `NaN-NaN-NaN` 畸形键） |
| `QUOTA_FLUSH_INTERVAL`                                                                                                  | runtime delta 落盘间隔 ms，`int min 1`，默认 `5000`。**5b-2 起被 `core/traffic/flush-loop.ts` 消费**：自重排 `setTimeout`（间隔每次现读 → 热改在下一轮生效）、`unref()`。`0`/负数**启动期 abort**（`0` 不等于「关掉落盘」）；**停机落盘与这个间隔无关**（`runtime.stop()` 必做最后一次 flush），所以「间隔配很大 + 反复 Ctrl+C」刷不出额外额度 |

- **Phase**：每 `FIELDS` 行必填 `phase`。`loadConfig()` 把 startup 键名写入 `context.startupKeys`；`createProxyRuntime()` 构造时由 runtime accessor 固定这些键的启动值，随后 store 改动发布 `config.restart-required`、不改变当前实例。`UPSTREAM_URL` 与六个 endpoint 拆项都属于 startup；纯内存 runtime 修改任一项都需重建 runtime，URL 拆项覆盖 warning 仍保留。`UPSTREAM_CA/INSECURE/TIMEOUT` 等 runtime 键继续经同一 live store 每请求/每日志调用现读，发布 `config.changed`。`logConfig()` 打印初始冻结快照与 phase 清单，`keysByPhase()` 是机器可读源。
- **Phase 5b-1 新增三行**（`quota` 本身住在 `users.json`，这三个是围绕它的运行参数）：`quotaLedgerDir`（**startup** + `path: true`，见 env 表理由）、`quotaResetHour`（runtime，`int {min:0,max:23}`）、`quotaFlushInterval`（runtime，`int {min:1}`）。**分流的事件面已被护栏锁住**（`tests/unit/quota-config-fields.test.ts` 断言 `keysByPhase()` 的归属，`tests/unit/proxy-runtime.test.ts` 的「流量配额三个配置项按相位分流」经**真 runtime** 断言 `config.restart-required` vs `config.changed`）——分类写错的后果分两种：账本目录被标 runtime 会「看起来生效」而实际句柄没换；`resetHour` 被标 startup 则热改必须重启，运维会以为配置坏了。
- **Phase 5b-2 起三行都有真实消费方**（5b-1 结束时它们是「零消费方」的死字段）：`quotaLedgerDir` → `core/traffic/ledger.ts:JsonlTrafficLedger`（`runtime/services.ts:buildDefaultServices` 注入，**目录只在有非全 0 配额时创建**）；`quotaResetHour` → 同一个账本的窗口口径（**与判定共用同一 accessor 闭包**，所以恢复与判定不可能算出两个窗口）；`quotaFlushInterval` → `core/traffic/flush-loop.ts:startFlushLoop`（唯一定时器站点，`unref`）。**「零消费方」状态是 5b-1 独有的**——新增配置项时先确认有消费方，否则它就只是一行文档。
- **`PROXY_WORKER_SLOT` 刻意不在本表**：它是 **cluster 派发的槽位号**，不是配置项（不进 `ConfigStore`、不参与 `loadConfig`、不打印在 `logConfig` 的快照里）。塞进 `FIELDS` 会让 `tests/setup-env.ts:CONFIG_ENV_KEYS` 的「与 FIELDS 逐项相同」断言与「env 名唯一真相源」都失去意义。唯一写入方是 `server/cluster.ts` 的 fork，消费方是 `core/traffic/ledger.ts:normalizeSlot`（槽位**会被拼进文件路径**，故非 `1..9999` 纯数字一律按**路径穿越面**拒绝、回落 `"0"`）。完整传递链（CLI env 快照 → `runServer` → `ProxyServer` → `createProxyRuntime({ trafficWorkerSlot })` → `buildDefaultServices` → 账本）与「core/runtime 零 `process.env`」的理由见 `src/core/AGENTS.md` 的 traffic 一节。
- **`.env.example` 与 `tests/setup-env.ts:CONFIG_ENV_KEYS` 都必须跟着 FIELDS 走**：前者是部署模板（文件头声明「与 FIELDS 一一对应」并写了项数），后者清理宿主残留 env（漏一项 = 那个 env 静默漏进测试，表现为「本机红、CI 绿」）。后者已 `export` 并有断言：`tests/unit/quota-config-fields.test.ts` 断言它与 `FIELDS` 的 env 键集合**逐项相同**。

## 访问控制（ACL）

三组名单同住 `ACL_FILE`（`cfg/acl.json`），一次热加载、一次校验：

```json
{
  "clientIp": { "whitelist": ["127.0.0.1", "10.0.0.0/8"], "blacklist": ["203.0.113.7"] },
  "target": { "whitelist": ["*.example.com"], "blacklist": ["ads.example.net", "198.51.100.0/24"] },
  "upstream": { "whitelist": ["intranet.example.com"], "blacklist": ["127.0.0.1"] }
}
```

- 三组均可缺省（缺省 = 空名单，老文件无 `upstream` 键仍合法）；未知键 / 非法条目 → 默认启动校验中的 `loadConfig()` abort（`配置校验失败: ACL_FILE=<path> ...`）。
- **⚠️ 两条读取路径的「missing」判据**故意不同，别把它们当同一件事：① **热路径** `readJsonCached`（`utils/json-file/probe.ts:probeFile`）只有 `ENOENT`/`ENOTDIR`/非普通文件算 missing，其它 stat 错误（`EACCES` 等）判 `stat-error` → 保留上一份有效值并发 `error`；② **启动期**直读 `readAuthUsersAsync` / `readAclAsync`（各自模块私有的 `isMissingFile`）**只认 `ENOENT`**，其余任何读失败（含 `ENOTDIR`、路径是目录）都产出一个 `error` → `loadConfig()` abort。两条的**共同后果**相同且都是安全方向：绝不会把一份读不到的文件静默当成「空配置」，故 ACL 不可能因权限/形状问题静默变成全放行。
- **条目语法的唯一定义处是 `files/rules/`**：`files/acl.ts` 只校验顶层键与「whitelist/blacklist 是字符串数组」的形状，条目合法性一律交给 `rules/ip.ts:parseIpRule` 与 `rules/host.ts:parseHostRule`，判定交给 core 的 `ipMatches` / `hostMatches`。要加新条目形态只改 `files/rules/`，**不要**在 `acl.ts` 或 `core/access-control.ts` 里另写一套解析。
- `clientIp` 条目**只收 IP/CIDR**（对端永远是 IP，写域名属配置错误），按 **TCP 对端地址**（`socket.remoteAddress`）判定，**刻意不看 `X-Forwarded-For`/`X-Real-IP`**（客户端可伪造，那两个头只用于 auth 审计展示）。`::ffff:1.2.3.4` 归一化为 IPv4 再匹配（Windows/双栈必须）。
- `target` 条目收 **IP/CIDR/域名/`*.域名`**；`*.a.com` 只匹配 `a.com` 的子域、**不含 `a.com` 本身**（子域要单独写）；域名按**客户端请求的 host 字符串**匹配（小写、去尾点、剥方括号），**不做 DNS 解析**，条目**不支持端口**。所以「域名黑名单 + 客户端直接写 IP」能绕过——要两头都堵就两类条目都写。
- **`[::1]:443` 在条目侧仍判非法（fail-closed 刻意未放松）**：请求 host 侧的带端口 authority 由 `rules/host.ts:normalizeHost` 按 `]` 截断归一，但 `rules/ip.ts:normalizeIp` 只在**整体被方括号包裹**时才剥括号。所以 `[::1]:443` 写进任何 IP/CIDR 条目都会让 `parseIpRule` 返回 undefined（`target` 组里 `parseHostRule` 也会因域名正则拒掉 `::1`）→ 启动期 `validateAcl` 整组失败 abort；运行期 `compileIpRules`/`compileHostRules` 同样返回 undefined，交给 core fail-closed，而不是悄悄按 `::1` 放行。别为了「容错」在 `normalizeIp` 里加 `]:port` 分支。
- 语义（`clientIp`/`target` 两组一致）：黑名单命中 → **拒绝（优先）**；白名单非空且未命中 → 拒绝；皆空 → 放行。
- `upstream` 组（第三组，client 模式路由名单）**动作相反**：黑名单命中 → **直连**（优先）；白名单非空且未命中 → 直连；皆空（含整组缺失）→ 走上游。真值表：走上游 ⇔ 命中 whitelist ∧ 未命中 blacklist；**仅 `PROXY_MODE=client` 有意义**——server 模式由 `core/helpers/route:resolveRoute` 短路，不进判定。条目与 `target` 同形，判定对象同样是「客户端请求的目标」，上游地址永不进名单。命中直连的请求在 preDial 通过后打一条 info 级 `[route]` 日志（`target`/`route`/`reason`，机制见 `src/core/AGENTS.md`）。
- 被拒行为（**按判定层分两种，刻意不同**）：`clientIp` 拒 → HTTP/CONNECT/upgrade 回 **403 Forbidden**，**SOCKS 在握手前直接断开**（无协议应答，也不为被禁 IP 解析握手）；`target` 拒 → HTTP/CONNECT/upgrade 回 **403**，**SOCKS 回失败应答**（握手已解析完目标，此时断开而不给应答就是「客户端永远等一个不会来的字节」）。
- 被拒各打一条 warn：`[ip-denied]`（带 `client`/`reason`）或 `[target-denied]`（带 `target`/`host`/`reason`/`user`，**Phase 4b 起文本多一段 ` source=<global|user>`**，判定层没给 source 时文本与改造前逐字一致）。
- 判定入口全部在 `src/core/access-control.ts`：`checkClientIp(addr)`（`core/server/http.ts:handleForward()` 最先、`socks-base.ts:onConn()` 首行，均早于鉴权）、`checkTargetHost(host, user?)`（四条转发路径 http/tunnel/websocket/socks，均在目标已解析、尚未拨号处，紧邻现有 `isSelfLoop` 守卫；`user` 由 `ForwarderBase.preDial` 从 `scope.user` 注入）与 `checkUpstreamRoute(host)`（仅 `core/helpers/route:resolveRoute` 调用，client 模式路由判定）。**判定顺序**：clientIp → auth → target ACL（403，永不旁路）→ 路由判定 → 拨号。**判定对象永远是「客户端请求的目标」**：absolute-form 取 request-target 的 authority（RFC 7230 §5.4），缺失时回退 `Host`；**与 `proxyMode` 无关**——client 模式下拨号目标是上游，而上游的协议/地址/端口只来自 `UPSTREAM_*`、**永不进名单**。回归护栏见 `tests/integration/client-mode-acl.test.ts`。
- **每用户名单（`users.json` 的 `acl.target`）与全局 target 组合流（Phase 4b）**：`放行 ⇔ 全局 target 组放行 ∧ 该用户 target 组放行`。
  - **先全局、后个人、全局短路**：全局拒绝是**绝对**的——个人名单只能更严、不能更松，故全局拒时连 `users.json` 都不读；**两关都拒时报全局那一条**（`source:"global"`），因为全局是权威层，运维要先看到自己的全局配置问题，而不是「某用户碰巧也被全局禁了」。
  - 个人组与全局 target 组**语义完全同形**（黑名单命中 → 拒；白名单非空且未命中 → 拒；皆空 → 放行），且两层在 core 里**共用同一个判定函数**，不存在第二套语义。
  - 用户未配 `acl`（或用户不存在 / 未鉴权）→ 个人层**中性放行**，等价于只有全局生效。
  - 个人名单**绝不**参与 `clientIp` 组（判定发生在鉴权之前，那时没有身份——4a 的 fail-closed 理由）与 `upstream` 组（client 模式的路由决策，与「你是谁」正交）。
  - 拒绝时 `AclDecision.source` 标明是哪一层（`"global"` / `"user"`），`reason` 仍**只是** `whitelist|blacklist`。落盘 `[target-denied]` 行会多出 `source=…`（`user` 字段本来就在），运维据此知道该改 `acl.json` 还是 `users.json`。
  - 护栏：`tests/unit/user-acl-merge.test.ts`（3×3 优先级真值表穷举、闭合 `reason`、无身份即无个人层、不越界、热加载、零分配、事件 source 透传）+ `tests/integration/user-acl-enforcement.test.ts`（四条路径各一条「被个人名单拒」+ 恰好一条事件、全局优先、两次 preDial 不重复发事件、不重启即生效）。
- **热加载**：`cfg/acl.json` 与 `cfg/users.json` 都经 `utils/json-file/index.ts:readJsonCached` 做**每文件最多 1s 一次的 stat 节流**（`maxAgeMs=1000`、`maxBytes=1MiB`），缓存键严格为 `label + path`；改动最多 1s 生效、**无需重启**。只有 `ENOENT`、`ENOTDIR` 或非普通文件算 missing；其它 stat 错误（如 `EACCES`）保留上一份有效值并发 `error`，不能把 ACL 静默变成全放行。相对路径进入缓存前先绝对化。读取器不持有 logger，只把状态迁移作为 `onEvent` 事件抛出；事件去重状态按 **onEvent 回调**隔离。runtime 将当前实例 logger 显式交给 `files/event-log.ts:createJsonFileEventHandler()`，再把同一 handler 注入 `core/access-control.ts:bindAclFileEvents` 与 `auth-users` 读取面：坏内容保留上一份有效配置（warn）、已加载文件消失（warn）、恢复/内容变更热加载（info）。每行带 `pid` 与可用时的 `mtimeMs`/`size`（missing 无版本字段）；cluster 各 worker 独立加载、独立记录。
- **ACL 编译缓存按 accessor 隔离**：`core/access-control.ts` 的 `compiledCaches`、`userTargetCaches` 与 `fileEventHandlers` 都是 `WeakMap<ConfigAccessor, ...>`（个人层多一层 `Map<username, …>` 分槽），每个 context/runtime accessor 各记一份编译结果；不同实例即使路径相同也不互相挤掉或串用名单。stop 时 runtime 退订 store 与 ACL 文件事件，不碰其它 accessor。
- 两个文件含密码/名单，`.gitignore` 已忽略 `cfg/users.json` / `cfg/acl.json`，仓库只提交 `cfg/users.json.example` / `cfg/acl.json.example`。

## 两种模式的分工

| 场景             | 入口                                                                                              | 落点                                       | 宿主副作用                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| CLI / 自建可执行 | `cli.main()` 快照宿主来源 → `loadConfig` → `createLogger` → `runServer(context, logger, noColor, workerSlot)` | 本进程独占 `ConfigStore` + `ConfigContext` | 仅 CLI 组合根读取 env/argv/cwd/NO_COLOR；加载器不写 `process.env`；server 层才安装守卫/信号/cluster |
| 库 / 嵌入第三方  | `await loadConfig({ env, envFiles, argv, cwd, store })` 或直接 `new ConfigStore(...)`             | 调用方 store / runtime 私有 store          | 无进程监听、无输出、无 env/argv 猜测；可完全跳过文件 IO                                             |

## 本目录 Gotchas

- **import `load.js` 绝不初始化配置**：唯一 import 护栏 `tests/unit/config-loader-import.test.ts` 先放入非法宿主 env，再动态 import `loadConfig`；import 与显式空来源调用都不得读取/污染宿主 env 或预改 store。`tests/unit/config-loader.test.ts` 另覆盖省略来源、文件顺序、优先级、argv 三种写法与原子失败。
- **无第二套 argv 解析入口**：argv 只有 `sources/argv.ts:parseRawArgv` 一处实现，`loadConfig` 是唯一把它变成配置的入口。历史上的 `parseStartupArgs()` 已删除（生产零调用，纯重复的第二入口），argv 归一与字段解析的回归护栏改为经 `loadConfig` 断言。
- **`ConfigStore` 零 IO**：值从哪来永远由构造参数或 `loadConfig` 决定；实例化不执行 FIELDS 解析、范围、文件或 auth 交叉校验。
- **名单原语只有一份，住在 `files/rules/`**：`src/utils/ip-list.ts` / `host-list.ts` 已删除，`@/utils` 侧只剩文本原子 `@/utils/host-text.ts`。自环判定（`core/helpers/self-loop.ts`）、SOCKS 出站格式化（`core/forward/socks.ts`）、拨号前归一（`core/forward/dial.ts`）都从 `@/config/files/rules/index.js` 取 `normalizeIp`/`normalizeHost`/`ipToString`/`ipv6BytesToString`——**core 依赖 config 的规则层是既定方向**，别为了「utils 才是底层」把它搬回去，那会重新引入「通用工具知道 acl.json 业务概念」的问题。护栏见 `tests/unit/acl-rule-ip.test.ts` / `acl-rule-host.test.ts`（断言不得改，只许改 import 路径）。
- **`UPSTREAM_URL` 契约只有一份，住在 `schema/upstream-url.ts`**：`FIELDS.upstreamUrl.parse`（校验）与 `normalize/upstream.ts:applyUpstreamUrlToConfig`（拆项 + warning）两处调用同一个 `parseUpstreamUrl`/`applyUpstreamUrl`，改 URL 语义只改那一个文件；缺省端口引 `utils/constants`，不许内联 80/443。
- **`ConfigContext.config` 是初始冻结快照**，不是 live store 的替代品；热读必须经 `context.accessor` 或 `context.store`。
- 开发环境 `.env.development` 开启了 `uid` 鉴权且指向 `./cfg/users.json`：账号表为空会**启动即 abort**，所以首次必须先 `cp cfg/users.json.example cfg/users.json`（该文件已被 `.gitignore` 忽略，仓库只提交 `*.example`）。
- `proxyMode` `server` vs `client` 决定 `resolveRoute` 的有效模式（server 读 URL/Host 直拨；client 拨 `upstreamHost`/`upstreamPort`，但 `upstream` 路由名单命中即回落直拨真实目标）——见 `src/core/AGENTS.md`。
- 无全局回归护栏：`tests/unit/config-store.test.ts` 断言模块不导出 `defaultConfigStore`；`tests/unit/config-access.test.ts` 断言两个 accessor 隔离、热改现读、`ProxyOptions.ctx`/auth/路由必须显式注入；`tests/unit/config-instance.test.ts` 锁定 context/accessor 隔离与快照冻结；`tests/unit/library-entry.test.ts` 与 `tests/library/entry.test.ts` 断言包入口没有 `get/getAll/set/globalConfigAccessor`。
