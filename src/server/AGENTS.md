# src/server — 进程编排层

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `index.ts` | `ProxyServer` / `runServer` / `cliPreset` —— **CLI 进程壳** | 构造参数必含 `{ context: ConfigContext }`。**库调用方不要实例化 `ProxyServer`**，直接用 `createProxyRuntime()` |
| `cluster.ts` | 多进程 fork / ready / 退出编排 | 顶层**只定义函数**；`cluster.on`、`process.on`、fork、退出兜底全部在 `runAsMaster()` 内 |
| `process.ts` | **进程策略端口** `ProcessPolicy` + `cliProcessPolicy` / `managedProcessPolicy` + `cliPreset()` | 只回答一个问题：**本进程归谁管** |
| `process-guards.ts` | 进程守卫（`uncaughtException` / `unhandledRejection` / `warning`） | 只由 `process.ts` 惰性 `import("./process-guards.js")` |
| `log/config-log.ts` | `[config]` 配置快照（脱敏 secret / 口令 / 上游凭证） | `log/` 目录**只剩这一块** |
| `banner.ts` | `proxy started:` ready 面 + 启动 banner | ⚠️ **`scripts/gen-banner.mjs` 的生成物，勿手改** |

**不属于本层**：协议内部状态机（`BaseProxy`，`src/core/`）、`[event-code]` 事件词汇表与 pipe 事件文本（`src/core/log-events.ts`）、**事件 → 落盘的整套绑定（`src/runtime/event-log.ts`，判据与逐条映射见 `src/runtime/AGENTS.md` 的「有断言锁住的裁决」段）**、配置解析来源（`src/config/`）。

**本目录拥有的日志行只有那几条真需要「谁拥有这个进程」才说得清的**：`[config]` / `proxy started:` / `[shutdown]` ×2 / banner。

## 硬约定

- **本层不持有任何事件订阅**。两族绑定都由 `runtime/event-log.ts` 那个**自带归属的幂等闭包**承担，本类不存订阅数组、不存 `{ hub, subscription }` 那一对。对 `EventHub` 的使用只剩「注入的那条总线」与 `ProxyServerOptions.events`。
- **本层不读 `process.env` / `process.argv`**，也不调 `loadConfig()`、不创建配置状态。`trafficWorkerSlot` 由 CLI 从 env 快照显式传进来，一路透到 `createProxyRuntime({ trafficWorkerSlot })`。
- **`log/` 不要再塞事件词汇表或事件订阅**。事件词表的唯一直接调用方是 `core/server/*`（放这里就要求 core 反向依赖进程编排层）；事件订阅的唯一直接调用方是 `createProxyRuntime`（放这里就要求库调用方反向依赖进程层）。
- ⚠️ **「静态 re-export 了 `runtime/event-log.ts`」不等于「import 期就在落盘」**：那个模块只有函数定义与一张 `Record` 字面量表，绑定**只在 `createProxyRuntime(...).start()` 里**发生（`activateSubscriptions`），而默认 logger 是 `createNoopLogger()`。
- **库入口零副作用**：`src/index.ts` 的静态依赖不执行配置加载、cluster fork、守卫安装或任何日志写入；包入口明确不导出 `get/getAll/set/defaultConfigStore/globalConfigAccessor`。
- `runServer` / `ProxyServerOptions` / `ProxyRuntimeOptions` 三者形状**刻意统一**——都是「一个必填 `context` + 一个可选项对象」。`runServer` 本身**不采集宿主来源**。
- `clusterWorkers>1` 才 fork。master 与 worker **不共享内存 store**：每个 fork 出的进程重新进入 CLI 组合根、独立快照宿主来源、独立 `loadConfig()`。master 只负责编排。
- banner 由 `./banner.js:printBanner(logger, noColor)` 打，`index.ts` 单进程 ready 后与 `cluster.ts` master 汇总判据成立时各打一次，**重复就绪不重复打**。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

