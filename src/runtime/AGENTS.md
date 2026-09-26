# src/runtime — 第三方库门面

`runtime/` 是把仓库当作库嵌入时的唯一公开装配层。它负责把调用方给出的 `ConfigContext`（共享 live store）或纯内存 `config`/`preset`（内部私有 store），连同服务替身、事件总线和日志端口接到协议核心；纯内存模式可显式提供 `configDir` 作为路径锚点。协议实现、连接排空和生命周期状态机仍由 `src/core/server/` 负责。

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
- **纯内存 `config` 模式不跑 `FIELDS` 校验，非法枚举值能进 store**：本模式把 `preset` + `config` 展开后灌进私有 `new ConfigStore(...)`，而 `ConfigStore` **零校验**（不跑逐字段解析 / 范围 / 交叉校验——那是 `loadConfig` 的职责，见 `src/config/AGENTS.md`）。因此 `createProxyRuntime({ config: { upstreamProtocol: "ftp" } })` 这类调用**会**把非法值带进运行期，CLI 路径的 `FIELDS.parseEnum` fail-fast 在这里**不适用**。这条决定了 core 侧对非法 `upstreamProtocol` **必须 fail-closed 抛错**（静默降级直连＝流量旁路，见 `src/core/AGENTS.md`「上游协议 fail-closed」）：想要「配置错就启动报错」的健壮性，位置在**配置校验层**，不是请求期兜底。护栏 `tests/integration/upstream-protocol-fail-closed.test.ts`。
- facade 的**直接配置字段**只有 `readonly context: ConfigContext`；**不再公开**独立的 `config` 或 `configAccessor` 字段，也不在 facade 复制另一份可变配置。`runtime.options.ctx.config` 仍只是归一化 `ProxyOptions` 暴露的同一个必填 accessor，不是第二个配置入口。需要快照用 `runtime.context.config`，需要写 live store 用 `runtime.context.store`。
- `services.auth` 未提供时由 `createAuthFromConfig(runtimeAccessor, fileEventHandler)` 装配；显式 auth 优先。扩展服务保持同样的“默认实现 + 可覆盖替身”形状。
- **`services.traffic`（Phase 5a）**：未提供时由 `createMemoryTrafficAccount((user) => loadUserQuota(user, accessor, fileEventHandler))` 装配，**全项目唯一解析默认流量配额服务的地方**——core 与四个转发器只拿端口、拿到的却是这份读 users.json 的内存账本。显式注入优先且原样透传（`runtime.options.traffic === runtime.services.traffic`，库调用方注入的替身一定生效；护栏 `tests/integration/traffic-quota.test.ts` 的「默认解析只发生在唯一组装点」）。core 侧的 `ProxyOptions.traffic ?? 显式禁用档` 因此永不生效，它只是给**直构 core** 的低层调用方一个语义明确的答案（与 `auth ?? new Auth({enabled:false})` 同构）。
- **`services.traffic` 的窗口口径也只在这里注入（Phase 5b-1）**：`TrafficWindowSource.resetHour` 是一个经**当前 runtime accessor** 的闭包（`() => configAccessor.get("quotaResetHour")`）——`quotaResetHour` 是 runtime 相位字段，故每次访问现读，**热改 `store` 立即改变窗口边界、不必重建 runtime**（护栏 `tests/unit/traffic-window.test.ts` 的「热改 resetHour 即时改变窗口边界」）。`now` **刻意不注入**：账本只用它算窗口键、窗口滚动是**惰性**的（每次访问槽位时比对窗口键），故生产路径不需要可注入时钟。**账本本身零配置依赖**（配额来自注入的 `QuotaResolver`、窗口来自注入的 `TrafficWindowSource`），与「runtime 不给 core 做缺省解析」这条铁律同向。
- **`services.trafficLedger`（Phase 5b-2）与其零副作用纪律**：`buildDefaultServices(configAccessor, overrides, onFileEvent, host)` 的第四个形参 `host: TrafficLedgerHost` = `{ slot?, onLedgerError? }`。**槽位是显式字符串**（`host.slot` ← `options.trafficWorkerSlot` ← `ProxyServer.trafficWorkerSlot` ← CLI 的 env 快照 `PROXY_WORKER_SLOT`）——**runtime 一律不读 `process.env`**：槽位会被拼进账本文件名，「自己猜来源」=「写错文件 / 读别人的账」，而库调用方（浏览器/worker/测试）可能压根没有那个对象。
  - **构造零副作用**：`new JsonlTrafficLedger(...)` 只算出一个文件路径（`path.join(dir, "worker-<slot>.jsonl")`，**纯字符串计算、不 stat 磁盘**）。目录、句柄、定时器全部由 `runtime.start()` 触发的 `ledger.open()` 创建 —— 这与「构造 runtime 不得读 env/文件」的零副作用铁律同向，**不要**把 `open()` 挪进构造函数。
  - **与默认内存账本同生共死**：调用方**显式注入** `services.traffic` 时 `trafficLedger` 恒为 `undefined`（那一本账归调用方管，我们不写它的文件、不给它起定时器、也不发它的落盘事件）。注入本类构造**零开销**（不 `mkdir`、不 `open`）。
  - **恢复回注两步走**（`account.bindSink(ledger)` 之前先 `new MemoryTrafficAccount(resolve, window)`，账本的 `onRestore` 闭包调 `account.seed`）：顺序反过来就得写「用前未赋值」的闭包，那是本仓明确不接受的形状。
  - **`hasConfiguredQuota(configAccessor, onFileEvent)` 从 `runtime.ts` 搬到了本文件**并**导出**：它既是账本零成本档的判据，也是 `quota-inert` 告警的判据，**必须是同一份**（两处各写一份，迟早出现「告警说没配、账本说配了」）。护栏 `tests/unit/traffic-ledger.test.ts` 逐档断言（全 0 / 只配 window / 任一非零子字段 / 文件缺失）。
  - **`runtime.start()` 的次序不可调换**：`activateSubscriptions → config.loaded → reportQuotaGate → await openTrafficLedger() → proxy.start()`。账本**必须在 `core.start()` 之前**开完：恢复与启动期压缩都读同一个文件，「先收流量再恢复」会让本进程的增量与恢复出来的账互相覆盖。`openTrafficLedger()` 抛错**绝不让启动失败**（账本是增强面，磁盘坏了不该让代理起不来；失败事实已由账本自己经 `onLedgerError` 上报）。
  - **`runtime.stop()` 的 finally 里 `await closeTrafficLedger()`**：排在 `releaseSubscriptions()` **之前**（账本的 `onError` 要经这条总线发 `traffic.ledger-error`）与 `proxy.stop()` **之后**（排空期间还有在途字节在计量）。`ProxyServer.stop()` 的 finally 里也调一次（幂等空转）——见 `src/server/AGENTS.md`。
  - **事件面**：`onLedgerError` 只 `publish("traffic.ledger-error", { path, error })`，**不落日志**（日志落盘是 server 层 `bindProxyEventLogs` 的职责；库调用方订阅不到就什么也不输出）。
