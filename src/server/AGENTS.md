# src/server — 服务端编排

`index.ts`（`ProxyServer`/`runServer`/`cliPreset`：CLI 进程壳）+ `cluster.ts`（多进程）+ `process.ts`（**进程策略端口** `ProcessPolicy` + 两个现成实现 + `cliPreset()`）+ `log/`（只剩 `config-log.ts`）+ `banner.ts`（生成物）+ `process-guards.ts`（进程守卫）。协议内部状态机归 `src/core/AGENTS.md` 的 `BaseProxy`，本层不管。**本目录是进程编排层**：`[event-code]` 事件词汇表与 `[route]` 等 pipe 事件文本归 `src/core/log-events.ts`（core 事实的翻译层），**事件 → 落盘的那一整套绑定在 `src/runtime/event-log.ts`**（`bindProxyEventLogs` 的 11 类 + `bindLifecycleLog` 的 `[lifecycle]` 一行，判据见下「事件落盘不在本目录」一节；`src/runtime/AGENTS.md` 是它的正文，本文件只留指针与本目录仍有的那几条接线）。**本目录仍然拥有的日志行只有那几条真需要「谁拥有这个进程」才说得清的**：`[config]`（配置快照）/ `proxy started:`（ready 面）/ `[shutdown]` ×2（停机）/ banner。

## ProxyServer（`index.ts`）

- `ProxyServer` 是**CLI 进程包装器**，构造参数必须含 `{ context: ConfigContext }`；logger 未显式注入时才按 `context.accessor` 创建独立 `LoggerImpl`。它不读 env/argv、不调用 `loadConfig()`、不创建配置状态，库调用方不要实例化本类，直接用 `createProxyRuntime()`。
- server 创建 runtime 时显式传同一 `context` 与 `LoggerImpl`；默认身份服务由 runtime 的 `createIdentityFromConfig(ctx, fileEventHandler)` 装配，core 只收到必填 `ProxyOptions.ctx`，不存在全局 accessor/鉴权回退。`ProxyServerOptions` 上另有 `services?` / `connectors?` / `assembly?` 三个透传位，**原样交给 `createProxyRuntime`**（本类不写第二份展开规则——「显式 options > assembly > 配置/缺省」三层优先级由 runtime 一处裁决）。
- `start()` 顺序为：经 `processPolicy.installGuards` 装进程级守卫（CLI 档 = 动态 import 并调用 `setupProcessGuards(this.logger)`，`./process-guards.js`，**文件本身在本目录**；惰性只为不打模块顶层副作用）→ 非 worker 时动态 import `logConfig(context, this.logger)`（`./log/config-log.js`；**它不是进程策略**——打印配置快照与「谁拥有本进程」无关，故留在本文件）→ 创建/接收 runtime → **事件 → 落盘绑定由 runtime 在 `start()` 内装配**（`runtime/event-log.ts`，本类不订阅任何公共事件，**`lifecycle.changed` 也不例外**）→ 经 `processPolicy.installSignals` 绑信号 → `runtime.start()` → ready 面。**八步次序是契约，不因进程策略注入位而重排。** 配置日志依赖调用方已完成加载，模块 import 本身不加载配置。
- **事件落盘不在本目录**（在 `src/runtime/event-log.ts`）：判据是本仓自己的分界线「**谁声明拥有这个进程**」——落盘**不拥有进程**（不装信号、不 fork、不 `process.exit`、不读 `process.env`），两族绑定都只有 `hub.subscribe(...)` 与 `logger.debug/info/warn/error`，**零 `process` 触点**。**把落盘挂在进程编排层是陷阱而不是能力**：库调用方走 `createProxyRuntime()` 时那个位置对它完全不可见，对一个嵌入方只剩两条烂路（① 接受没有落盘日志；② 自己重写那 11 个订阅，还要自己记得在 stop 时退订，漏了就泄漏监听器）。住在库层**不新增任何依赖边**（`server/` → `runtime/` 是既有方向）。**正文（事件映射表 / `[{kind}] headers` 的掩码与四字段 / `[target-denied]` 文本 / 退订归属 / 两条 quota 事件 / 14 变体 switch / `[lifecycle] state …` 与 worker 门）全在 `src/runtime/AGENTS.md`**，改动请同时看那一份。
  - ⚠️ **「`[lifecycle] state …` 是 CLI 的文本契约」不构成不同判据的理由**：`bindProxyEventLogs` 的十几条文本**也全是契约**。**文本契约约束的是「那几行逐字不变」，不是「住哪一层」**——CLI 那一行**逐字不变**（护栏 `tests/integration/lifecycle-log-binding.test.ts` 第 ③ 档「CLI 与库逐字段相等」）本身就是判据的一部分。**给两族配不同判据会造出「凭什么这个特殊」的不对称，而那种不对称正是下一个人凭直觉做错事的起点。**
  - ⚠️ **master-only 的那道门靠一条显式通道**：`ProxyServer.isWorker()`（`cluster.isWorker`，或测试注入的 `isWorker` 覆盖）在 `createRuntime()` 里**显式**传给 `createProxyRuntime({ isWorker })`。**没有这条通道那道门就关不上**——runtime 自己判不了 worker 身份（它零 `cluster` 零 `process`，与 `trafficWorkerSlot` 同一手法）。
  - 本目录**仍然**从 `@/core/log-events.js` 取的两个事件函数：`logQuotaInert` / `logAclInert`（`createRuntime()` 的 `onWarning` 白名单，那两条是**启动期告警的落盘**、不属于事件翻译）。**刻意没动** `onWarning` 整体不转发这条裁决与它的两条护栏（见下）。
  - **本目录不持有任何事件订阅**：两族绑定都由 `event-log.ts` 那个**自带归属的幂等闭包**承担（全部引用都在闭包内），本类不存订阅数组、不存 `{ hub, subscription }` 那一对。**对 `EventHub` 的使用只剩「注入的那条总线」与 `ProxyServerOptions.events`**，没有任何自己挂上去的订阅。
