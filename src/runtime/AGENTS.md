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
- runtime 无论哪种来源都生成自己的 `ConfigAccessor`：startup 键在构造时复制固定，runtime 键每次经 context store 现读；`ProxyOptions.config` 必须传这个 runtime accessor。`runtime.options`（含 tls 对象）、`runtime.services` 和派生 accessor 是只读冻结视图，store 后续修改只发布事件，不重建 core。`UPSTREAM_URL` 与六个 endpoint 拆项都属于 startup，loadConfig/纯内存 runtime 共用 URL 校验/拆项入口；解析失败不得半写 store，修改任一项都需重建 runtime，拆项覆盖 warning 保留。
- 配置变更事件按相位分流：runtime 键发布 `config.changed`，startup 键（含 `UPSTREAM_URL` 与六个 endpoint 拆项）发布 `config.restart-required`；当前实例的 startup accessor/已构造 options 保持原值，必须新建 runtime 或重启才采用新启动值。
- facade 的**直接配置字段**只有 `readonly context: ConfigContext`；**不再公开**独立的 `config` 或 `configAccessor` 字段，也不在 facade 复制另一份可变配置。`runtime.options.config` 仍只是归一化 `ProxyOptions` 暴露的同一个必填 accessor，不是第二个配置入口。需要快照用 `runtime.context.config`，需要写 live store 用 `runtime.context.store`。
- `services.auth` 未提供时由 `createAuthFromConfig(runtimeAccessor, fileEventHandler)` 装配；显式 auth 优先。扩展服务保持同样的“默认实现 + 可覆盖替身”形状。
- `events` 未提供时每个 runtime 自建一个 `EventHub`；提供时必须原样使用外部实例。`logger` 未提供时使用 noop，不把 core 改成 CLI 策略。

## 生命周期与事件

- `start()`、`stop()` 保持幂等；停止时先让 `BaseProxy` 完成 server close 与 `ConnRegistry` 排空，再释放**本 runtime 自己创建**的 core 监听、store 订阅与 ACL 文件事件订阅，绝不退出宿主进程。每次后续 `start()` 都重新建立 bridge/store/ACL 文件订阅，因此 `start→stop→start` 与 `stop-before-start` 后再启动都恢复完整链路。只有 runtime 自建 `EventHub` 时才在最后 `removeAll()`；外部 `events` 归调用方所有，stop 后其既有订阅必须保留。
- `start()` 先发布 `config.loaded`，其 `sourceName` 按 `argv` > `environment` > `env-files` > `memory` 首次命中识别（混合来源只报告最高优先级），再启动 core。状态桥接只观察 core 的 `stateChange`：进入 `starting/running/stopping/stopped` 时分别发布 `runtime.starting`、`runtime.started`、`runtime.stopping`、`runtime.stopped`，每次跃迁同时发布 `lifecycle.changed`。
- 启动/停止异常发布 `runtime.error`；启动异常额外通过 `onWarning` 以 `RuntimeWarning` 旁路报告，warning 回调异常不得遮蔽原错误。
- JSON 文件状态迁移由同一个 `fileEventHandler` 转发到公共 `EventHub`（`renderFileEvent` 先渲染日志、再发事件，顺序固定）：`error`/`missing` → `config.file-error`（`error` 按真值判定，缺失回落 `"文件消失"`）、`recovered` → `config.file-recovered`、`reloaded` → `config.file-reloaded`，三者 payload 都只带 `{ path }`（`file-error` 另带 `error`）。**三条同轴**：名单坏了 / 名单回来了 / 名单已换成新的；`reloaded` 语义由读取层判定（本轮真读了内容且此前已有缓存条目），runtime 只负责往外发布，**不改节流与判定**。
- runtime 重新装配的文件订阅必须把相对路径先绝对化；`readJsonCached` 仅把 `ENOENT`/`ENOTDIR`/非普通文件视为 missing，其它 stat 错误保留上一份有效值并发 `error`，不能让 ACL 因 `EACCES` 等静默全放行。
- 手工传入的 `ConfigContext` 仍须遵守对象工厂契约：`configDir` 必填，`startupKeys` 不是工厂入参并固定来自完整 FIELDS startup 集合；runtime 不提供位置参数或隐式 cwd 兼容层。
- TLS 协议是 `https`、`sockss4`、`sockss5`；明文 `http`、`socks4`、`socks5` 不读取或传递 TLS 路径。

## 与 CLI 的分工

`src/cli.ts` 是唯一宿主来源组合根，`src/server/index.ts` 拥有配置快照打印、cluster、信号、优雅退出和日志编排。CLI 显式 `await loadConfig()` 后把 `ConfigContext` 交给 `runServer()`，server 再以同一 context 构造 runtime；库调用方通常只拿 `createProxyRuntime()` 门面。runtime 不读取 env/argv、不调用加载器，也不 import server/cluster 以恢复副作用。

## 事件桥接（`bridge.ts`）

`CoreEventBridge` 把 core 内部事件翻译成公共 `AppEventMap` 事件发布到 runtime 的 `EventHub`，**库用户只通过 `runtime.events` 观察请求事实**（桥接器是内部机制，不暴露到 `ProxyRuntime` 公共接口、也不从 `runtime/index.ts` 再导出）。它与 `src/server/index.ts:bindProxyEventLogs` 是两条互不 import 的面：后者是 CLI **日志面**（core 事件 → JSONL 落盘），本文件是**库事件面**（core 事件 → 公共事件）。

