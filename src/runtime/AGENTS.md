# src/runtime — 第三方库门面

`runtime/` 是把仓库当作库嵌入时的唯一公开装配层。它负责把调用方给出的 `ConfigContext`（共享 live store）或纯内存 `config`/`preset`（内部私有 store），连同服务替身、上游连接器、启动预设、事件总线和日志端口接到协议核心；纯内存模式可显式提供 `configDir` 作为路径锚点。协议实现、连接排空和生命周期状态机仍由 `src/core/server/` 负责，**进程策略（信号/守卫/banner/退出）不在本目录**——那是 `src/server/process.ts` 的事。

## 职责边界

- `createProxyRuntime()` 的配置来源严格二选一：`context` 模式直接复用调用方 context 的 live `ConfigStore`；`config`/`preset` 模式内部新建私有 `ConfigStore`。两种模式都派生当前 runtime 专用 accessor，并装配默认服务、事件总线和 `ProxyCore`。
- `ProxyRuntime.start()/stop()` 只委托给 `BaseProxy` 的幂等状态机；不得另造 listen/close/连接排空逻辑。
- `getProxy()` 从构造期起就返回同一个协议核心，TLS 证书等真正需要的文件仍由协议启动钩子惰性读取。
- 本目录不负责配置解析来源、cluster、信号、日志落盘或进程退出。

## 零副作用铁律

- 构造 runtime 不得读取 `process.env`、`process.argv`、`.env`、配置文件或任何其它文件；不得写 `process.env`、stdout/stderr、日志文件，不得注册任何 `process` 事件，不得调用 `process.exit`，不得使用 cluster。
- 不得 import `src/config/load.ts` 或 `src/server/index.ts`；CLI 负责采集宿主来源与调用加载器，server 负责进程治理，库门面只接受显式 `context` 或纯内存 `config`/`preset` 及依赖注入。
- 默认日志必须是 `createNoopLogger()`。需要输出时由库调用方显式注入 `Logger`，runtime 不擅自选择默认/全局 logger；JSON 热加载事件也只渲染到这个注入 logger。
- 配置状态只来自 context 的调用方 store 或 runtime 私有 `ConfigStore`，并经当前实例 accessor 注入 core；不存在 CLI 全局 `get/set` 或默认配置 store。

## DI 契约

- `context` 与 `config`/`preset` 是类型上互斥的两种来源：传 context 时 `runtime.context.store === context.store`，保留调用方 live 状态；不传 context 时，将 `preset`（可缺省）展开后再应用显式 `config` 覆盖，灌入 runtime 私有 store，缺省键取 `defaults`，不经过 env/argv/`loadConfig`。纯内存模式可传 `configDir`；构造时所有 path 字段先绝对化，省略时只捕获当时的 `process.cwd()` 作为便利默认，之后 `process.chdir()` 不得使路径漂移。
- runtime 无论哪种来源都生成自己的 `ConfigAccessor`：startup 键在构造时复制固定，runtime 键每次经 context store 现读；`ProxyOptions.ctx` 必须传包装了这同一个 accessor 的 `RuntimeContext`。`runtime.options`（含 tls 对象）、`runtime.services` 和派生 accessor 是只读冻结视图，store 后续修改只发布事件，不重建 core。`UPSTREAM_URL` 与六个 endpoint 拆项都属于 startup，loadConfig/纯内存 runtime 共用 URL 校验/拆项入口；解析失败不得半写 store，修改任一项都需重建 runtime，拆项覆盖 warning 保留。
- 配置变更事件按相位分流：runtime 键发布 `config.changed`，startup 键（含 `UPSTREAM_URL` 与六个 endpoint 拆项）发布 `config.restart-required`；当前实例的 startup accessor/已构造 options 保持原值，必须新建 runtime 或重启才采用新启动值。
- **纯内存 `config` 模式不跑 `FIELDS` 校验，非法枚举值能进 store**：本模式把 `preset` + `config` 展开后灌进私有 `new ConfigStore(...)`，而 `ConfigStore` **零校验**（不跑逐字段解析 / 范围 / 交叉校验——那是 `loadConfig` 的职责，见 `src/config/AGENTS.md`）。因此 `createProxyRuntime({ config: { upstreamProtocol: "ftp" } })` 这类调用**会**把非法值带进运行期，CLI 路径的 `FIELDS.parseEnum` fail-fast 在这里**不适用**。这条决定了两个出口、且**两个都留着**：
  - **入站协议：`runtime.ts:protocolFor(config)` 在构造期抛**（`未知代理协议: <值>`）。⚠️ **配置值无论是否被 `assembly.protocol` 覆盖都要先校验**：`ConfigStore` 零校验，而 `ConfigContext.config` 快照 / `logConfig` 仍会原样打印它——**一个「配了、没生效、也不报错」的值比启动报错坏得多**。覆盖只改变**用哪个值**，不改变**是否校验**。
  - **上游协议：core 侧 `ConnectorSource.upstream()` 在请求期抛**（fail-closed，**刻意不前移到装配期**，见 `src/core/AGENTS.md`「三个可插值端口」）。**别拿「① 已经启动就报」当理由把 ② 也前移**——前移会让 `forward.error` 那条安全事实消失。
- facade 的**直接配置字段**只有 `readonly context: ConfigContext`；**不再公开**独立的 `config` 或 `configAccessor` 字段，也不在 facade 复制另一份可变配置。`runtime.options.ctx.config` 仍只是归一化 `ProxyOptions` 暴露的同一个必填 accessor，不是第二个配置入口。需要快照用 `runtime.context.config`，需要写 live store 用 `runtime.context.store`。
- **`RuntimeServices` 四项（`identity` / `access` / `traffic` / `trafficLedger`）走同一个形状：「配置驱动的默认实现 + 可覆盖替身」**，默认实现的解析**只在** `services.ts:buildDefaultServices`（全项目唯一那处）。显式注入的替身**原样透传**到 `ProxyOptions` 与 `runtime.options`（护栏查对象同一性），故库调用方注入的替身一定生效，core 侧的「`??` 显式 inert 档」永不触发。
  - `services.identity` 未提供时由 `createIdentityFromConfig(ctx, fileEventHandler)` 装配（**第一个形参是 `CoreContext` 而不是 `ConfigAccessor`**——三件套是每个服务插件都该拿到的东西：账号文件坏掉要能渲染日志与发事件，传裸 accessor 等于逼每个组装点自己拼 logger/events，那是「每个组装点各拼一次」的第二真相源）；`services.access` 未提供时由 `createFileAccessControl(ctx.config)` 装配（**刻意只收 `config`**：ACL 文件观察面有且只有一个注册入口 `bindAclFileEvents`，工厂再收一个 `onFileEvent` 便利形参就会出现两个写同一个 `WeakMap` 的入口，而判定层只认后装的那个）。⚠️ **`RuntimeServices`（四项，库可覆盖）与 `CoreServices`（三项，core 内部归一后）不是同一个东西**——后者刻意不含 `trafficLedger`（落盘账本是 runtime 独有的副本，core 从不打开它），见 `src/core/AGENTS.md`。⚠️ **`services.access` 是四个位里唯一「注入替身会让 `acl.json` 整份失效」的**（另三项注入后配置文件照样生效），故它有专门的启动期告警 `acl-inert`（见下「启动期「名单失效」告警」）。