- **两条 `onWarning` 接线**（`createRuntime()` 里，**留在本目录不动**）：**只**接 `code === "quota-inert"` 与 `code === "acl-inert"` 两条并分别调 `logQuotaInert` / `logAclInert`。
  - **⚠️ 「只接白名单、不整体转发」这条裁决对两条都成立**（记在这里免得下一个人加第三条告警时重新推导一遍）：白名单里的每一条都是「**配置有洞、服务照跑**」——运维必须知道但不必停机（`quota-inert` = 配了配额没开鉴权；`acl-inert` = 注入了自定义 `access` 所以 `acl.json` 不生效，两条的判据都是**文件事实**而不是猜配置）。白名单外的是 `config-normalized`（**文档级的归一提示**，已经在 `cli.ts` 按 `context.warnings` 独立 warn 过一次）与 `start-failed`（**由启动抛错本身暴露**，再 warn 一遍是重复）。全量转发会把「必须知道」与「重复一遍」混在同一个等级里，**warn 一多就等于没有 warn**。
  - **什么时候该推翻这条**（写下来免得临场重新裁决）：白名单到**第三条**时重新裁决——那时「维护一张 code→等级的白名单」的成本会超过「统一渲染 + 逐条定级」的成本，届时正确形态是**让 `RuntimeWarning` 自带等级**（`{ code, message, level }`）而不是继续加 `if` 分支；或者引入第三类「启动失败」并让 CLI 直接走异常路径。**在只有两条的今天，整体转发的收益是零、代价是丢掉两条告警的等级区分。**
  - **护栏**：`tests/integration/acl-inert-warning.test.ts` 的「源码级：`onWarning` 是**白名单**（两条），刻意不整体转发」——`blockAfter(codeOf("server","index.ts"), "onWarning: (w) =>")` 后断言两条 `w.code === …` 都在、且**零 `else {` 兜底支**。**用变异测试验证过**：给 handler 加一档 `else { this.logger.warn(w.message); }` → 恰好这一条红。⚠️ 这条只能源码级：`config-normalized` / `start-failed` 要经配置归一那一面的触发条件才造得出来，而**这条纪律的全部内容就是「handler 长什么样」**，文本面才是它的直接对象。
