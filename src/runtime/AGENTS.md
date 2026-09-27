# src/runtime — 第三方库门面

把仓库当库嵌入时的**唯一公开装配层**：接上调用方给的 `ConfigContext`（共享 live store）或纯内存 `config`/`preset`（内部私有 store），连同服务替身、上游连接器、启动预设、事件总线与日志端口，连到协议核心。**进程策略（信号 / 守卫 / banner / 退出）不在本目录**——那是 `src/server/` 的事。

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `runtime.ts` | `createProxyRuntime` / `ProxyRuntime` 门面、`activateSubscriptions` / `releaseSubscriptions`、`isProxyProtocol` | `start()` / `stop()` **只委托给 `BaseProxy` 的幂等状态机**，不另造 listen/close/排空逻辑。⚠️ **全项目只有两行允许做依赖缺省解析**（`options.logger ?? createNoopLogger()` 与 `options.events ?? new EventHub(...)`） |
| `services.ts` | `buildDefaultServices`（**全项目唯一解析默认服务实现的地方**）、`hasConfiguredQuota` / `hasConfiguredAcl` / `isAccessOverridden` | `RuntimeServices` 四项（`identity` / `access` / `traffic` / `trafficLedger`）形状统一：**配置驱动的默认实现 + 可覆盖替身** |
| `context.ts` | `RuntimeContext`（三件套持有者，`implements CoreContext`） | 构造参数 `{ config, logger, events }` **三项全必填、零兜底零懒初始化** |
| `presets.ts` | `StartupPreset` / `defineStartupPreset` / `registerStartupPreset` / `pickStartupPreset` / 6 个内置协议预设 | 消费点在**构造期**——协议与连接器都是 startup 事实，构造后不再变。**导入期零副作用**（只建内置字面量 + 一张内存 `Map`） |
| `bridge.ts` | `pipe` 三个公开形状 → 公共 `AppEventMap`（**库事件面**） | 只桥接 `ip-denied` / `target-denied` / `route` 三条；core 直发的 8 个公共事件**不经此桥接** |
| `event-log.ts` | `bindProxyEventLogs`（11 类）+ `bindLifecycleLog`（`[lifecycle]` 一行）（**日志面**） | 零 `process` 触点，纯 `hub.subscribe` + `logger.*` 注入 |
| `index.ts` | 目录 barrel | 跨目录只引 `@/runtime/index.js` |

**不属于本层**：配置解析来源（`src/config/`）、协议实现与连接排空（`src/core/server/`）、进程策略（`src/server/process.ts`）。

## 硬约定

- **零副作用铁律**：构造 runtime 不得读 `process.env` / `process.argv` / `.env` / 配置文件，**不得写 `process.env`、stdout/stderr、日志文件，不得注册 `process` 事件，不得 `process.exit`，不得用 cluster**。⚠️ **缺省 logger 必须 `createNoopLogger()`**——「库默认替我建个会写文件的 logger」不在授权范围内。
- **不得 import `@/config/load.js` 或 `@/server/index.js`**。CLI 采集宿主来源并调加载器，server 管进程治理，库门面只接受显式 `context` 或纯内存 `config`/`preset`。
- **配置状态只来自 context 的调用方 store 或 runtime 私有 `ConfigStore`**，经当前实例 accessor 注入 core。**不存在 CLI 全局 `get` / `set` 或默认配置 store。**
- `runtime.options`（含 tls 对象）、`runtime.services`、派生 accessor 是**只读冻结视图**；store 后续修改只发布事件、**不重建 core**。
- `bridge.ts` 与 `event-log.ts` **互不 import**，是两张面。⚠️ **「静态 re-export 了 `event-log.ts`」不等于「import 期就在落盘」**。
- **退订闭包必须自带归属**（靠闭包持有自己的 hub 记录，对另一个 hub 调用等于静默空操作），**绝不许改用 `hub.removeAll()`**——总线可能属于宿主，连带清掉别人的订阅就是越权。
- `AGENTS.md` 一律零 `as unknown as`：`bridge.attach()` 与 `RuntimeContext` 都收**强类型 `CoreContext`**，改 `ProxyOptions.ctx` 形状由编译期兜住。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