- **端口**：`NodeEventEmitterWithProxyEvents`（`on`/`off` × `"auth" | "forward" | "pipe"`，payload 由 `ProxyEventMap` 派生）。`ProxyCore` 公共接口刻意不暴露 EventEmitter，故调用点做一次 `as unknown as` 窄化（与 `runtime.ts:StatefulProxy`、`server/index.ts:ProxyEventSource` 同一手法）；**禁 `any` / 禁字符串索引绕过**。
- **映射契约**（5 条，无其它）：`auth` → `auth.decided`（`{passed,user,attempted,reason}`，身份维度进 context）；`forward` → `request.started`（`{kind}`，身份维度进 context）；`pipe: ip-denied` → `access.client-denied`（`{client,reason}`）；`pipe: target-denied` → `access.target-denied`（`{host,target,reason}`）；`pipe: route` → `route.selected`（`{mode,route,reason?}`）。
- **`forward` 曾刻意不桥接**（理由是「不把它误译成完成、保持公共契约最小」），现已改为桥成独立的 `request.started` —— 它是「开始转发」而非「完成」，因此新增事件名而非复用 `request.completed`。原判断漏了可观测性缺口：`auth.decided` 要开了鉴权才有、`route.selected` 要 client 模式才有，于是 **server 模式直连 + 关闭鉴权**（最常见部署）下加它之前公共事件面**只剩终态**。`requestId`/`connectionId` 由 `handleForward` 注入 `forward` 事件，`onForward` 只读取不生成，缺失即不带。
- **缺失即跳过，绝不臆造**：`reason` 只认 `src/core/access-control.ts:AclReason` 的 `whitelist|blacklist` 闭合集合，缺失/空串/其它值**不发布**（**禁默认成 `blacklist`**）；`target-denied` 的 `host` 缺失同样跳过（公共契约必填），`target` 缺失回落 `host`。必填 `client` 缺失回落 `"unknown"` 哨兵（沿用 `getSocketAddress` 约定）。
- **身份提取 DI**：`extractClient`（默认 `getClientAddress`）/`extractTarget`（默认 `getAuthority`）只在**已映射变体发布前**、且事件自带字段缺失时对 `PipeEventBase.req`（`unknown` → 按「有 headers 的对象」收窄）发生；空串视为缺失。
- **context**：恒含 `{runtimeId, protocol}`；鉴权/名单/路由事件按 core 已提供的真实字段补 `client`/`user`/`target`/`requestId`/`connectionId`，缺失就不臆造。请求终态 publisher 也沿用 `RequestTerminal` 传入的作用域，使 `auth.decided` / `route.selected` / `request.completed|rejected|failed` 可按同一 requestId 串联。
- **刻意不直接桥接**：`forwardError`/`serverError`/`clientError` 是低层错误事实，请求级 `rejected`/`failed` 由 `RequestTerminal` publisher 经 ErrorBoundary 发布，避免重复终态。**`pipe: target-unresolved` 是「终态唯一来源」原则的典型：它曾经桥成 `request.rejected(stage:"parse")`，现已删除** —— 协议入口（`core/forward/http.ts`）在发这条 pipe 事件前已经 `requestTerminal.reject(..., "parse", 400)`，终态 publisher 会发布那唯一的一条；再桥一遍只是重复发布，过去靠「反查请求是否已结算」去重，那条去重通路（`requestTerminalSettled`）已一并删除。**新增映射前先确认该事实没有已由终态 publisher 发布过**。`pipe` 其余 10 变体 `upstream-refused`/`upstream-error`/`upstream-timeout`/`loop-detected`/`socks`/`bad-request`/`dial`/`established`/`client-error`/`debug` 没有对应公共形状；`onPipe` 的 `default` 显式列出（含 `target-unresolved`，共 11 个）并以 `e satisfies never` 收口。
- **纯观察 + 异常隔离**：桥接不改 core 的 emit 行为/返回值/异常语义（回归护栏断言「老 listener 顺序与次数不变」）；`observe` 的回调体整体 try/catch，观察者异常绝不反向打断鉴权/转发主流程；本文件不读 env/文件、不注册 `process` 事件、不打日志。
- **清理顺序与所有权**：`ProxyRuntimeImpl.stop()` 的 `finally` 先 `bridge.subscription.dispose()` 摘 core 监听，再退订 store/ACL 文件事件；仅当 `ownsEvents` 为真才 `events.removeAll()`。外部 EventHub 上的宿主订阅不得被 runtime 清空；下一次 `start()` 必须重新 attach bridge 与文件/store 订阅，`stop-before-start` 也不能让后续启动丢链路。`subscription` 是多监听合成解绑点，`dispose()` 幂等，dispose 后由下一次 start 重新建立。
- 回归护栏：`tests/unit/core-event-bridge.test.ts` 锁定事件映射、缺失字段跳过、观察者隔离、终态接线与 dispose；`tests/unit/proxy-runtime.test.ts` 锁定 context/live store、startup accessor/options 冻结、`UPSTREAM_URL` 重建要求、`configDir` 不随 `process.chdir()` 漂移、`start→stop→start`/`stop-before-start` 的 bridge/store/ACL 文件订阅重建，以及 stop 不清外部 EventHub；`tests/library/entry.test.ts` 从包入口验证双 runtime 隔离。