- `stop(graceMs)`：经 `runtime.stop()` 优雅排空（返回前 `await logger.flush()`）+ 超时兜底 `processPolicy.forceExit(1)`（timer `unref`）。信号与 master IPC 同时到达时重复触发幂等；单进程停机中再收信号可强退，worker 永不强退，兜底交 master grace SIGKILL 与 stop 自身超时。**`forceExit` 是 `ProcessPolicy` 上唯一的必填成员**（停机超时兜底在任何策略下都必须有答案），CLI 档 = `process.exit(1)`、`managedProcessPolicy` 档 = 只发一条警告并把退出交还宿主。
- **`stop()` 的 finally 里有四步，次序是契约**：`unbindSignals()`（**排在最前**）→ `await this.closeTrafficLedger()` → `await this.logger.flush()` → `clearTimeout(timer)`。**这四步里没有任何事件订阅的退订**——事件订阅由 `runtime.stop()` 的 `releaseSubscriptions()` 在排空之后统一退（**那才是它们真正被装配的地方**），`ProxyServer` 不持有事件观察面，硬塞第五步只会让人误以为本层还挂着订阅。
  - **`unbindSignals()` 排最前的原因**：`installSignals` **返回**幂等退订函数，不摘的话「同一对象 stop → start → stop」会一层层叠加 SIGINT/SIGTERM 监听。排在排空**之后**才有意义（finally 是 `await runtime.stop()` 落地才进的）——**排空途中收二次信号仍然能强退，这是 CLI 的现状行为**。
  - `await this.closeTrafficLedger()` 排在 `unbindSignals()` 与 `await this.logger.flush()` **之间**。`runtime.stop()` 里已经收过一次账本（幂等，这里是空转），之所以还要写在这里是让次序在 CLI 面上**显式**：账本与日志说的是同一段时间的用量，次序错了对不上账；而 `process.exit`（信号处理的 finally）会截断在途 append，所以**落盘必须在 `logger.flush()` 之前**。护栏：`tests/integration/traffic-ledger-runtime.test.ts` 的「ProxyServer.stop() 在与 logger.flush() 同一位置把账本落盘」**读真实文件内容**（不是 spy）。
- **`ProxyServerOptions.trafficWorkerSlot`**：流量配额账本槽位号，由 CLI 从 **env 快照**（`PROXY_WORKER_SLOT`）显式传进来，一路透到 `createProxyRuntime({ trafficWorkerSlot })`。**本层与 core/runtime 都不读 `process.env`**：槽位会被拼进账本文件名，「自己猜来源」=「写错文件 / 读别人的账」。省略（单进程 / 库模式）归一为 `"0"`。
- `EADDRINUSE`：CLI 提示查占用 + `pnpm start -- --port <next>`；端口从已加载 `context.store` 读取，不再从任何全局函数获取。

## 进程策略端口（`process.ts`）

**这个端口只回答一个问题：本进程归谁管？** 信号、进程守卫、banner、`process.exit` 全归它回答，`ProxyServer.bindSignals()` / `start()` / `stop()` 退化成调用位。