- **`services.traffic`**：未提供时由 `createMemoryTrafficAccount((user) => loadUserQuota(user, accessor, fileEventHandler))` 装配，**全项目唯一解析默认流量配额服务的地方**——core 与四个转发器只拿端口、拿到的却是这份读 users.json 的内存账本。显式注入优先且原样透传（`runtime.options.traffic === runtime.services.traffic`，库调用方注入的替身一定生效；护栏 `tests/integration/traffic-quota.test.ts` 的「默认解析只发生在唯一组装点」）。core 侧的 `ProxyOptions.traffic ?? 显式禁用档` 因此永不生效，它只是给**直构 core** 的低层调用方一个语义明确的答案（与 `identity ?? noneIdentity()` 同构）。
- **`services.traffic` 的窗口口径也只在这里注入**：`TrafficWindowSource.resetHour` 是一个经**当前 runtime accessor** 的闭包（`() => configAccessor.get("quotaResetHour")`）——`quotaResetHour` 是 runtime 相位字段，故每次访问现读，**热改 `store` 立即改变窗口边界、不必重建 runtime**（护栏 `tests/unit/traffic-window.test.ts` 的「热改 resetHour 即时改变窗口边界」）。`now` **刻意不注入**：账本只用它算窗口键、窗口滚动是**惰性**的（每次访问槽位时比对窗口键），故生产路径不需要可注入时钟。**账本本身零配置依赖**（配额来自注入的 `QuotaResolver`、窗口来自注入的 `TrafficWindowSource`），与「runtime 不给 core 做缺省解析」这条铁律同向。
- **`services.trafficLedger` 与其零副作用纪律**：`buildDefaultServices(ctx, overrides, onFileEvent, host)` 的第一个形参是 **`CoreContext`**（`ctx.config` 供三个默认实现现读、`ctx.logger` 是身份的缺省观察面、`ctx.events` 目前只是「位置」而不是「当前调用」——刻意如此，下一个要发事件的服务插件不必回头改这个签名），第四个形参 `host: TrafficLedgerHost` = `{ slot?, onLedgerError? }`。**槽位是显式字符串**（`host.slot` ← `options.trafficWorkerSlot` ← `ProxyServer.trafficWorkerSlot` ← CLI 的 env 快照 `PROXY_WORKER_SLOT`）——**runtime 一律不读 `process.env`**：槽位会被拼进账本文件名，「自己猜来源」=「写错文件 / 读别人的账」，而库调用方（浏览器/worker/测试）可能压根没有那个对象。
  - **构造零副作用**：`new JsonlTrafficLedger(...)` 只算出一个文件路径（`path.join(dir, "worker-<slot>.jsonl")`，**纯字符串计算、不 stat 磁盘**）。目录、句柄、定时器全部由 `runtime.start()` 触发的 `ledger.open()` 创建 —— 这与「构造 runtime 不得读 env/文件」的零副作用铁律同向，**不要**把 `open()` 挪进构造函数。
  - **与默认内存账本同生共死**：调用方**显式注入** `services.traffic` 时 `trafficLedger` 恒为 `undefined`（那一本账归调用方管，我们不写它的文件、不给它起定时器、也不发它的落盘事件）。注入本类构造**零开销**（不 `mkdir`、不 `open`）。
  - **恢复回注两步走**（`account.bindSink(ledger)` 之前先 `new MemoryTrafficAccount(resolve, window)`，账本的 `onRestore` 闭包调 `account.seed`）：顺序反过来就得写「用前未赋值」的闭包，那是本仓明确不接受的形状。
  - **`hasConfiguredQuota(configAccessor, onFileEvent)` 住在本文件并导出**（`runtime.ts` 从这里取）：它既是账本零成本档的判据，也是 `quota-inert` 告警的判据，**告警与判定必须是同一个函数**（两处各写一份，迟早出现「告警说没配、账本说配了」）。护栏 `tests/unit/traffic-ledger.test.ts` 逐档断言（全 0 / 只配 window / 任一非零子字段 / 文件缺失）。
  - **同层还有 `hasConfiguredAcl(configAccessor, onFileEvent)`，实现住在 config 层（名单数据层）、从这里转出给 runtime 用**：它是 `acl-inert` 告警的判据（见下「启动期「名单失效」告警」）。**告警与判定必须是同一个函数**（与 `hasConfiguredQuota` 同一手法），让 `runtime.ts` 从同一处取「配额是否配了」与「名单是否配了」两个启动期判据。
  - **`isAccessOverridden(access)` 也住本文件**：`access` 是否由调用方**显式注入**（而不是本函数解析的默认实现）。**为什么用模块级 `WeakSet<AccessControl>` 而不是往 `RuntimeServices` 上加字段**——后者是**公开面**（库调用方 `runtime.services` 拿到的就是它），把「这份 access 是不是替身」这条**装配期的一次决定**抬进运行时契约，调用方会开始依赖它。判据是**实例身份**而非 `instanceof`（后者跨模块副本 / 打包产物 / 测试替身全部失配，症状是「明明注入了替身、告警却没响」）。它是本文件**唯一**的写入方与读取方，调用方完全看不见。
  - **`runtime.start()` 的次序不可调换**：`activateSubscriptions → config.loaded → reportQuotaGate → await openTrafficLedger() → proxy.start()`。账本**必须在 `core.start()` 之前**开完：恢复与启动期压缩都读同一个文件，「先收流量再恢复」会让本进程的增量与恢复出来的账互相覆盖。`openTrafficLedger()` 抛错**绝不让启动失败**（账本是增强面，磁盘坏了不该让代理起不来；失败事实已由账本自己经 `onLedgerError` 上报）。
  - **`runtime.stop()` 的 finally 里 `await closeTrafficLedger()`**：排在 `releaseSubscriptions()` **之前**（账本的 `onError` 要经这条总线发 `traffic.ledger-error`）与 `proxy.stop()` **之后**（排空期间还有在途字节在计量）。`ProxyServer.stop()` 的 finally 里也调一次（幂等空转）——见 `src/server/AGENTS.md`。
  - **事件面**：`onLedgerError` 只 `publish("traffic.ledger-error", { path, error })`，**不落日志**（落盘那一跳是**本目录** `./event-log.ts:bindProxyEventLogs` 的职责，由 `runtime.start()` 装配、`eventLogs: false` 可关）。
- `events` 未提供时每个 runtime 自建一个 `EventHub`；提供时必须原样使用外部实例。`logger` 未提供时使用 noop，不把 core 改成 CLI 策略。

## 上游连接器与启动预设（`presets.ts`）

### `options.connectors` —— 上游接入来源，**整个生命周期只解析一次**

`ConnectorSource` 是第三个可插值端口（回答「怎么到达 dest」），**它排在选项上而不是 `services` 里**：它不是「服务」而是「装配期解析出的两张连接器引用」，与 `traffic` 那种**进程级可变状态**不同类（`services` 里那三项都是「一个判定/计量端口」）。

解析次序在 `runtime.ts`：`options.connectors ?? assembly?.connectors?.(ctx) ?? createConnectorSource(ctx)`。**整个 runtime 生命周期只解析一次**——`ConnectorSource.upstream()` 会**记忆** `upstreamProtocol`（startup 相位），解析两次就有两个 source 各记一份协议，「一个进程一个真相源」当场被破。⚠️ **必须落在 `createProxy` 之前**（协议核心的实例化只有那一次机会）。与 `BaseProxy` 构造期的 `options.connectors ?? createConnectorSource(options.ctx)` 刻意同构、**刻意不做配置驱动的二次解析**：那属于「缺省解析只允许在 `createProxyRuntime()` 里做一次」这条铁律。core 侧那份缺省档只服务**直构 core** 的低层调用方，runtime 解析一次并**显式注入**。本选项**原样透传**：`runtime.options.connectors` 与注入的实例是同一对象。