- `events` 未提供时每个 runtime 自建一个 `EventHub`；提供时必须原样使用外部实例。`logger` 未提供时使用 noop，不把 core 改成 CLI 策略。

## 依赖持有者（`context.ts`）

`RuntimeContext` 是三件套的**持有者**（`implements CoreContext`，经 `@/core/context.js` 引用只读面）：

- 构造参数 `{ config, logger, events }` 三项**全必填、全显式**，内部**零兜底/零懒初始化**（不得出现 `?? createNoopLogger()` / `?? new EventHub()`）——缺省解析只允许在 `createProxyRuntime()` 里做一次。
- 三个 setter（`setConfig`/`setLogger`/`setEvents`）统一四步：`===` 同一实例**直接 return 不发事件**（幂等无噪音）→ 先写内部字段 → 交换**之后**用**当前**总线发 `runtime.dependencies-changed({ kind })` → 发布整体 try/catch。观察者异常既不能让 setter 抛，也**绝不回滚已完成的交换**（容错风格同 `runtime.ts:publishRuntimeError`）。
- **`setEvents` 绝不 `removeAll()` 旧总线**：旧总线归它的创建者所有，本类没有所有权判断依据（先例是 `ProxyRuntimeImpl.ownsEvents`）。只换引用，不清理。
- `kind` 取值由 `AppEventMap` 的 payload 直接派生（`EventData<"runtime.dependencies-changed">["kind"]`），**禁止**另写第二份联合类型。类本身**刻意不 `Object.freeze`**（按设计可变）；可变的只有这个持有者，消费者拿到的仍是 `CoreContext` 只读视图。
- **本切片已接线（持有者已进装配链）**：`ProxyRuntimeImpl` 持有唯一 `RuntimeContext` 实例（私有 `dependencies`），在 `logger`/`events` 两处缺省解析**之后**、构造 `normalizedOptions` 之前以 `{ config: this.context.accessor, logger: this.logger, events: this.events }` 构造，随后作为 `ProxyOptions.ctx` 交给 core。**全项目只有那两行允许做依赖缺省解析**（`options.logger ?? createNoopLogger()` 与 `options.events ?? new EventHub(...)`），core 与 `RuntimeContext` 内部一律零兜底。`bridge.ts:attach()` 也已从 duck-typed 端口换成**强类型** `CoreContext`（传 `this.dependencies`），`bridge.ts` 内部零 `as unknown as`（**改 `ProxyOptions.ctx` 形状时由编译期兜住，不再有「改名不报错」的坑**）。回归护栏 `tests/unit/core-context.test.ts`（构造注入、三 setter 各发恰好一条事件、幂等、观察者异常隔离、旧总线订阅保留、只读视图编译期护栏、零落盘）。