- **为什么端口只长在 `server/` 侧（不扩到 `runtime/`）**：分界线是「**谁声明拥有这个进程**」。`ProxyServer` = 进程壳 → exit/信号/守卫/banner 就是它的职责，做成注入位是诚实的；`ProxyRuntime` = 库门面 → 继续零 `process`、零 `exit`、零 cluster。把 `forceExit` 塞进 runtime 选项等于让库调用方拿到一把上膛的枪（一个 `process.exit(0)` 藏在「配置」里）。反向依赖也是被禁的（`runtime → server`），所以进程位由 `ProcessStartupPreset extends StartupPreset` 在**允许的那一侧**补上。
- **形状故意不对称**：三个可选项（`installSignals` / `installGuards` / `printReady`）**省略即不装**（「装不装」本身就是策略的表达），`forceExit` **必填**——留成可选等于允许「超时后什么都不做」，那正是长连接把停机永久挂死的那条路。`installGuards` 返回 `void | Promise<void>`（CLI 档要**调用时**才 `import("./process-guards.js")`，那是 Promise；同步实现直接返回 `void`）。
- **`SignalHost` 只交出回调方真正需要的那四样**，一个不多一个不少：端口不是「把 server 整个递出去」。⚠️ **`[shutdown]` 那两行日志由 `ProxyServer` 打、不由策略打**（前缀是 CLI 的落盘文本契约，不该跟着进程策略搬家），策略只拿到「退不退」这个动作。
- **两个现成实现**（否则「可拆」只是把责任踢给调用方）：
  - **`cliProcessPolicy`（缺省档）= CLI 的现状行为逐字保留**，包括那些**看起来可疑但确实必要**的细节：首次信号 → 幂等排空 → `exit(0)`（**在 finally 里退**，保证排空失败也退）；停机中再收信号 → 只有**单进程**才强退（worker 的信号来自控制台广播、会与 master 的 IPC 同时到达，无法区分「同一次 Ctrl+C」与用户二次按键）；worker 另挂 `message:{type:"shutdown"}`，与信号等价且**只触发幂等排空、绝不强退**。`installSignals` **返回**幂等退订函数。
  - **`managedProcessPolicy` = 宿主已拥有进程时的诚实档**：三项全省略（不抢 SIGINT/SIGTERM、不装 uncaughtException/unhandledRejection/warning 守卫、不打 banner）。它解决的真痛点是 Electron 主进程 / CLI 框架 / 测试 runner / 已有优雅停机的主服务——那类宿主**不接进程策略**就只剩两条烂路：① 吞掉 banner 与配置日志；② 绕过整个 `server/` 层把 runtime + 事件订阅 + 日志接线**重写一遍**。本档让「要代理能力、不要进程副作用」变成一行注入。
- ⚠️ **`managedProcessPolicy` 的代价必须写清：长连接下 `stop()` 会挂死。** `forceExit` 的实现是「打一条警告说明本策略不接管退出、交给宿主」——`process.exit` 在这个前提下**根本不归我们叫**。于是嵌入方若不自己兜底，一条长连接会让 `stop()` 一直挂着（grace 定时器到点后只发这条警告就返回，事件循环被活着的 socket 撑着不退出）。**那是「进程所有权在宿主」这个前提的必然代价，不是 bug**：要强退就写 `managed: { ...managedProcessPolicy, forceExit: (c) => process.exit(c) }`——**显式覆盖永远比「库偷偷替你退进程」诚实**。
- **`cliPreset(): ProcessStartupPreset`** 是「CLI 就是库预设的一次组装」这个命题的代码落点：CLI 相对纯库调用方多出来的东西**只有一条——它拥有这个进程**，所以整份预设里只有 `process` 一个字段非空。⚠️ **刻意不钉 `protocol`**（CLI 的入站协议是**配置事实**，`proxyProtocol` 能被 argv/env 改，预设里写死一份会让覆盖失效——那是「预设压过显式配置」的第二真相源）；同理不钉 `services`/`connectors`（那份库已经能解析出正确的默认，钉一份只多一处要同步的副本）。
- **依赖纪律**：本文件是 `server/` 目录里**唯一** import `./process-guards.js` 的地方（守卫安装属于策略行为，不属于 `ProxyServer`）；`banner` 的**策略侧**调用也只在这里（`cluster.ts` 那个 master 汇总 banner 是另一处调用点，master 分支不归本端口管，故保持原样）。`process-guards` 保持**惰性动态 import**——import 期零副作用是硬不变量。

### ⚠️ 进程层的已知缺口（**不要假装已修**）