**有断言锁住的裁决一律不写在这里**——27 条，它们的结论、否掉了什么、为什么、以及逐字锁点分布在：
`tests/unit/startup-preset.test.ts`（零 `process.env`/`argv`；未注册预设名 fail-closed 抛错；
非法 `proxyProtocol` 合成出的那份**不带 protocol**；`assembly` 三条纪律——`services` 逐字段合并 /
零 `process.env` / 内置只有 6 个协议预设且每个只声明 `protocol`+`description`；
`assembly.protocol` 覆盖**不豁免**校验，含「`protocolFor(config)` 排在 `assembly?.protocol` 判定之前」
那条源码级次序断言）、
`tests/unit/proxy-runtime.test.ts`（入站协议构造期抛 `未知代理协议: ftp`；
runtime 绝不再自己发 `lifecycle.changed` 且顺序恒为「`lifecycle.changed` 在前、派生的 `runtime.*` 在后」；
`stopped` 跃迁仍能发出 `runtime.stopped`；只有自建 `EventHub` 才 `removeAll()`、每次后续 `start()` 重建全套）、
`tests/integration/library-event-log-binding.test.ts`（事件→落盘的整套绑定住本目录；
`options.eventLogs` 缺省必须是 `true`；`activateSubscriptions`/`releaseSubscriptions` 是唯一权威；
幂等由清空订阅数组本身提供、退订闭包自带归属）、
`tests/integration/lifecycle-log-binding.test.ts`（`[lifecycle]` 那一族与 `bindProxyEventLogs` 同判据
——「是 CLI 文本契约」不构成不同判据的理由；`src/**` 全文恰好两处 `bindLifecycleLog(`；
worker 门必须在装配点、判据是调用方申报的 `isWorker`）、
`tests/unit/core-event-bridge.test.ts`（请求头掩码必须早于 publish；桥接缺失即跳过、绝不臆造
——`reason` 缺失/空串不发布、`source` 不倒填 `global`、表外 `reason` 原样透传；
`pipe: target-unresolved` 刻意不桥接；桥接器只认 pipe 载荷、完全重建 context）、
`tests/unit/pipe-event.test.ts`（两条 quota 事件刻意不进 `PipeEvent` 判别联合）、
`tests/integration/acl-inert-warning.test.ts`（`isAccessOverridden` 用模块级 `WeakSet`、
判据取实例身份而不是 `instanceof`；`acl-inert` 判据是两个都必须成立的 AND；
「读失败 → false」是刻意取舍；两条告警都只报一次）、
`tests/integration/traffic-quota.test.ts`（`quota-inert` 收窄到「真的配了非零配额」∧ `authEnabled === false`）、
`tests/unit/traffic-window.test.ts`（`TrafficWindowSource.resetHour` 是经当前 accessor 的闭包，每次访问现读）、
`tests/unit/traffic-ledger.test.ts`（两个默认服务判据函数由 `runtime/services.ts` 转出）、
`tests/library/entry.test.ts`（`ProcessPolicy` 刻意不扩到本目录；`createIdentityFromConfig` 第一个形参是
`CoreContext`；`createFileAccessControl` 刻意只收 `config`）。
要查「那条断言锁什么」，去那个文件的头注释。**下面九条全是「无牙齿」或「只锁了一半」的**。

### 无牙齿（必须留在这里）

