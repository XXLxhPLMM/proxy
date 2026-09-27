# src/config — 配置 schema / 状态 / 加载器

## 路径说明

按**职责**分层，每层一个文件夹或一个单一职责文件；依赖严格单向，由下至上：

| 文件 / 子目录 | 装什么 | 判据 |
|---|---|---|
| `types.ts` | 字段契约 | **纯类型、零运行时值**，可被任何层安全 type-only 引用 |
| `store.ts` | 唯一配置状态 `ConfigStore` + `defaults` 种子 | 全部实例方法、零模块级状态、**零 IO 零校验** |
| `schema/` | 字段元数据 `FIELDS` + 解析原语 + 校验 + `UPSTREAM_URL` 字段契约 | 只描述「一个字段是什么」，**不认识来源**（不读 env/argv/文件）→ [`schema/AGENTS.md`](./schema/AGENTS.md) |
| `sources/` | 外部输入 → ENV 风格键值 | 每个函数都**要求显式入参**，零 `process.env` / `process.argv` → [`sources/AGENTS.md`](./sources/AGENTS.md) |
| `normalize/` | 配置副本的路径 / `UPSTREAM_URL` 归一 | 纯内存、**只写副本** → [`normalize/AGENTS.md`](./normalize/AGENTS.md) |
| `context.ts` | `ConfigAccessor` 只读端口 + `ConfigContext` 冻结快照 + 唯一的 context 工厂 | 消费者拿到配置的**唯一面** |
| `files/` | 磁盘配置资源（`users.json` / `acl.json`）+ 热加载事件日志 | 只取数据与形状校验，**不做判定** → [`files/AGENTS.md`](./files/AGENTS.md) |
| `files/rules/` | 名单**条目语法**层（IP/CIDR 编译 + 主机/通配匹配） | 零配置依赖、零 IO、零日志 → [`files/rules/AGENTS.md`](./files/rules/AGENTS.md) |
| `presets.ts` | 配置预设（`name + Partial<AppConfig>`） | 打包**配置值**；与 `src/runtime/presets.ts` 的 `StartupPreset`（装配）完全无关，名字刻意错开 |
| `load.ts` | **唯一** async 加载器 | 唯一做 IO 编排的入口，import 期零副作用 |
| `index.ts` | 唯一对外 barrel | 跨目录只引它 |

**不属于本层**：请求期名单判定（`src/core/access-control.ts`，`AccessControl` 端口的唯一内置实现）、配额耗尽判定（`src/core/traffic/`）、`process.env` / `process.argv` / `cwd` 的采集（只在 `src/cli.ts:main()`）。

## 硬约定