- **`shuttingDown` 一旦置 true 永不复位**：`stop()` 里 `this.shuttingDown = true` 之后没有任何地方把它设回 false。于是「程序化 `stop()` → `start()` → 用户 Ctrl+C」会走 `cliProcessPolicy.onSignal` 的**「二次信号强退」分支**（`isShuttingDown() && !isWorker()` → `forceStopNow()`），即第一次 Ctrl+C 就强退、不再优雅排空。**修它必须先裁决「迟到的上一代信号该二次强退还是二次排空」**（强退 = 丢在途连接与未落盘账本；排空 = Ctrl+C 按了没反应直到排空完）——**这不是能顺手改的 bug**：改它必须先裁决那件事，不该顺手带上。
- **`start()` 末尾的 `process.on("uncaughtExceptionMonitor", …)` 没进 `installGuards`、不受幂等旗标保护**（既有行为）：`installGuards` 装的是 `setupProcessGuards` 那三个（`uncaughtException`/`unhandledRejection`/`warning`），`uncaughtExceptionMonitor` 是 `ProxyServer.start()` 末尾直接 `process.on` 的，**多次 `start()` 会叠加监听**。收进 `installGuards` 会改变 `managedProcessPolicy` 的行为面（它三项全省略 = 「什么都不装」），属另一个决策。

## 库入口零副作用保证

- `src/index.ts` 的静态依赖不执行配置加载、cluster fork、`server/process-guards`（本目录 `process-guards.ts`）或**任何日志写入**；它导出 `loadConfig`/`createConfigContext` 供调用方显式使用、`defineStartupPreset` 与 `cliPreset`/`cliProcessPolicy`/`managedProcessPolicy`（让库调用方能拿到现成的进程策略而不必自己实现），并 re-export 接收 context 的 `ProxyServer`/`runServer` 作为进程级 API。包入口明确不导出 `get/getAll/set/defaultConfigAccessor/globalConfigAccessor`。⚠️ **「静态 re-export 了 `runtime/event-log.ts`」不等于「import 期就在落盘」**：那个模块只有函数定义与一张 `Record` 字面量表，绑定**只在 `createProxyRuntime(...).start()` 里**发生（`activateSubscriptions`），而默认 logger 是 `createNoopLogger()` → 库调用方不显式注入 logger 时 import + 构造 runtime 一行日志都不写。
- import `src/config/load.ts` 只定义 async `loadConfig()`；省略 `env`/`envFiles`/`argv` 即空，不读 `process.env`/`process.argv`、不扫描默认文件、不写 `process.env`。只有调用方 await 且显式给来源后才执行 IO 与校验。
- `src/cli.ts:main()` 是唯一宿主组合根：第一次 await 前快照 env/argv/cwd/NO_COLOR → `defaultEnvFileNames(env.NODE_ENV)` → `await loadConfig(...)` → `createLogger({ config: context.accessor })`（并把 `context.warnings` 逐条 warn 出去）→ `runServer(context, { logger, noColor: Boolean(env.NO_COLOR), trafficWorkerSlot: normalizeSlot(env[TRAFFIC_SLOT_ENV]), assembly: cliPreset() })`。
- ⚠️ **`runServer` 只接一个 `RunServerOptions`**（形状与 `ProxyRuntimeOptions` / `ProxyServerOptions` 刻意统一——三者都是「一个必填的 `context` + 一个可选项对象」）。`RunServerOptions` = `{ logger?, noColor?, trafficWorkerSlot?, processPolicy?, services?, connectors?, assembly? }`。`runServer` 本身**不采集宿主来源**；`logger` 省略时只按已给 context 新建。**槽位号取自 CLI 那份 env 快照**而不是新读 `process.env`。
- `cluster.ts` 顶层只定义函数；`cluster.on`、`process.on`、fork 与退出兜底全部在 `runAsMaster(context, logger, noColor)` 内。`ProxyServer` 的进程守卫（同目录 `./process-guards.js:setupProcessGuards`）也只在显式 `start()` 时动态安装，并接收当前 logger；`config-log` 同样接收 `ConfigContext` 与 `LoggerImpl`。
- `createProxyRuntime()` 的 context 模式只创建 runtime accessor/服务/EventHub（或复用注入项）与未监听 core；config/preset 模式另建私有 store。两种模式都不读 env/argv/配置文件、不写 stdout/日志、不注册 process 事件、不退出进程。

## Cluster（`cluster.ts`）