### `options.assembly` —— 启动预设，**消费点在构造期**

`StartupPreset`（`./presets.ts`）= 一份**具名的装配决策**，全部字段可选（只声明要改的那几项）：`name` / `description` / `protocol?` / `services?: Partial<RuntimeServices>` / `connectors?: (ctx) => ConnectorSource`（**是工厂不是实例**——`ctx` 只有装配期才存在，收工厂才能让预设**声明意图**而不绑死某次运行的依赖三件套）。配套 `defineStartupPreset` / `registerStartupPreset`（重名 fail-closed，`override: true` 才允许替换）/ `getStartupPreset` / `listStartupPresets` / `builtinStartupPresets` / `pickStartupPreset`。**内置只有 6 个协议预设，且每个只声明 `protocol` + `description`**——预置组合（`"sockss5-quota"` 那种）只会得到一份**没人维护的菜单**（六个协议 × N 种服务组合 × M 种进程策略的笛卡尔积）；要组合就直接 `registerStartupPreset({ name, protocol, services })` 三行代码的事。

**优先级链三层，逐层覆盖**：显式 `options` > `assembly` > 配置 / 缺省。
- **`services` 是逐字段合并**（`{...assembly?.services, ...options.services}`）**而不是整体替换**：四项服务彼此正交，调用方只想换身份实现时不该连带丢掉预设声明的流量账本；逐字段合并也让「显式注入某一项」与「预设声明其余项」能同时成立。
- **`protocol` / `connectors` 让 assembly 覆盖配置**：assembly 是**程序化**决策（库调用方在代码里点名要哪个协议服务器 / 哪套上游接入），配置是**声明式**决策（env / argv / 内存对象）——前者天然比后者具体。
- **但配置值无论是否被覆盖都要先校验**（`protocolFor(config)` 无论是否被 `assembly.protocol` 覆盖都先跑），理由见上面「纯内存 config 模式」那条。

⚠️ **`assembly` 不读 `process.env`、不读 argv、不碰文件**。**env 的影响全部收敛在 `loadConfig`**：库层再读一次就是「协议由两处决定」的第二真相源（`upstreamProtocol` 那次已经付过学费）。它**位于 common options 而不在「context / 纯内存」二选一那一侧**：两种来源都能叠加预设——「复用宿主的 live store，但协议这一档由我在代码里点名」是成立的组合。

### ⚠️ `StartupPreset` 与 `ProxyPreset` **完全无关**（只因命名相似）

| | `config/presets.ts:ProxyPreset` | `runtime/presets.ts:StartupPreset` |
|---|---|---|
| 是什么 | **配置值**打包（`name + Partial<AppConfig>`） | **装配**决策（用哪个协议服务器 / 哪些服务替身 / 哪套上游接入） |
| 消费点 | `applyPreset()` → 灌进 `ConfigStore`，之后经 accessor 现读 | `createProxyRuntime({ assembly })`，**消费点在构造期**（协议与连接器都是 startup 事实，构造后不再变） |
| 形状稳定性 | 值是数据，谁都能自己拼一个对象 | 里面装的是**服务实例工厂**（`Partial<RuntimeServices>` + 连接器工厂函数），不是数据 |

两者**没有任何关系**，只是都叫「预设」。`StartupPreset` 全部符号带 `Startup` / `startup` 前缀，就是为了让读代码的人一眼分清「我在动配置值，还是在动装配」。

**⚠️ `StartupPreset` 刻意没有 `process` 字段**：`ProcessPolicy` 住在 `src/server/`，而 `runtime → server` 是**被禁方向**。哪怕用 `import type` 擦除掉运行期依赖，也会留下「库层的公开类型里出现进程层类型」的**阅读陷阱**（下一个人看到 `StartupPreset.process` 会以为 runtime 会用它）。**由 server 侧另设 `ProcessStartupPreset extends StartupPreset` 加那个字段**，方向自然是 `server → runtime`（已被允许的那一侧）。

### `pickStartupPreset` **零 `process.env`**

- 给了 `name` → 取已注册那份，**未注册直接抛**（fail-closed）。静默回落是最坏的一种失败形态：调用方点名要 `"sockss5"`、拼错成 `"socks5s"`，于是服务起来了但跑的是配置里那个协议——**「配错了、没报错、还起来了」**。
- 没给 `name` → 按**已经落进 store 的** `proxyProtocol` 现合成一份 `{ name: "protocol:<proto>", protocol: <proto> }`。⚠️ **非法值不在这里 throw**（`ConfigStore` 零校验，库路径能把 `"ftp"` 塞进来）：合成出的那份**不带 `protocol`**，于是 `createProxyRuntime` 落回 `protocolFor(config)` 那条 fail-closed 路径并报出「未知代理协议: ftp」。在这里 throw 等于把同一个错误信息在两个地方各写一份。
- **⚠️ 协议字面量判据 `isProxyProtocol` 是 `runtime/` 目录里的唯一一份，住在 `runtime.ts`**：派生自 `runtime.ts:PROXY_PROTOCOL_TABLE`（`satisfies Record<ProxyProtocol, true>` → 新增协议成员时**编译失败**），用 `Object.prototype.hasOwnProperty.call` 而不是 `in`（`in` 会沿原型链把 `"toString"` / `"constructor"` 这类**注册项名**当成合法协议）。`presets.ts` 经**同目录相对路径** `./runtime.js` import 它，**不引 barrel、不引 `@/runtime/index.js`**——`runtime.ts` 不 import `presets.ts`，故**无环**。
  - **这一份判据必须同时具备两件事，少一件调用点就会各写一份更弱的**：① **更严的 `hasOwnProperty` 语义**（表外值不因为是 `Object.prototype` 上的键就算合法）；② **表外值的抛错文案**（`未知代理协议: <值>`，有测试逐字锁着）。
  - **两个调用点、两种失败语义刻意不合并**：`protocolFor`（`runtime.ts`）在**构造期抛**；`pickStartupPreset`（`presets.ts`）**不 throw**、把非法值原样带出去，交给 `protocolFor` 报那**同一条** fail-closed 错误（同一个错误信息在两处各写一份是最容易漂移的那种重复）。护栏 `tests/unit/startup-preset.test.ts`（③ 合成出的那份不带 `protocol`；⑤ 覆盖不豁免校验 + 源码级把 `protocolFor(config)` 的调用点钉在 `assembly?.protocol ??` 之前）。
  - **`PROTOCOL_PRESET_TABLE` 仍带 `satisfies Record<ProxyProtocol, StartupPreset>`，但它不是协议判据的真相源**——那是「每个协议都得有一个具名预设」这条决策的穷尽性护栏，与「什么值算合法协议」是两件事。**别再从它的键派生第二份判据。**
- **正确的两条路**：① 选协议服务器用 `PROXY_PROTOCOL`——它本来就是这个职责的 env 键，由 `loadConfig` 收进 store、`context.accessor.get("proxyProtocol")` 读它；② 要**具名**装配就**程序化**传 `createProxyRuntime({ assembly })`，那份决策写在代码里，读者一眼看得见。
- **刻意不新增 `STARTUP_PRESET` 配置键**：为一个 preset 去动 `FIELDS` + `defaults` + `.env.example` + `setup-env.ts` + 两条护栏共六个文件，换一个已有键能做的事，不划算。
- **导入期零副作用**：模块加载只创建内置字面量与一张内存 `Map`（本文件唯一的模块级可变状态），不读 env/argv/文件、不动态加载插件、不注册进程事件。