- **跨目录只引 `@/config/index.js`**，禁止 `@/config/store.js`、`@/config/files/users.js`、`@/config/context.js` 这类深路径——目录重构时调用方必须零改动。**barrel 缺什么就往出口加，不要在调用方开深路径口子。** 唯一例外见下方决策 4。
- **目录内部一律相对路径**（`./store.js`、`../schema/fields.js`），**禁止自我引用 barrel**（`config/` 内部不得出现 `@/config/index.js`）。
- **配置状态只有 `ConfigStore`**：无模块级 config Map、无 `get/getAll/set` 模块级函数、无 `defaultConfigStore`、无 `globalConfigAccessor`。`ConfigAccessor` **只有泛型 `get`**——没有 `getAll`、没有 `set`、没有隐式全局回退。
- **`ConfigStore` 零 IO 零校验**：值从哪来永远由构造参数或 `loadConfig` 决定；实例化不执行 FIELDS 解析、范围校验、文件读取或 auth 交叉校验。`getAll()` 恒返回**新对象**（浅拷贝），调用方 mutate 不得影响 store。`merge(patch)` 返回实际变更的键。
- **库入口零副作用**：`import "@b-hole/proxy"` 绝不读 `.env`/`argv`/宿主 env、绝不写 `process.env`。`loadConfig` 只消费调用方显式给出的 `env`/`envFiles`/`argv`（省略分别为 `{}`/`[]`/`[]`），**绝不回落 `process.env`/`process.argv`、也不扫描 `.env.*`**；只有 `cwd` 省略才用 `process.cwd()`。
- **原子落库**：`loadConfig` 的编排顺序是 `sources/` → `schema/` → `normalize/` → `files/` → **唯一一次** `store.merge()` + `createConfigContext()`，每步只操作局部副本。全部校验成功后一次 merge，失败时传入的 store 保持原样，**绝不产生半份状态**。
- **`config → core` 允许且仅允许 type-only 引用**，共三处：`types.ts` 与 `schema/upstream-url.ts` 引 `@/core/types/proxy.js:ProxyProtocol`（协议联合的单一真相源），`files/users.ts` 引 `@/core/traffic/index.js:QuotaWindow`（窗口键的口径）。再加一处的判据**三条全要满足**：① `import type`（编译期擦除，零运行期依赖边）；② 收口到 barrel 而不是深层实现路径；③ 符号是**契约的单一真相源**（协议联合、窗口字面量集），**不是**行为或判定。**运行期依赖（值 import）一律禁止**——`@/core/traffic/index.js` 的 barrel 里全是值导出，改成值 import 会让 config 在 import 期把 core 整条链拉进来。
- **`FIELDS` 表是 env 名的唯一真相源**，不许在别处再建第二张表。新增配置：`types.ts:AppConfig` + `store.ts:defaults` 加字段 → `schema/fields.ts:FIELDS` 加**一行**（`phase` 必填）→ `.env.example` 与 `tests/setup-env.ts:CONFIG_ENV_KEYS` 各加一项（护栏断言两者与 `FIELDS` 逐项相同；漏后者表现为「本机红、CI 绿」）。`src/core/types/proxy.ts:ProxyProtocol` 与 `types.ts` 保持同步。
- **访问控制判定不在本目录**：名单数据在 `files/acl.ts`，**条目语法**（什么算合法条目、怎么命中）在 `files/rules/`，请求期判定在 `src/core/access-control.ts`。改名单**语义/动作**动 core，改**文件格式与条目语法**动 `files/`。
- **`env` 的影响全部收敛在 `loadConfig`**：库层（`createProxyRuntime` / `runtime/presets.ts` / 连接器 registry）再读一次就是「协议由两处决定」的第二真相源，且**没有任何日志或事件**能解释那个差异。
- `ConfigStoreReader` 是 `configAccessorFromStore` 的最小结构要求（只要 `onChange`），`ConfigAccessor` 的任何消费者都不该反向拿到 store 写面。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

**有断言锁住的裁决一律不写在这里**——它们的结论、否掉了什么、为什么、以及逐字锁点分布在：
`tests/unit/config-instance.test.ts`（`ConfigStore` 能用**任意子集** / `startupKeys` 恒取完整
`keysByPhase().startup` / `context.config` 是冻结初始快照 / `getAll()` 新对象与 `merge` 只报实际变更 /
`resolveConfigPaths` 只按 `FIELDS` 的 `path: true` 判）、
`tests/unit/config-loader.test.ts`（`ConfigSourceMetadata` 只含 `envKeys`/`argvKeys`/已绝对化的 `envFiles`）、
`tests/unit/proxy-runtime.test.ts`（**零校验那一半的牙齿**：构造期跑 `FIELDS` 校验的话
`.toThrow("未知代理协议: ftp")` 会被另一条消息顶掉而红）、
`tests/integration/upstream-protocol-fail-closed.test.ts`（库路径把 `"ftp"` 塞进 store 的**后果面**）、
`tests/unit/traffic-ledger.test.ts`（`hasConfiguredQuota` 由 `runtime/services.ts` 从 config 层转出；
`PROXY_WORKER_SLOT` 刻意不进 `FIELDS`）。要查「那条断言锁什么」，去那个文件的头注释。