**有断言锁住的裁决一律不写在这里**——6 条，它们的结论、否掉了什么、为什么、以及逐字锁点分布在：
`tests/integration/library-event-log-binding.test.ts`（事件落盘绑定**不住**在进程编排层；
`ProxyServer` 源码面零 `bindProxyEventLogs` + 判据自检；`src/**` 全文恰好两处
`bindProxyEventLogs(` = `event-log.ts` 的定义 + `runtime/runtime.ts` 的那一个调用点）、
`tests/integration/lifecycle-log-binding.test.ts`（`[lifecycle]` 那一行不因「是 CLI 文本契约」而获得
不同判据；`ProxyServer` 源码面零 `bindRuntimeLifecycle` / `lifecycleSubscriptions` /
`unbindRuntimeObservers`；master-only 那道门靠 `ProxyRuntimeOptions.isWorker` 这条**显式通道**）、
`tests/integration/acl-inert-warning.test.ts`（`onWarning` 只接 `quota-inert` / `acl-inert` 两条白名单、
不整体转发，含「不许有兜底分支」的源码级断言与变异验证）、
`tests/unit/traffic-ledger.test.ts`（worker 槽位是稳定序号 `1..N` 而不是 PID；三条 fork 路径都走同一个
`forkWorker()`；零裸 `cluster.fork()`；写 env 而不是 `worker.send()`）、
`tests/library/entry.test.ts`（`process-guards` 与 `log/config-log` 必须保持**动态 import** 形态）。
要查「那条断言锁什么」，去那个文件的头注释。**下面八条全是「无牙齿」或「只锁了一半」的**。