## 依赖持有者（`context.ts`）

`RuntimeContext` 是三件套的**持有者**（`implements CoreContext`，经 `@/core/context.js` 引用只读面）：

- 构造参数 `{ config, logger, events }` 三项**全必填、全显式**，内部**零兜底/零懒初始化**（不得出现 `?? createNoopLogger()` / `?? new EventHub()`）——缺省解析只允许在 `createProxyRuntime()` 里做一次。
- 三个 setter（`setConfig`/`setLogger`/`setEvents`）统一四步：`===` 同一实例**直接 return 不发事件**（幂等无噪音）→ 先写内部字段 → 交换**之后**用**当前**总线发 `runtime.dependencies-changed({ kind })` → 发布整体 try/catch。观察者异常既不能让 setter 抛，也**绝不回滚已完成的交换**（容错风格同 `runtime.ts:publishRuntimeError`）。
- ⚠️ **三个 setter 的调用方全在库调用方，`src/` 内零调用是预期形态、**不是死代码**。**`ProxyRuntimeImpl` 把 `RuntimeContext` 经 `services` / `ProxyOptions.ctx` 暴露出去，这三个 setter 是库调用方唯一能在运行期热换配置 / 日志器 / 事件总线的入口；删掉它们库调用方就失去这个能力，而**本仓测试一条都不会红**（没有调用方就没有覆盖）。**推论（必须一起记住）**：正因为本仓内没人调 `setEvents`，`core/server/base.ts` 那两条「**绝不允许**把 `events` 缓存成字段」的强纪律**在本仓是靠注释与源码级断言维持的，不是靠运行时压力**——谁把它删了，全仓测试都不会红。本档能守的只有**接口可见性**（三个 setter 保持 public；`CoreContext` 只读视图上取不到它们），护栏在 `tests/unit/core-context.test.ts` 的「三个 setter：库调用方的公开面」那组——它**不能**证明有人真的在用它，如实记为限制。
- **`setEvents` 绝不 `removeAll()` 旧总线**：旧总线归它的创建者所有，本类没有所有权判断依据（先例是 `ProxyRuntimeImpl.ownsEvents`）。只换引用，不清理。
- `kind` 取值由 `AppEventMap` 的 payload 直接派生（`EventData<"runtime.dependencies-changed">["kind"]`），**禁止**另写第二份联合类型。类本身**刻意不 `Object.freeze`**（按设计可变）；可变的只有这个持有者，消费者拿到的仍是 `CoreContext` 只读视图。
- **装配链**：`ProxyRuntimeImpl` 持有唯一 `RuntimeContext` 实例（私有 `dependencies`），在 `logger`/`events` 两处缺省解析**之后**、构造 `normalizedOptions` 之前以 `{ config: this.context.accessor, logger: this.logger, events: this.events }` 构造，随后作为 `ProxyOptions.ctx` 交给 core。**全项目只有那两行允许做依赖缺省解析**（`options.logger ?? createNoopLogger()` 与 `options.events ?? new EventHub(...)`），core 与 `RuntimeContext` 内部一律零兜底。`bridge.ts:attach()` 收**强类型** `CoreContext`（传 `this.dependencies`），`bridge.ts` 内部零 `as unknown as`（**改 `ProxyOptions.ctx` 形状时由编译期兜住，不会出现「改名不报错」的坑**）。回归护栏 `tests/unit/core-context.test.ts`（构造注入、三 setter 各发恰好一条事件、幂等、观察者异常隔离、旧总线订阅保留、只读视图编译期护栏、零落盘）。

## 生命周期与事件

- `start()`、`stop()` 保持幂等；停止时先让 `BaseProxy` 完成 server close 与 `ConnRegistry` 排空，再**收流量配额账本**（`await closeTrafficLedger()`：摘定时器 → 最后一次落盘 → 关句柄。**停机落盘是正确性要求**：队列里「已计入内存判定、还没进磁盘」的字节丢掉的话，用户靠反复「用一点、Ctrl+C」就能把配额窗口内的额度一次次刷新），然后释放**本 runtime 自己创建**的 core 监听、`lifecycle.changed` 订阅、store 订阅与 ACL 文件事件订阅，绝不退出宿主进程。每次后续 `start()` 都重新建立 bridge/lifecycle/store/ACL 文件订阅**与账本**（`ledger.open()` 幂等），因此 `start→stop→start` 与 `stop-before-start` 后再启动都恢复完整链路。只有 runtime 自建 `EventHub` 时才在最后 `removeAll()`；外部 `events` 归调用方所有，stop 后其既有订阅必须保留。
- `start()` 先发布 `config.loaded`，其**载荷键是 `source`**（`{ source }`，由本目录 `sourceName(context)` 计算）按 `argv` > `environment` > `env-files` > `memory` 首次命中识别（混合来源只报告最高优先级），再启动 core。**状态桥接**：runtime **在 `this.events` 上订阅 `lifecycle.changed`**（core 的 `BaseProxy.setState` 直接发布，是这条事实的**唯一来源**），收到后按 `next` 派生 `starting/running/stopping/stopped` → `runtime.starting`/`runtime.started`/`runtime.stopping`/`runtime.stopped`；**runtime 绝不再自己发 `lifecycle.changed`**（core 已经发了，发第二遍就是「一条事实两个来源」）。因为 core 是发布方、runtime 是观察方，事件顺序是 `lifecycle.changed` 在前、它派生出的 `runtime.*` 在后（`tests/unit/proxy-runtime.test.ts` 按此顺序断言）。
- **`lifecycle.changed` 订阅进 start/stop 循环**（`activateSubscriptions()` / `releaseSubscriptions()`，与 bridge/store/ACL 文件订阅同一轮）：它是一条真实的 `EventHub` 订阅，泄漏就等于停机后监听残留。**`stopped` 跃迁仍能发出 `runtime.stopped`**：`stop()` 的执行顺序是 `await this.proxy.stop()`（内部 `doStop` 之后才 `setState("stopped")`）→ `finally { releaseSubscriptions() }`，`await` 落地时 `setState` 已 publish 完，订阅尚未摘除；护栏见 `tests/unit/proxy-runtime.test.ts`（stop 后 `listenerCount("lifecycle.changed")` 回到基线）。
- 启动/停止异常发布 `runtime.error`；启动异常额外通过 `onWarning` 以 `RuntimeWarning` 旁路报告，warning 回调异常不得遮蔽原错误。
- **启动期「配额失效」告警**：`start()` 里 `reportQuotaGate()` 在 `config.loaded` 之后调——判据是**文件事实**（`loadAuthUsers` 里至少有一个**非全 0** 的 `quota`）**加** `authEnabled === false`；命中则经 `onWarning` 上报 `{ code: "quota-inert", message: QUOTA_INERT_DETAIL }`。**为什么收窄到「真的配了非零配额」**：关鉴权本身是绝大多数部署的常态，只看 `authEnabled` 会让这条 warn 在没有配额的部署里也一直响，最终淹没真正需要看的告警；而「没配配额」时根本不存在「有东西没生效」。放在 `start()` 而非构造函数：只有真要跑的 runtime 才需要被告知。文案取 `core/log-events.ts:QUOTA_INERT_DETAIL`（与 CLI 落盘的 `[quota-inert]` 行是同一句话，两边各抄一份就会出现文档说 A、日志说 B）。
- **启动期「名单失效」告警（`acl-inert`）**：`start()` 里 `reportAclGate()` **紧跟** `reportQuotaGate()`（同一轮报告，顺序：先配额后名单），同样排在账本 `open()` 与 `core.start()` **之前**——两条都是「一次性事实」，都要在任何可能抛错的步骤之前报出去，否则启动失败时运维连「配置有洞」都不知道。
  - **它报的不是「access 缺省」**——`ProxyOptions.access` 是**编译期必填**，core 侧**不存在「缺省放行」的位置**。它报的是端口化之后**唯一**残留的静默失效形态：**调用方经 `services.access`（或 `assembly.services.access`）注入了自己的实现 ⇒ 本文件不解析 `createFileAccessControl(ctx.config)` ⇒ `acl.json` 那份名单**根本没被读**。这**是**正当用法（端口的意义就是换实现），但运维视角是「我配了名单怎么没生效」。
  - **判据是两个都必须成立的 AND**（与 `quota-inert` 同一手法：文件事实，不是猜配置）：① `hasConfiguredAcl(this.context.accessor, this.fileEventHandler)` —— `acl.json` 真配了内容；② `isAccessOverridden(this.services.access)` —— `access` 确实来自调用方注入。**少任一条都变成噪音**：① 缺了就是「没配名单也在报」，② 缺了就是「没配名单的部署狂报」。两条负向档是这档护栏的**主要价值**（正向档任何实现都会「碰巧」通过）。
  - **`hasConfiguredAcl` 的「读失败 → false」是刻意取舍**（详见 `src/config/AGENTS.md`）：读不到名单时**不告警**——那是「压根不知道配没配」而不是「配了却没生效」，报出来是**误报**；宁可少告警也不误报，因为一条会误报的告警在第一次误报之后就再也不会被看，那等于把这条告警永久关掉。真正读不到文件时**另有**可见信号：`readJsonCached` 经 `onEvent` 报 `error` → runtime 发 `config.file-error` → CLI 落日志。
  - **只报一次**：告警是启动期一次性事实，**不是每请求**。护栏按 `warnings.filter((w) => w.code === "acl-inert")` 断言**恰好**条数（不是 `>= 1`）。
  - 文案取 `core/log-events.ts:ACL_INERT_DETAIL`（与 CLI 落盘的 `[acl-inert]` 行是同一句话）。⚠️ **文案逐字点名三组名单各自的后果**（`clientIp`/`target` 失效 = 该拒的没拒；`upstream` 失效 = 该回落直连的仍走上游）——判据只能答「有没有配」（布尔），**答不出是哪一组**，所以文案给的是「哪一类没按预期发生」而不是假装知道具体是哪一组。
  - 护栏：`tests/integration/acl-inert-warning.test.ts`（真 runtime 三档 + CLI 落盘行逐字 + `onWarning` 白名单源码级）、`tests/unit/acl-configured.test.ts`（`hasConfiguredAcl` 真值表七档 + 「只经 `loadAcl`、零新增 `readJsonCached` 调用点」源码级）。