1. **`config → core` 的三条出边记在 config 侧、不记在 `src/core/AGENTS.md`** — 否掉「违规只归到被依赖方」— `core/AGENTS.md` 答的是「core 允许引什么」，本文件答的是「config 允许往哪引」；只记一半的人会以为 `config → core` 一定是写错了，然后**复制一份字面量联合**（那才是真正的事故）。违规总在依赖方向的上游被先看到。⚠️ **这条本身没有断言**（它是**文档放哪儿**的裁决，测试测不了）；被它描述的**规则**有牙齿：`tests/unit/traffic-ledger.test.ts` 的「`config → core` 的边只允许 `import type`」钉住 `types.ts` 与 `files/users.ts` 两处——但**只钉这两处**，`schema/upstream-url.ts` 那条边至今无人断言。
2. **`sources/` 对外只出 `defaultEnvFileNames`** — 否掉「`readEnvFiles`/`parseRawArgv`/`getConfigDir` 一起出」— 没有跨目录调用方的就是编排内部件；出口膨胀会让「删掉一个内部函数」变成破坏性变更。同理 `normalize/` 只出 `prepareRuntimeConfigStore`。⚠️ **没有任何断言**：`@/config/index.ts` 与包入口的导出面都**没有**被逐项枚举过——`tests/library/entry.test.ts` 只钉「必须出的那批在」，不钉「多出来的没有」。往 barrel 里加一个内部件，全仓绿。
3. **`UPSTREAM_URL` 拆项的入口只有 `normalize/upstream.ts:applyUpstreamUrlToConfig` 一个** — 否掉「塞进 `createConfigContext`」— 那会造出第三套入口，破坏「`loadConfig` 与纯内存 runtime 对同一 URL 永不出不同结果」这条不变量。⚠️ **没有任何断言**（详见 [`normalize/AGENTS.md`](./normalize/AGENTS.md) 决策 1 的同一条警告：入口数量不可观测，有牙齿的是「结果一致」与「不半写」那两条）。
4. **`files/rules/index.js` 是唯一的第二出口，刻意不进 `@/config/index.js`** — 否掉「并入配置 barrel」— 它服务的是 core 的判定层（`access-control.ts`、转发层、自环判定），不是配置 API；混进配置 barrel 会让「配置 API」这个出口的含义随 core 的需求漂移。⚠️ **没有任何断言**：core 侧四个调用方是否只从这一个 barrel 取、barrel 里有没有多出别的东西，**都没有任何扫描**。往下条看。
5. **只允许 `@/config/files/rules/index.js` 一个第二出口，且必须收口到 barrel** — 否掉「core 侧引 `@/config/files/rules/ip.js`」— core 依赖 config 的规则层是**既定方向**（别为了「utils 才是底层」把它搬回 `@/utils`，那会重新引入「通用工具知道 acl.json 业务概念」）。⚠️ **没有任何断言**：`tests/unit/acl-rule-ip.test.ts` / `acl-rule-host.test.ts` 走的是 barrel，但那只证明「barrel 可用」；`tests/unit/auth-users.test.ts` 的源码级断言只覆盖 `config/files/users.ts` 一个文件（「`from "./rules/index.js"`」+ 全文 `parseHostRule(` 恰好一处 + 零 `parseIpRule`），**core 那四个文件从未被扫过**。core 侧改深路径引用，全仓绿。
6. **`phase` 在每个 `FIELDS` 行必填** — 否掉「从 `get()` 的调用位置推导」— 那会让「哪些改动需要重启」沦为调用位置的偶然产物。`loadConfig` 把 startup 键名写进 `context.startupKeys`，runtime 构造时固定这些键的启动值、之后只发 `config.restart-required`。⚠️ **这是编译期约束、不是运行期断言**：`FieldDef.phase` 必填（`pnpm typecheck` 兜），但「每一行都写了」没有遍历断言。有牙齿的是**具体字段的相位**（`tests/unit/quota-config-fields.test.ts` 钉 `quotaLedgerDir` 是 startup，另两个是 runtime）与 `startupKeys` 恒取完整集合（`tests/unit/config-instance.test.ts`）。
7. **加新文件前先自问「它是配置状态、来源、还是判定」** — 判定类一律去 `src/core/`。判据是**依赖方向**：`core → config` 是允许的，反过来就必须靠「type-only + 契约单一真相源」两条窄门，而门一多，「只准加一处」会退化成「又加了一处」。⚠️ **没有任何断言**（纯设计判据）。