- `runServer(context, options: RunServerOptions = {})` 按 `context.store.get("clusterWorkers")` 决定 master 或单进程（`options.trafficWorkerSlot` 只透给单进程分支的 `ProxyServer`，master 分支不需要它）；`runAsMaster(context, logger, noColor)` 显式使用同一 context/logger，配置日志读取 `context.config` 的加载时冻结快照，shutdown grace 读取 live `upstreamTimeout`。
- `clusterWorkers>1` 才 fork。生命周期/崩溃行走 `notice`；worker 快速退出（`<5s`）1s backoff 重启，连续 5 次快速退出 → master `exit(1)`（先 flush）；第二个信号强制 master 退出，全部 worker 退出后 master 以 0 退出（先 flush）。这些副作用仅在 `runAsMaster()` 调用后发生。
- banner 由同目录 `./banner.js:printBanner(logger, noColor)` 打（`index.ts` 单进程 ready 后、`cluster.ts` master 汇总判据「当前就绪 pid 集合」成立时各打一次，重复就绪不重复打）。**`banner.ts` 是 `scripts/gen-banner.mjs` 的生成物，勿手改**；生成路径由 `build.mjs` / `scripts/gen-banner.mjs` 同步维护，`RE_ANSI_ESCAPE` 从 `@/utils/constants/index.js` 取。
- master 与 worker 不共享内存 store：每个 `cluster.fork()` 启动的新进程重新进入 CLI 组合根，独立快照宿主来源、独立 `await loadConfig()`、独立创建 context/accessor/logger/ACL/auth 缓存；master 只负责 fork/ready/退出编排。
- **配额账本槽位派发（`runAsMaster` 内）**：三条 fork 路径（首轮 `count` 次、rapid 退避重启、健康退出补拉）**全部走同一个 `forkWorker()`**，它做两件事——取一个**稳定槽位**并 `cluster.fork({ ...process.env, [TRAFFIC_SLOT_ENV]: slot })`。
  - **槽位是稳定序号 `1..N`，不是 PID**：账本文件名是 `worker-<slot>.jsonl`，用 PID 会让「每次重启换文件名」，旧文件再无人问津 → 恢复永远不生效。护栏：`tests/unit/traffic-ledger.test.ts` 断言 `cluster.ts` 里有 `slotByPid.delete(pid)`、**零裸 `cluster.fork()`**、且恰好 **3** 个 `forkWorker()` 调用点。
  - **`takeSlot()` 取 `1..count` 里最小的空闲号**，`cluster.on("exit")` 里 `slotByPid.delete(pid)` 释放：崩溃重启的 worker **复用**它刚让出的那个号（账本接得上，而不是开一个 5 号空文件把 3 号的账丢在一边）。
  - **为什么写 env 而不是 `worker.send()`**：worker 的账本在**启动期**就要知道自己的文件名，那早于任何 IPC 往返；env 是 fork 时就随进程存在的唯一载体。子进程重新进入 CLI 组合根 → `PROXY_WORKER_SLOT` 就在它那份 env 快照里 → `runServer` 的 `options.trafficWorkerSlot` → `ProxyServer.trafficWorkerSlot` → `createProxyRuntime({ trafficWorkerSlot })` → 账本。**`core/**` 与 `runtime/**` 全程零 `process.env` 读取**（那条铁律就靠这条链兑现）。
  - master 自身**不开账本**（它不跑代理，只 fork）；单进程 / 库模式恒为 slot `"0"`。

## 本目录注意

- `server/log/config-log.ts:logConfig(context, logger)` 打印初始冻结快照并脱敏 secret/口令/上游凭证；运行期文件事件由 runtime 显式把当前 logger 注入 config 层，不由本模块抓全局 logger。
- `server/log/` **只剩 `config-log.ts` 这一块**：结构化事件码（`[event-code]`）与 pipe 事件文本归 `src/core/log-events.ts`，启动 banner 归本目录 `banner.ts`，**事件 → 落盘的绑定归 `src/runtime/event-log.ts`**。**不要再往本目录塞事件词汇表或事件订阅**——事件词表的唯一直接调用方是 `core/server/*`（放这里就要求 core 反向依赖进程编排层），事件订阅的唯一直接调用方是 `createProxyRuntime`（放这里就要求库调用方反向依赖进程层，而落盘零 `process` 触点、压根不属于这一层）。
- 查日志用 `jq`（示例见 `src/utils/AGENTS.md`）。