- JSON 文件状态迁移由同一个 `fileEventHandler` 转发到公共 `EventHub`（`renderFileEvent` 先渲染日志、再发事件，顺序固定）：`error`/`missing` → `config.file-error`（`error` 按真值判定，缺失回落 `"文件消失"`）、`recovered` → `config.file-recovered`、`reloaded` → `config.file-reloaded`，三者 payload 都只带 `{ path }`（`file-error` 另带 `error`）。**三条同轴**：名单坏了 / 名单回来了 / 名单已换成新的；`reloaded` 语义由读取层判定（**这一次真读了内容、且此前已有缓存条目**），runtime 只负责往外发布，**不改节流与判定**。
- runtime 重新装配的文件订阅必须把相对路径先绝对化；`readJsonCached` 仅把 `ENOENT`/`ENOTDIR`/非普通文件视为 missing，其它 stat 错误保留上一份有效值并发 `error`，不能让 ACL 因 `EACCES` 等静默全放行。
- 手工传入的 `ConfigContext` 仍须遵守对象工厂契约：`configDir` 必填，`startupKeys` 不是工厂入参并固定来自完整 FIELDS startup 集合；runtime 不提供位置参数或隐式 cwd 兼容层。
- TLS 协议是 `https`、`sockss4`、`sockss5`；明文 `http`、`socks4`、`socks5` 不读取或传递 TLS 路径。

## 与 CLI 的分工

`src/cli.ts` 是唯一宿主来源组合根，`src/server/index.ts` 拥有配置快照打印、cluster、信号、优雅退出和**进程级的日志编排**（banner / `[config]` / `[start]` / `[shutdown]` 那几行）。⚠️ **`[lifecycle]` 不属于那份名单**——它与那 11 类一起在**本目录**的 `event-log.ts`（见下节）。CLI 显式 `await loadConfig()` 后把 `ConfigContext` 与 `cliPreset()` 交给 `runServer(context, { … })`，server 再以同一 context 构造 runtime；库调用方通常只拿 `createProxyRuntime()` 门面。runtime 不读取 env/argv、不调用加载器，也不 import server/cluster 以恢复副作用。**`ProcessPolicy` 端口刻意不扩到本目录**——`runtime → server` 是被禁方向，把 `forceExit` 塞进 runtime 选项等于让库调用方拿到一把上膛的枪（一个 `process.exit(0)` 藏在「配置」里）。⚠️ **但「代理事实 → JSONL 落盘」那 11 类订阅**与**`[lifecycle] state …` 那一行**都在本目录（`event-log.ts`），它们是 CLI 与库**共用**的一份——判据见下节。

## 事件 → 落盘绑定（`event-log.ts`）

`bindProxyEventLogs(hub: EventHub, logger: Logger): () => void` —— core 只抛事实、从不直接落盘；本文件是那层**翻译**：把 `EventHub` 上的公共事件收成 `[{event-code}]` / `[route]` / `[forward]` / `[auth] deny` 之类稳定可 grep 的日志行。**事件函数全部从 `@/core/log-events.js` 取**（`logUpstreamRefused`/`logLoopDetected`/`logBadRequest`/`logQuotaExceeded`/`logQuotaLedgerError`/… 及 `LogEvent`）——词表的唯一直接调用方是 `core/server/*`，放进程层会逼出 `core → server → core` 的目录环。**同文件还有第二族绑定 `bindLifecycleLog`（`[lifecycle] state …` 那一行）——它与本族同判据、同一轮装配与释放，正文见下面专门那一小节。**

### 为什么在这一层（判据：「谁声明拥有这个进程」）

**落盘不拥有进程。** 不装信号、不 fork、不 `process.exit`、不读 `process.env`、不写 `process.env`——整个函数只有 `hub.subscribe(name, handler)` 与 `logger.debug/info/warn/error` 两种动作，**零 `process` 触点**，是纯函数式依赖注入。**把落盘挂在「拥有进程」那一层是陷阱而不是能力**：

- 库调用方**没有这个能力位**可用：`createProxyRuntime()` 那条路上落盘对它完全不可见，于是要么接受没有落盘日志，要么自己重写那 11 个订阅、还要自己记得在 `stop()` 时退订（漏了就泄漏监听器）。
- 它明明零 `process`，却坐在「拥有进程」那一层，读者只能推断「落盘 = CLI 面 = 进程面」。