1. **两跳（`bridge` / `event-log`）都从 `ctx.events` 取总线，不从构造期的 `options.hub`** — 否掉「构造时定死」— `RuntimeContext.setEvents()` 能在运行期换总线而 core 发布时读的也是 `ctx.events`，取错就是「core 发新总线、这一跳听旧总线」→ **静默丢整段事件/日志**。⚠️ **没有任何断言**：`tests/unit/core-context.test.ts` 钉的是 `setEvents` 之后**runtime 自己**发布到新总线，**没有一条**在换总线之后检查「bridge 与 event-log 这两跳还收不收得到」。两跳改读构造期引用，全仓绿。
2. **`context` 与 `config`/`preset` 是类型上互斥的两种来源** — 否掉「两个都收」— 生命周期不同：一个共享调用方 live store，一个内部私有 store，混起来就说不清「这次改的是谁的状态」。⚠️ **只锁了一半**：互斥由 `pnpm typecheck` 兜（同时给两个编译不过），但「纯内存 `config` 模式能把 `"ftp"` 塞进 store」这个**代价**是有牙齿的（`tests/unit/startup-preset.test.ts` + `tests/integration/upstream-protocol-fail-closed.test.ts` 都在库路径注入非法值），**代价有牙、选择无牙**：改成两个都收并优先 `context`，那两处注入非法值仍会走到 `protocolFor` 抛错，全仓绿。
3. **账本三件事绑在一起** — ① `JsonlTrafficLedger` **构造零副作用**（只 `path.join` 算文件名、**不 stat 磁盘**），目录/句柄/定时器全由 `start()` 触发的 `ledger.open()` 创建（否掉「构造时建目录」，与零副作用铁律同向）；② **调用方显式注入 `services.traffic` 时 `trafficLedger` 恒为 `undefined`**（那一本账归调用方管，不写它的文件、不给它起定时器、也不发它的落盘事件）；③ **恢复回注两步走**——`new MemoryTrafficAccount(...)` 必须在 `account.bindSink(ledger)` **之前**，顺序反过来就得写「用前未赋值」的闭包。⚠️ **只锁了 ②**：`tests/unit/startup-preset.test.ts` 的 `expect(runtime.services.trafficLedger).toBeUndefined()` 与 `tests/integration/traffic-ledger-runtime.test.ts` 钉住它。① 与 ③ **没有任何断言**：把 `mkdir` 搬进构造函数（`tests/unit/traffic-ledger.test.ts` 那些用例都显式 `await h.ledger.open()` 之后才断言目录，全绿），或把 `bindSink` 挪到构造 `ledger` 之前，全仓绿。
4. **「绑了」≠「有落盘」** — 落盘还取决于有没有注入真实 logger。配了 `logFile` 却没显式 `createLogger({ config })`，缺省 `true` 也照样**一行不写**。**`LOG_FILE` / `LOG_FILE_LEVEL` 是 _logger_ 的配置、不是 runtime 的。**（这条是发布前 tarball 烟测实测撞出来的，第一次端到端跑完 jsonl = 0。）⚠️ **没有任何断言**：全仓没有一条用例「配了 `logFile` 但注入 noop logger，断言落盘目录零字节」。`tests/integration/library-event-log-binding.test.ts` 第 ③ 档证明的是「`eventLogs: false` → 零行」，那关的是**订阅**不是 **logger**。
5. **日志端口类型是 `Logger` 接口而不是 `LoggerImpl`** — 否掉「绑死实现类」— 落盘要能对**任何**注入的 logger 生效；`Logger` 的末位 plain object 参数即结构化字段，端口类型已经够用。⚠️ **不得因此去 import `LoggerImpl`**（那是 `utils/` 的实现类）。⚠️ **没有任何断言**：`expectTypeOf<Logger>()` 那一族只证明 `Logger` 这个**类型名**在包入口导出，不证明任何函数**收**它而不是 `LoggerImpl`；`src/**` 也没有「`runtime/` 零 `LoggerImpl`」这类扫描（`event-log.ts` 的扫描只禁 `process.*`）。把 `bindProxyEventLogs` 的形参改成 `LoggerImpl`，全仓绿。
6. **账本开在 `core.start()` 之前、收在 `proxy.stop()` 之后** — 开早了：「先收流量再恢复」会让本进程的增量与恢复出来的账**互相覆盖**（两者读同一个文件）。收早了：排空期间还有在途字节在计量。⚠️ **`openTrafficLedger()` 抛错绝不让启动失败**（账本是增强面，磁盘坏了不该让代理起不来；失败事实已由账本自己经 `onLedgerError` 上报）。**停机落盘是正确性要求**：队列里「已计入内存判定、还没进磁盘」的字节丢掉的话，用户靠反复「用一点、Ctrl+C」就能把配额窗口内的额度一次次刷新——所以它排在 `releaseSubscriptions()` **之前**（`onError` 要经总线发 `traffic.ledger-error`）。⚠️ **只锁了中间那半句**：`tests/integration/traffic-ledger-runtime.test.ts` 的「账本目录不可用 → 一条 `traffic.ledger-error`，且 `start()` 不抛」钉住「抛错不让启动失败」；**「开在 `core.start()` 之前」与「收在 `proxy.stop()` 之后」这两个次序没有任何断言**（把 `openTrafficLedger()` 挪到 `core.start()` 之后，或把 `closeTrafficLedger()` 挪到排空之前，全仓绿——现有的落盘断言只看**文件最终有内容**，不看它是在哪一步写的）。
7. **两条告警（`quota-inert` / `acl-inert`）都排在账本与 `core.start()` 之前** — 它们是「一次性事实」，要在任何可能抛错的步骤之前报出去，否则启动失败时运维连「配置有洞」都不知道。判据一律是**文件事实**不是猜配置，文案取 `core/log-events.ts` 的常量（与 CLI 落盘行是同一句话，**两边各抄一份就会出现文档说 A、日志说 B**）。⚠️ **只锁了「同一句话」那半句**：`tests/integration/acl-inert-warning.test.ts` 与 `tests/integration/traffic-quota.test.ts` 各自断言 `[acl-inert]` / `[quota-inert]` 落盘行**逐字等于**文案常量。**「排在账本与 `core.start()` 之前」这个次序没有任何断言**——现有用例全都 `start()` 成功才去看 warnings，没有一条在 `start()` **抛错**的场景下检查告警是否已经报出。
8. **`ConnectorSource` 整个 runtime 生命周期只解析一次** — 否掉「按需解析」— `upstream()` 会**记忆** `upstreamProtocol`（startup 相位），解析两次就有两个 source 各记一份协议，「一个进程一个真相源」当场被破。⚠️ **必须落在 `createProxy` 之前**（协议核心的实例化只有那一次机会）。与 `BaseProxy` 构造期的缺省档刻意同构、**刻意不做配置驱动的二次解析**。⚠️ **没有任何断言**：`tests/unit/startup-preset.test.ts` 那条「`connectors`：两侧都没有时走 `createConnectorSource(ctx)` 缺省」里有一行 `expect(runtime.options.connectors).toBe(runtime.options.connectors)`——那是**恒真的空断言**（`toBe` 自己跟自己永远相等），**不构成「只解析一次」的任何证据**。把缺省档改成每次现造一个新 source，全仓绿。
9. **协议合法性的判据只有 `isProxyProtocol` 一份，用 `hasOwnProperty` 而不是 `in`** — `in` 会沿原型链把 `"toString"` / `"constructor"` 这类**注册项名**当成合法协议。⚠️ **别再从 `PROTOCOL_PRESET_TABLE` 的键派生第二份**——那份 `satisfies` 是「每个协议都得有具名预设」的穷尽性护栏，与「什么值算合法协议」是两件事。**也刻意不新增 `STARTUP_PRESET` 配置键**：为一个 preset 去动 `FIELDS` + `defaults` + `.env.example` + `setup-env.ts` + 两条护栏共六个文件，换一个已有键能做的事，不划算——**选协议服务器用 `PROXY_PROTOCOL`**（它本来就是这个职责的 env 键），**要具名装配就程序化传 `assembly`**。⚠️ **没有任何断言**：`isProxyProtocol` 这个符号**全仓零测试引用**，把 `hasOwnProperty` 换成 `in` 全仓绿（没有任何用例传过 `"toString"` / `"constructor"` 这类原型链上的注册项名）。「不从预设表派生第二份」与「不新增 `STARTUP_PRESET`」是纯成本论证，也无断言。

## ⚠️ 已知缺口（**不要假装已修**）

- **三个 setter 的调用方全在库调用方**，`src/` 内零调用是**预期形态**、不是死代码——`ProxyRuntimeImpl` 把 `RuntimeContext` 经 `services` / `ProxyOptions.ctx` 暴露出去，这三个 setter 是库调用方唯一能在运行期热换配置 / 日志器 / 事件总线的入口；**删掉它们库调用方就失去这个能力，而本仓测试一条都不会红**（没有调用方就没有覆盖）。⚠️ **推论**：正因为本仓内没人调 `setEvents`，`core/server/base.ts` 那两条「**绝不允许**把 `events` 缓存成字段」的强纪律**在本仓是靠注释与源码级断言维持的，不是靠运行时压力**。本仓能守的只有**接口可见性**（三个 setter 保持 public、`CoreContext` 只读视图上取不到它们），护栏 `tests/unit/core-context.test.ts` 的「三个 setter：库调用方的公开面」那组**不能**证明有人真的在用它——如实记为限制。