## 生命周期与事件

- `start()`、`stop()` 保持幂等；停止时先让 `BaseProxy` 完成 server close 与 `ConnRegistry` 排空，再**收流量配额账本**（`await closeTrafficLedger()`：摘定时器 → 最后一次落盘 → 关句柄。**停机落盘是正确性要求**：队列里「已计入内存判定、还没进磁盘」的字节丢掉的话，用户靠反复「用一点、Ctrl+C」就能把配额窗口内的额度一次次刷新），然后释放**本 runtime 自己创建**的 core 监听、`lifecycle.changed` 订阅、store 订阅与 ACL 文件事件订阅，绝不退出宿主进程。每次后续 `start()` 都重新建立 bridge/lifecycle/store/ACL 文件订阅**与账本**（`ledger.open()` 幂等），因此 `start→stop→start` 与 `stop-before-start` 后再启动都恢复完整链路。只有 runtime 自建 `EventHub` 时才在最后 `removeAll()`；外部 `events` 归调用方所有，stop 后其既有订阅必须保留。
- `start()` 先发布 `config.loaded`，其**载荷键是 `source`**（`{ source }`，由本目录 `sourceName(context)` 计算）按 `argv` > `environment` > `env-files` > `memory` 首次命中识别（混合来源只报告最高优先级），再启动 core。**状态桥接（Phase 1.3b）**：runtime **在 `this.events` 上订阅 `lifecycle.changed`**（core 的 `BaseProxy.setState` 直接发布，是这条事实的**唯一来源**），收到后按 `next` 派生 `starting/running/stopping/stopped` → `runtime.starting`/`runtime.started`/`runtime.stopping`/`runtime.stopped`；**runtime 绝不再自己发 `lifecycle.changed`**（core 已经发了，发第二遍就是「一条事实两个来源」）。因为 core 是发布方、runtime 是观察方，事件顺序是 `lifecycle.changed` 在前、它派生出的 `runtime.*` 在后（`tests/unit/proxy-runtime.test.ts` 按此顺序断言）。原先的 `StatefulProxy` 接口与 `as unknown as` 强转（订阅 core 自带 EventEmitter 的 `stateChange`）**已删除**。
- **`lifecycle.changed` 订阅进 start/stop 循环**（`activateSubscriptions()` / `releaseSubscriptions()`，与 bridge/store/ACL 文件订阅同一轮）：它现在是一条真实的 `EventHub` 订阅，泄漏就等于停机后监听残留。**`stopped` 跃迁仍能发出 `runtime.stopped`**：`stop()` 的执行顺序是 `await this.proxy.stop()`（内部 `doStop` 之后才 `setState("stopped")`）→ `finally { releaseSubscriptions() }`，`await` 落地时 `setState` 已 publish 完，订阅尚未摘除；护栏见 `tests/unit/proxy-runtime.test.ts`（stop 后 `listenerCount("lifecycle.changed")` 回到基线）。
- 启动/停止异常发布 `runtime.error`；启动异常额外通过 `onWarning` 以 `RuntimeWarning` 旁路报告，warning 回调异常不得遮蔽原错误。
- **启动期「配额失效」告警（Phase 5a）**：`start()` 里 `reportQuotaGate()` 在 `config.loaded` 之后调——判据是**文件事实**（`loadAuthUsers` 里至少有一个**非全 0** 的 `quota`）**加** `authEnabled === false`；命中则经 `onWarning` 上报 `{ code: "quota-inert", message: QUOTA_INERT_DETAIL }`。**为什么收窄到「真的配了非零配额」**：关鉴权本身是绝大多数部署的常态，只看 `authEnabled` 会让这条 warn 在没有配额的部署里也一直响，最终淹没真正需要看的告警；而「没配配额」时根本不存在「有东西没生效」。放在 `start()` 而非构造函数：只有真要跑的 runtime 才需要被告知。文案取 `core/log-events.ts:QUOTA_INERT_DETAIL`（与 CLI 落盘的 `[quota-inert]` 行是同一句话，两边各抄一份就会出现文档说 A、日志说 B）。
- JSON 文件状态迁移由同一个 `fileEventHandler` 转发到公共 `EventHub`（`renderFileEvent` 先渲染日志、再发事件，顺序固定）：`error`/`missing` → `config.file-error`（`error` 按真值判定，缺失回落 `"文件消失"`）、`recovered` → `config.file-recovered`、`reloaded` → `config.file-reloaded`，三者 payload 都只带 `{ path }`（`file-error` 另带 `error`）。**三条同轴**：名单坏了 / 名单回来了 / 名单已换成新的；`reloaded` 语义由读取层判定（本轮真读了内容且此前已有缓存条目），runtime 只负责往外发布，**不改节流与判定**。
- runtime 重新装配的文件订阅必须把相对路径先绝对化；`readJsonCached` 仅把 `ENOENT`/`ENOTDIR`/非普通文件视为 missing，其它 stat 错误保留上一份有效值并发 `error`，不能让 ACL 因 `EACCES` 等静默全放行。
- 手工传入的 `ConfigContext` 仍须遵守对象工厂契约：`configDir` 必填，`startupKeys` 不是工厂入参并固定来自完整 FIELDS startup 集合；runtime 不提供位置参数或隐式 cwd 兼容层。
- TLS 协议是 `https`、`sockss4`、`sockss5`；明文 `http`、`socks4`、`socks5` 不读取或传递 TLS 路径。