住在库层**不新增任何依赖边**：`server/` → `runtime/` 是既有方向（`ProxyServer` 调 `createProxyRuntime`）。CLI 侧与库侧因此是**同一份绑定**，日志行一条不多一条不少（护栏：`tests/integration/library-event-log-binding.test.ts` 的「CLI 等价性」那档，同一份流量两条路径落盘行**逐字段相等**）。

### 事件映射表（文本契约的可读索引，**改任何一条必须同步改这里与 `tests/integration/log-structured.test.ts`**）

| core 事实（旧事件名） | 订阅的公共事件 | 落点 |
|---|---|---|
| `forward` | `forward.request-headers` | `[{kind}] headers` debug |
|  | `request.started` | `[forward]` info |
| `forwardError` | `forward.error` | `forwardXxx error` error |
| `serverError` | `server.error` | `server error (host:port):` error |
| `clientError` | `server.client-error` | `[bad-request] client error: …` warn |
| `auth` | `auth.decided` | `[auth] allow` debug / `[auth] deny` info |
| `listening` | `server.listening` | `listening on host:port` debug |
| `close` | `server.closed` | `server closed` debug |
| `pipe` | `pipe` | 按 `type` 落 `[event-code]` / `[route]` |
| （core 直发公共事件，无前驱事件名） | `traffic.quota-exceeded` | `[quota-exceeded]` warn |
| （core 经 `onLedgerError` 上报） | `traffic.ledger-error` | `[quota-ledger-error]` error |

`FORWARD_ERROR_LABEL` 的索引类型是 `ProxyForwardKind`（`Record` 保证新增 kind 时编译期必补；键值 `http`/`tunnel`/`upgrade` → `forwardHttp`/`forwardTunnel`/`forwardUpgrade`，**这三个键值是文本契约的一部分**）。**身份维度（`client`/`target`/`user`/`method`）从 `EventEnvelope.context` 读**（`method` 由 core 写进 context，`request.started` 的 data 恒为 `{kind}`）。`[auth]` allow→debug、deny→info，`pipe: route` 与 `[route]` info 行 1:1，`upstream-error` 带 target/err.message 落 warn（保留 502 成因，否则默认分支的 debug 会把「为什么 502」淹掉），文本/等级/字段与 JSONL 契约不变。

### 四条必须记住的细节

- **`[{kind}] headers` 那行的数据源是 core 侧已掩码的事件**：唯一来源是 `forward.request-headers`（`maskSensitiveHeaders` 住在 `core/server/http.ts`，**在 publish 之前完成**）；文本格式 / debug 等级 / `client`·`target`·`headers`·`user` 四字段（**含顺序**）是这条文本契约的一部分，改任何一样都要改护栏。core 在 `handleForward` 里**先发 headers 事件再发 `request.started`**，保持落盘行序。⚠️ **掩码必须早于 publish**——事件总线对库调用方可见，原始 `Proxy-Authorization`/`Authorization`/`Cookie` 绝不允许跨进去；`req` / `IncomingMessage` 也绝不进入任何事件载荷。回归护栏：`tests/integration/log-structured.test.ts` 的「请求头 dump」用例（文本/等级/字段/掩码 +「原值不出现在整个文件」）与 `tests/unit/core-event-bridge.test.ts`（掩码发生在 publish 前 + **该事件确有订阅者**，防「只发不订阅」静默删行）。
- **listener 不需要 try/catch**：`EventHub` 已隔离单个 listener 的异常并交给 `onListenerError`，且不阻断同事件名的其它 listener。
- **`[target-denied]` 行文本**：`<target> 拒绝 reason=<reason> source=<global|user>`，结构化字段同步多一个 `source`（判定层没给 `source` 时**文本与结构化字段都只有这一项**，靠条件拼接而非无条件加键）。理由是可观测性：403 单看 `reason` 分不出是全局黑名单还是某个用户的个人名单，运维不知道该改 `acl.json` 还是 `users.json`。⚠️ **`reason` 本身是自由 `string`**（`AccessDecision.reason` 随端口放宽）——落盘文本原样透传，**内建引擎仍只出 `whitelist|blacklist`**，自定义策略引擎出的 `"rate-limited"` 之类也照原样落盘。
- **两条 quota 事件都不走 `pipe` switch**：`traffic.quota-exceeded`（`[quota-exceeded]` warn，文本契约 `<user> 配额耗尽 dir=<up|down> scope=<up|down|total> usage=<n> limit=<n>`，结构化字段 `user`/`dir`/`scope`/`usage`/`limit` 同名，jq 侧可查）由 `core/forward/base.ts:publishQuotaExceeded` **直发公共事件**；`traffic.ledger-error`（`[quota-ledger-error]` error）由 `core/traffic/ledger.ts:report` 经 `services.ts` 注入的 `onLedgerError` 闭包把 `TrafficLedgerError` 转成公共事件。**它们是独立的公共契约而不是管道细节**，**刻意没往 `PipeEvent` 判别联合加变体**（那会让 14 变体的穷尽清单与两处既有测试同时要改），所以 **`pipe` 的 14 变体 switch 一字未动**。`[quota-ledger-error]` 的文案契约见 `logQuotaLedgerError` 的注释：**必须包含「内存计数继续」与「不要为此重启」**——看到一条 error 的第一反应是「要不要重启」，而正确处置恰恰相反（重启会丢掉队列里未落盘的增量）。

### 生命周期那一行：`bindLifecycleLog`（**与上面那族同判据、同装配轮**）

`bindLifecycleLog(hub: EventHub, logger: Logger, protocol: ProxyProtocol): () => void` —— 订阅公共事件 `lifecycle.changed`，落**一条** `debug` 行：`[lifecycle] state <prev> -> <next> protocol=<protocol>`，**无结构化字段**。文本 / 等级 / 字段**是 CLI 的文本契约、逐字不变**；协议取自 `runtime.ts` **自己那个 core 实例**的 `this.proxy.protocol`。

**它与 `bindProxyEventLogs` 逐条同源的三条判据**：① **零 `process` 触点**（`hub.subscribe` + `logger.debug`）；② 分界线是「谁声明拥有这个进程」，落盘**不拥有进程**；③ 与 bridge / store / ACL 文件 / 11 类代理事实**同属一轮** `activateSubscriptions` / `releaseSubscriptions`。

⚠️ **「它是 CLI 的文本契约」不构成不同判据的理由**——`bindProxyEventLogs` 那十几条文本**也全是契约**。**文本契约约束的是「那几行逐字不变」，不是「住哪一层」**；CLI 那一行**逐字不变**（护栏 `tests/integration/lifecycle-log-binding.test.ts` 第 ③ 档）本身就是判据的一部分。给两族配不同判据会造出「凭什么这个特殊」的不对称——**那种不对称本身就是缺陷**，因为它是下一个人凭直觉做错事的起点。