1. **`ProcessPolicy` 端口只长在 `server/` 侧、不扩到 `runtime/`** — 否掉「把 `forceExit` 塞进 runtime 选项」— 那等于让库调用方拿到一把上膛的枪（一个 `process.exit(0)` 藏在「配置」里）。反向依赖 `runtime → server` 也被禁，所以进程位由 `ProcessStartupPreset extends StartupPreset` 在允许的那一侧补上。⚠️ **只锁了「库那侧没有」那一半**：`tests/library/entry.test.ts` 的 `expectTypeOf<StartupPreset>().not.toHaveProperty("process")` + `toHaveProperty`（`ProcessStartupPreset`）钉住形状分界；**「`runtime/` 不得 import `@/server/index.js`」这条禁令没有任何源码级扫描**（`tests/unit/dead-optionality-cleared.test.ts` 扫的是别的东西），反向依赖一旦长出来全仓绿。
2. **端口形状故意不对称：三个可选项省略即不装，`forceExit` 必填** — 否掉「四项都可选」— 「装不装」本身就是策略的表达，省略即语义；但 `forceExit` 留成可选等于允许「超时后什么都不做」，那正是长连接把停机永久挂死的那条路。**它是该端口唯一必填成员。** ⚠️ **没有任何断言**：`tests/library/entry.test.ts` 的 `expectTypeOf<ProcessPolicy>().toHaveProperty("forceExit")` 对**可选**成员同样通过；把 `forceExit` 改成 `forceExit?:` 全仓绿。真正有牙的是**编译期**：三个可选项省略即不装、必填那个漏了 `pnpm typecheck` 红。
3. **`SignalHost` 只交出回调方真正需要的四样** — 否掉「把 server 整个递出去」— 端口不是依赖倒置的遮羞布。⚠️ **`[shutdown]` 那两行由 `ProxyServer` 打、不由策略打**：前缀是 CLI 的落盘文本契约，不该跟着进程策略搬家；策略只拿到「退不退」这个动作。⚠️ **没有任何断言**：`SignalHost` 的成员数与形状只被 `expectTypeOf<SignalHost>().toHaveProperty("gracefulStop")` 覆盖**一项**；往端口里加第五个成员、或把那两行 `[shutdown]` 挪进策略，全仓绿。
4. **`cliProcessPolicy` = CLI 现状行为逐字保留，含看起来可疑但确实必要的细节** — 否掉「顺手统一」— 停机中再收信号只有**单进程**才强退（worker 的信号来自控制台广播、会与 master 的 IPC 同时到达，无法区分「同一次 Ctrl+C」与二次按键）；worker 另挂 `message:{type:"shutdown"}`，与信号等价且**只排空、绝不强退**。首次信号的 `exit(0)` **在 finally 里退**，保证排空失败也退。⚠️ **没有任何断言**：`tests/integration/AGENTS.md` 已记「Windows 上信号触发不了优雅停机」，所以本仓**没有任何进程级信号用例**；`managedProcessPolicy` 那条同理（见下条）。
5. **`managedProcessPolicy` 的代价是「长连接下 `stop()` 会挂死」，这是必然代价不是 bug** — 否掉「库偷偷替宿主退进程」— `forceExit` 的实现只是「打一条警告说明交还宿主」。要强退就显式覆盖 `forceExit`：**显式覆盖永远比「库偷偷替你退进程」诚实**。⚠️ **没有任何断言**（`tests/integration/AGENTS.md` 决策 1：Windows 上信号触发不了优雅停机，而可控 `stop()` 那条路又被本文件的已知缺口占着）。
6. **`cliPreset()` 只填 `process` 一个字段** — 否掉「把 CLI 的默认协议/服务钉进预设」— CLI 相对纯库调用方多出来的**只有「它拥有这个进程」**这一条。⚠️ **刻意不钉 `protocol`**：入站协议是**配置事实**（能被 argv/env 改），预设里写死一份会让覆盖失效——那是「预设压过显式配置」的第二真相源。同理不钉 `services` / `connectors`。⚠️ **只锁了形状**：`tests/library/entry.test.ts` 钉住 `ProcessStartupPreset` **有** `process`；「**只有** `process` 一个字段」这个「只有」**没有任何断言**——往 `cliPreset()` 里多填一个 `protocol` 全仓绿（`tests/unit/startup-preset.test.ts` 那些用例走的是 `defineStartupPreset`，不经过 `cliPreset()`）。
7. **`ProxyServer.stop()` 的 finally 四步次序是契约、且其中没有任何事件退订** — `unbindSignals()`（最前）→ `await closeTrafficLedger()` → `await logger.flush()` → `clearTimeout` — 事件订阅由 `runtime.stop()` 的 `releaseSubscriptions()` 在排空之后统一退（**那才是它们真正被装配的地方**），硬塞第五步只会让人误以为本层还挂着订阅。⚠️ `unbindSignals()` 排最前的原因：`installSignals` **返回**幂等退订函数，不摘的话「同一对象 stop → start → stop」会一层层叠加监听；而排在排空**之后**才有意义（finally 是 `await runtime.stop()` 落地才进的）——**排空途中收二次信号仍能强退，这是 CLI 现状行为**。账本排在 `flush()` 之前是因为 `process.exit` 会截断在途 append。护栏 `tests/integration/traffic-ledger-runtime.test.ts` **读真实文件内容**（不是 spy）。⚠️ **只锁了「停机时账本落到位」那一格**：那条用例断言的是「`await server.stop()` 之后文件里真有那批字节」，它**不区分**四步的任何次序——把 `unbindSignals()` 挪到最后、把 `closeTrafficLedger()` 挪到 `logger.flush()` 之后，全仓绿。「其中没有任何事件退订」那一半由 `tests/integration/library-event-log-binding.test.ts` 的「`ProxyServer` 源码面零 `bindProxyEventLogs`」+「`event-log.ts` 零 `eventDisposers`」**间接**兜住（那是「不持有订阅」，不是「finally 块里没有第五步」）。
8. **`ProxyServer.start()` 的八步次序是契约，不因进程策略注入位重排** — 守卫 → 配置日志 → 创建/接收 runtime → （落盘绑定由 runtime 内部装配）→ 绑信号 → `runtime.start()` → ready 面。配置日志依赖调用方已完成加载，**模块 import 本身不加载配置**。⚠️ **没有任何断言**：`src/server/index.ts` 的 `start()` 方法体**从未被做过次序扫描**（`tests/library/entry.test.ts` 只钉「入口不静态引 `@/server/` 内部实现」+ 两个动态 import 的形状）。把配置日志挪到 `runtime.start()` 之后，全仓绿——现有用例只看**最终**有没有那几行。

## 进程层的已知缺口（**不要假装已修**）

- **`shuttingDown` 一旦置 true 永不复位**：`stop()` 里置 true 之后没有任何地方设回 false。于是「程序化 `stop()` → `start()` → 用户 Ctrl+C」会走 `cliProcessPolicy.onSignal` 的**「二次信号强退」分支**，即第一次 Ctrl+C 就强退、不再优雅排空。**修它必须先裁决「迟到的上一代信号该二次强退还是二次排空」**（强退 = 丢在途连接与未落盘账本；排空 = Ctrl+C 按了没反应直到排空完）——改它必须先裁决那件事，不该顺手带上。
- **`start()` 末尾的 `process.on("uncaughtExceptionMonitor", …)` 没进 `installGuards`、不受幂等旗标保护**（既有行为）：`installGuards` 装的是 `setupProcessGuards` 那三个，`uncaughtExceptionMonitor` 是 `start()` 末尾直接 `process.on` 的，**多次 `start()` 会叠加监听**。收进去会改变 `managedProcessPolicy` 的行为面（三项全省略 = 「什么都不装」），属另一个决策。