## 与 CLI 的分工

`src/cli.ts` 是唯一宿主来源组合根，`src/server/index.ts` 拥有配置快照打印、cluster、信号、优雅退出和日志编排。CLI 显式 `await loadConfig()` 后把 `ConfigContext` 交给 `runServer()`，server 再以同一 context 构造 runtime；库调用方通常只拿 `createProxyRuntime()` 门面。runtime 不读取 env/argv、不调用加载器，也不 import server/cluster 以恢复副作用。

## 事件桥接（`bridge.ts`）

**Phase 1.3a 后本文件只剩一件事**：把 `pipe` 的三个公开形状翻译成公共 `AppEventMap` 事件。core 已**直接**发布 `auth.decided` / `request.started` / `forward.error` / `server.error` / `server.client-error` / `server.listening` / `server.closed` / `pipe`，其中前两类**不再经本文件桥接**（桥一遍就是重复发布）。它与 `src/server/index.ts:bindProxyEventLogs` 是两条互不 import 的面：后者是 CLI **日志面**（同一批事实 → JSONL 落盘），本文件是**库事件面**（`pipe` → 公共事件）。

- **端口**：`CoreEventBridgeOptions` = `{ hub, protocol, extractClient?, extractTarget? }`（提取器缺省 `getClientAddress` / `getAuthority`）。**`attach(ctx: CoreContext)` 收强类型的 `CoreContext`**（不再是 duck-typed 的 `options?.ctx?.config`，也不再收 `NodeEventEmitterWithProxyEvents`）：`ctx.events` 给出「core 当前那条总线」、`ctx.config` 给出 publisher 注册表要的 accessor。runtime 侧传 `this.dependencies`（`RuntimeContext`），**`as unknown as` 强转已删除**。**总线取 `ctx.events` 而非构造时的 `options.hub`**：`RuntimeContext.setEvents()` 能换总线，core 发布时读的也是 `ctx.events`，取错会「core 发新总线、桥接听旧总线」而静默丢事件；退订用**订阅那一刻**的 hub，换总线也不会退错。
- **映射契约**（3 条，无其它）：`pipe: ip-denied` → `access.client-denied`（`{client,reason}`）；`pipe: target-denied` → `access.target-denied`（`{host,target,reason,source?}`）；`pipe: route` → `route.selected`（`{mode,route,reason?}`）。
- **缺失即跳过，绝不臆造**：`reason` 只认 `src/core/access-control.ts:AclReason` 的 `whitelist|blacklist` 闭合集合，缺失/空串/其它值**不发布**（**禁默认成 `blacklist`**）；`target-denied` 的 `host` 缺失同样跳过（公共契约必填），`target` 缺失回落 `host`。必填 `client` 缺失回落 `"unknown"` 哨兵（沿用 `getSocketAddress` 约定）。**这条纪律正是 `reason` 绝不许写成 `"user:blacklist"` 的原因**：那会让 `aclReason` 返回 undefined、整条 `access.target-denied` **静默消失**。Phase 4b 的分层信息因此走**独立的可选 `source` 字段**（`AclSource = "global"|"user"`），由 `aclSource()` 同样只认这两个值，判不出就**不写该键**——**禁倒填成 `global`**（会把「个人名单拒的」伪装成「全局拒的」，运维去改错文件）。
- **身份提取 DI**：`extractClient` / `extractTarget` 只在**已映射变体发布前**、且事件自带字段缺失时对 `PipeEventBase.req`（`unknown` → 按「有 headers 的对象」收窄）发生；空串视为缺失。桥接器**忽略** core 已写进 context 的身份维度，context 完全由 pipe 载荷（+ req 兜底）重建——这是 1.3a 刻意保留的既有实现，避免「同一维度两个来源」。
- **context**：恒含 `{runtimeId, protocol}`；`access.*` / `route.selected` 按 pipe 已提供的真实字段补 `client`/`user`/`target`/`requestId`/`connectionId`，缺失就不臆造。请求终态 publisher 也沿用 `RequestTerminal` 传入的作用域，使 `access.*` / `route.selected` 与 `request.completed|rejected|failed` 可按同一 requestId 串联。
- **刻意不桥接**：`pipe: target-unresolved` **必须**不桥（它的事实已由协议入口的 `requestTerminal.reject(..., "parse", 400)` 经终态 publisher 发布过一次，桥一遍只是重复发布；过去靠「反查是否已结算」去重，那条通路 `requestTerminalSettled` 已删）。**新增映射前先确认该事实没有已由终态 publisher 发布过**。`pipe` 其余 10 变体 `upstream-refused`/`upstream-error`/`upstream-timeout`/`loop-detected`/`socks`/`bad-request`/`dial`/`established`/`client-error`/`debug` 没有对应公共形状；`onPipe` 的 `default` 显式列出（含 `target-unresolved`，共 11 个）并以 `e satisfies never` 收口。
- **纯观察 + 异常隔离**：`observePipe` 的回调体整体 try/catch（`EventHub` 已隔离 listener 异常，但提取函数/身份组装/发布也不能把观察者的异常带回 core 主流程）；本文件不读 env/文件、不注册 `process` 事件、不打日志。
- **清理顺序与所有权**：`ProxyRuntimeImpl.stop()` 的 `finally` 先 `bridge.subscription.dispose()` 摘订阅，再摘 `lifecycle.changed` 订阅、退订 store/ACL 文件事件；仅当 `ownsEvents` 为真才 `events.removeAll()`。外部 EventHub 上的宿主订阅不得被 runtime 清空；下一次 `start()` 必须重新 attach bridge、`lifecycle.changed` 与文件/store 订阅，`stop-before-start` 也不能让后续启动丢链路。`subscription` 是多订阅合成解绑点（`pipe` 订阅 + 终态 publisher 退订），`dispose()` 幂等，dispose 后由下一次 start 重新建立。
- 回归护栏：`tests/unit/core-event-bridge.test.ts` 锁定三条 pipe 映射、缺失字段跳过、身份提取 DI、观察者隔离与 dispose 幂等，**外加「core 直发 `auth.decided` / `request.started`」与「三类错误事实零派生事件」两组断言**（前两组用真实 `BaseProxy.authorize()` / 真实 `HttpProxy` 请求驱动，后一组断言 `forward.error`/`server.error`/`server.client-error` 原样到达且**不派生**任何 `request.rejected|failed`——终态唯一来源仍是 `RequestTerminal`）；`tests/unit/proxy-runtime.test.ts` 锁定 context/live store、startup accessor/options 冻结、`UPSTREAM_URL` 重建要求、`configDir` 不随 `process.chdir()` 漂移、`start→stop→start`/`stop-before-start` 的 bridge/`lifecycle.changed`/store/ACL 文件订阅重建（现以 hub 上 `pipe` 与 `lifecycle.changed` 的 listenerCount 为 core 订阅数）、`lifecycle.changed` 每跃迁恰好一条且顺序在 `runtime.*` 之前、stop 后订阅归零，以及 stop 不清外部 EventHub；`tests/library/entry.test.ts` 从包入口验证双 runtime 隔离。