- **同文件、独立导出**（不并进 `bindProxyEventLogs`）：本文件的身份就是「EventHub 事实 → 注入的 logger」这一跳，拆两个文件只会造出两套同纪律的绑定器；而「11 类映射表」是文本契约的可读索引，掺进一条服务期事实只会更难核对。两条退订闭包在 `runtime.ts` 同一轮里**各自**装配与释放，生命周期归属仍然只有一个权威。
- **绑定受同一个 `eventLogs` 位控制**（缺省 `true`）：`eventLogs: false` 时两条族都不绑（护栏第 ② 档：零 `[lifecycle]` 行、**但事件面照常**——四次跃迁宿主自己一条不少）。
- ⚠️ **`isWorker: true` → 零行**：那一行是 **cluster master 独有**的（`ProxyServer` 只在非 worker 时绑它；worker 的 ready 面走 IPC 上报、由 master 汇总打 banner）。**runtime 绝不读 `cluster.isWorker`**——它连 `process` 都不碰，worker 身份只能经 **`ProxyRuntimeOptions.isWorker` 显式传进来**（传递链 `ProxyServer.isWorker()` → `createRuntime()` → 本选项 → `runtime.ts` 的装配判断），与 `trafficWorkerSlot` **同一手法**：槽位会被拼进账本文件名、「自己猜来源」= 写错文件；worker 身份决定一行日志落不落盘、「自己猜来源」= 每个 worker 每轮启停多四行噪音。**库调用方没有 cluster 这个概念，所以只能由调用方申报**；缺省 `false` = 单进程 / 库模式。
  - `ProxyOptions.isWorker` **如实来自本选项**（`options.isWorker ?? false` → `normalizedOptions.isWorker`），**没有任何地方把它截断**——那道 master-only 的门就是靠它关上的，它读不到真值这道门就形同虚设。
- **护栏**：`tests/integration/lifecycle-log-binding.test.ts`（12 例，六档：文本/等级/字段逐字 + 退订幂等且只摘自己 / 纯库路径真落盘恰好 4 行 / **CLI 与库逐字段相等** / `start→stop→start` 不叠加 / `isWorker` 与 `eventLogs: false` 两条负向 / 源码级双绑零容忍）。⚠️ **那一档的断言必须与 JSONL 行序无关**——见 `tests/AGENTS.md` 记的「appendFile 不保序」那条教训。

### 绑定与释放落在 `activateSubscriptions` / `releaseSubscriptions`（同一轮）

**刻意不进构造函数、也不留在 `ProxyServer` 的观察面里**：那组循环就是「`start` 重建、`stop` 全退」的**唯一权威**（`subscriptionsActive` 幂等旗标 + `releaseSubscriptions` 的对称清理都只管这一组），绑定漏在外面就会在 `start → stop → start` 之后**叠加**——每轮多一份订阅，同一条 `[forward]` 落 N 次。`activateSubscriptions` 的 catch 回滚路径也调同一个退订闭包，**不留下半轮订阅**。

**总线取 `this.dependencies.events`（`RuntimeContext` 的**当前**那条）而不是构造期的 `this.events`**：与 `CoreEventBridge.attach(ctx)` 里 `ctx.events` 同一纪律——`RuntimeContext.setEvents()` 能在运行期换总线，core 发布时读的也是 `ctx.events`，取错会「core 发新总线、落盘听旧总线」而静默丢整段日志。退订由**闭包携带归属**（每个 `EventSubscription.dispose()` 靠闭包持有自己的 hub 记录，且全部引用都在闭包内），换总线也不会退错。

### 退订：归属由闭包携带，不存 `{ hub, subscription }` 那一对

⚠️ **退订必须自带归属**：`EventSubscription.dispose()` 靠闭包持有自己的 hub 记录，**对着另一个 hub 调用等于静默空操作**；`RuntimeContext.setEvents()` 能在运行期换总线，只存 `subscription` 就丢了「这条订阅当初挂在哪条总线」的归属信息。**退订函数就该是闭包**——全部订阅引用都在闭包内、由它自己 `splice(0)` 清空，归属问题从根上不存在。

**`ProxyServer` 那一层对 `EventHub` 的使用只剩「注入的那条总线」与 `ProxyServerOptions.events`**：两族绑定都由 `event-log.ts` 里那个**自带归属的幂等闭包**承担，它不存订阅数组、不存 `{ hub, subscription }` 那一对。⚠️ **别给两族配不同判据**：「lifecycle 那一行特殊」不是理由——两条的判据逐条同源，那种不对称正是下一个人凭直觉做错事的起点。

**幂等由 `splice(0)` 提供，不另设 `released` 布尔标志**：清空数组之后第二次迭代的就是空数组，而 `EventSubscription.dispose()` 自己也是幂等的，两层各自成立。再加一个标志只是「看起来更安全」的重复保险，且它**测不出来**（变异验证：摘掉它本文件行为一字不变）——本仓对死可选性零容忍（`unit/dead-optionality-cleared.test.ts`），故不加。⚠️ **退订绝不许改用 `hub.removeAll()`**：总线可能属于宿主（`createProxyRuntime({ events })`），连带清掉别人的订阅就是越权（护栏 `library-event-log-binding` 的第 ⑤ 档就钉这一条）。

### `options.eventLogs`（缺省 `true`）

**它不是兼容开关，是一个真实的正交能力位。** 缺省 `true` = 绑定；显式 `false` = 不绑定，两种真实场景：① **调用方自己已接了事件桥**（`runtime.events.subscribe("pipe", …)` → 自己的遥测/日志；`pipe` 那 14 个变体 + `auth.decided` 的完整载荷它都拿得到，代理事实落两遍是噪音）；② **不想让代理事件进自己那个 logger**（`logger` 是宿主应用级 logger，同一个 Electron 主进程 / 服务进程里还跑着别的东西，`[proxy]` 前缀的逐请求行会淹掉它）。

⚠️ **缺省必须是 `true`**：CLI 一直是**恒绑定**的，**改这个缺省就会直接改变 CLI 行为**。「CLI 一条不多一条不少」由**缺省值**兑现、不靠这个开关。⚠️ **传了 `logger` 就意味着「我给了代理一个日志端口」，缺省绑上正是那个端口的预期语义；不想要就得显式说 `false`——沉默不等于同意。** ⚠️ **不绑 ≠ 事件没了**：事件仍照常发布在 `runtime.events` 上（`traffic.ledger-error` / `access.*` / `route.selected` 等公共契约一条不少），本项只关掉「事件 → 这一个 logger」这一跳。

⚠️ **反过来「绑了」也 ≠ 「有落盘」——落盘还取决于有没有注入真实 logger。** 库调用方配了 `logFile` 却没显式 `createLogger({ config })`，本项缺省 `true` 也照样**一行不写**，因为 runtime 缺省 `logger` 是 `createNoopLogger()`（**零副作用铁律要求缺省必须是 noop**，「库默认替我建个会写文件的 logger」不在授权范围内）。方向是安全的（「缺席 = 不写盘」而不是「缺席 = 全写」），但足以让人误判成 bug：**`LOG_FILE` / `LOG_FILE_LEVEL` 是 _logger_ 的配置、不是 runtime 的**，要落盘就得给一个带文件 sink 的 logger（CLI 走的就是 `cli.ts` 里那一步）。⚠️ 这条是发布前 tarball 烟测**实测撞出来的**（第一次端到端跑完 jsonl = 0），不是推导出来的。

### 零副作用 + 日志端口类型

**零副作用**：只订阅，不注册进程事件、不读 env、不写文件。真正的 IO 在 logger 那一侧（`LoggerImpl` → `jsonl.ts`）；传进来一个 `createNoopLogger()`（runtime 缺省）就是零落盘，故「库入口静态 re-export 了本模块」不等于「import 期就在写日志」。

**日志端口类型是 `Logger` 接口而不是 `LoggerImpl`**：`Logger` 的 `debug/info/warn/error` 签名是 `(...args: unknown[])`——**末位 plain object 参数即结构化字段**（`log-events.ts` 的 `EventLog` 也是同一个最小面），**端口类型够用，不需要 `LoggerImpl`**，全部调用点在 `Logger` 下逐字成立。落盘要能对**任何**注入的 logger 生效，端口就不能绑死在某一个实现类上——这正是用接口的理由。⚠️ 本目录**不得**因此去 import `LoggerImpl`（那是 `utils/` 的实现类，`Logger` 才是端口）。

## 事件桥接（`bridge.ts`）

**本文件只有一件事**：把 `pipe` 的三个公开形状翻译成公共 `AppEventMap` 事件。core **直接**发布 `auth.decided` / `request.started` / `forward.error` / `server.error` / `server.client-error` / `server.listening` / `server.closed` / `pipe`，其中前两类**不经本文件桥接**（桥一遍就是重复发布）。它与 `./event-log.ts:bindProxyEventLogs` 是两条互不 import 的面：后者是**日志面**（同一批事实 → JSONL 落盘 / 注入的 logger，CLI 与库共用），本文件是**库事件面**（`pipe` → 公共事件）。

- **端口**：`CoreEventBridgeOptions` = `{ hub, protocol, extractClient?, extractTarget? }`（提取器缺省 `getClientAddress` / `getAuthority`）。**`attach(ctx: CoreContext)` 收强类型的 `CoreContext`**：`ctx.events` 给出「core 当前那条总线」、`ctx.config` 给出 publisher 注册表要的 accessor。runtime 侧传 `this.dependencies`（`RuntimeContext`），`bridge.ts` 内部零 `as unknown as`。**总线取 `ctx.events` 而非构造时的 `options.hub`**：`RuntimeContext.setEvents()` 能换总线，core 发布时读的也是 `ctx.events`，取错会「core 发新总线、桥接听旧总线」而静默丢事件；退订用**订阅那一刻**的 hub，换总线也不会退错。
- **映射契约**（3 条，无其它）：`pipe: ip-denied` → `access.client-denied`（`{client,reason}`）；`pipe: target-denied` → `access.target-denied`（`{host,target,reason,source?}`）；`pipe: route` → `route.selected`（`{mode,route,reason?}`）。
- **缺失即跳过，绝不臆造**：`reason` / `source` **一律原样透传**——端口是自由 `string`，自定义策略引擎（限速 / 地域封锁 / 订阅网关）判出的 `"rate-limited"` / `"geo-blocked"` 照常发布。⚠️ **`host` 缺失有正当的跳过理由**（「公共契约必填项缺失」），**`reason` 表外值绝不能落到同一个 `return`**——那等于**安全事实消失**（一次拒绝在事件流里彻底不见），比「载荷里带一个没人认识的 reason」坏得多。**另一半纪律**：`reason` 缺失/空串**仍不发布**（载荷里没有 reason 就没有「为什么被拒」这条事实，**禁默认成 `blacklist`**）；`target-denied` 的 `host` 缺失同样跳过（公共契约必填），`target` 缺失回落 `host`；必填 `client` 缺失回落 `"unknown"` 哨兵（沿用 `getSocketAddress` 约定）；`source` 缺失**不倒填成 `global`**（会把「个人名单拒的」伪装成「全局拒的」，运维去改错文件）。**分层信息一律走独立的 `source` 字段、绝不塞进 `reason`**（写成 `"user:blacklist"` 那类值既让消费方认不出，又把两个维度挤进一个字段）。护栏：`tests/unit/core-event-bridge.test.ts` + `tests/integration/custom-services-wiring.test.ts`（用一个**在闭合集之外**的 reason 断言它确实被发布）。
- **身份提取 DI**：`extractClient` / `extractTarget` 只在**已映射变体发布前**、且事件自带字段缺失时对 `PipeEventBase.req`（`unknown` → 按「有 headers 的对象」收窄）发生；空串视为缺失。桥接器**忽略** core 已写进 context 的身份维度，context 完全由 pipe 载荷（+ req 兜底）重建——这是**刻意只认载荷**的选择，避免「同一维度两个来源」。
- **context**：恒含 `{runtimeId, protocol}`；`access.*` / `route.selected` 按 pipe 已提供的真实字段补 `client`/`user`/`target`/`requestId`/`connectionId`，缺失就不臆造。请求终态 publisher 也沿用 `RequestTerminal` 传入的作用域，使 `access.*` / `route.selected` 与 `request.completed|rejected|failed` 可按同一 requestId 串联。
- **刻意不桥接**：`pipe: target-unresolved` **必须**不桥（它的事实已由协议入口的 `requestTerminal.reject(..., "parse", 400)` 经终态 publisher 发布过一次，桥一遍只是重复发布）。**新增映射前先确认该事实没有已由终态 publisher 发布过**。`pipe` 其余 10 变体 `upstream-refused`/`upstream-error`/`upstream-timeout`/`loop-detected`/`socks`/`bad-request`/`dial`/`established`/`client-error`/`debug` 没有对应公共形状；`onPipe` 的 `default` 显式列出（含 `target-unresolved`，共 11 个）并以 `e satisfies never` 收口。
- **纯观察 + 异常隔离**：`observePipe` 的回调体整体 try/catch（`EventHub` 已隔离 listener 异常，但提取函数/身份组装/发布也不能把观察者的异常带回 core 主流程）；本文件不读 env/文件、不注册 `process` 事件、不打日志。
- **清理顺序与所有权**：`ProxyRuntimeImpl.stop()` 的 `finally` 先 `bridge.subscription.dispose()` 摘订阅，再摘 `lifecycle.changed` 订阅、退订 store/ACL 文件事件；仅当 `ownsEvents` 为真才 `events.removeAll()`。外部 EventHub 上的宿主订阅不得被 runtime 清空；下一次 `start()` 必须重新 attach bridge、`lifecycle.changed` 与文件/store 订阅，`stop-before-start` 也不能让后续启动丢链路。`subscription` 是多订阅合成解绑点（`pipe` 订阅 + 终态 publisher 退订），`dispose()` 幂等，dispose 后由下一次 start 重新建立。
- 回归护栏：`tests/unit/core-event-bridge.test.ts` 锁定三条 pipe 映射、缺失字段跳过、身份提取 DI、观察者隔离与 dispose 幂等，**外加「core 直发 `auth.decided` / `request.started`」与「三类错误事实零派生事件」两组断言**（前两组用真实 `BaseProxy.authorize()` / 真实 `HttpProxy` 请求驱动，后一组断言 `forward.error`/`server.error`/`server.client-error` 原样到达且**不派生**任何 `request.rejected|failed`——终态唯一来源仍是 `RequestTerminal`）；`tests/unit/proxy-runtime.test.ts` 锁定 context/live store、startup accessor/options 冻结、`UPSTREAM_URL` 重建要求、`configDir` 不随 `process.chdir()` 漂移、`start→stop→start`/`stop-before-start` 的 bridge/`lifecycle.changed`/store/ACL 文件订阅重建（现以 hub 上 `pipe` 与 `lifecycle.changed` 的 listenerCount 为 core 订阅数）、`lifecycle.changed` 每跃迁恰好一条且顺序在 `runtime.*` 之前、stop 后订阅归零，以及 stop 不清外部 EventHub；`tests/library/entry.test.ts` 从包入口验证双 runtime 隔离。
