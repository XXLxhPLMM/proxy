# src/runtime — 第三方库门面

`runtime/` 是把仓库当作库嵌入时的唯一公开装配层。它负责把调用方给出的纯内存配置、服务替身、事件总线和日志端口接到协议核心；协议实现、连接排空和生命周期状态机仍由 `src/core/server/` 负责。

## 职责边界

- `createProxyRuntime()` 创建私有 `ConfigStore`、由它派生的 `ConfigAccessor`、默认服务、事件总线和 `ProxyCore`。
- `ProxyRuntime.start()/stop()` 只委托给 `BaseProxy` 的幂等状态机；不得另造 listen/close/连接排空逻辑。
- `getProxy()` 从构造期起就返回同一个协议核心，TLS 证书等真正需要的文件仍由协议启动钩子惰性读取。
- 本目录不负责配置解析来源、cluster、信号、日志落盘或进程退出。

## 零副作用铁律

- 构造 runtime 不得读取 `process.env`、`process.argv`、`.env`、配置文件或任何其它文件；不得写 `process.env`、stdout/stderr、日志文件，不得注册任何 `process` 事件，不得调用 `process.exit`，不得使用 cluster。
- 不得 import `src/config/loader.ts` 或 `src/server/index.ts`；CLI/server 负责进程级配置与治理，库门面只接受显式 `config` 和依赖注入。
- 默认日志必须是 `createNoopLogger()`。需要输出时由库调用方显式注入 `Logger`，runtime 不擅自选择全局 logger。
- 配置必须落到本 runtime 私有 `ConfigStore`，并经 `configAccessorFromStore()` 注入 core；不得读写 CLI 的全局 `get/set` 单例。

## DI 契约

- `config` 是 `Partial<AppConfig>`，缺省键取 `defaults`，不经过 env/argv/loader。
- `services.auth` 未提供时由 `createAuthFromConfig(configAccessor)` 装配；显式 auth 优先。扩展服务时保持同样的“默认实现 + 可覆盖替身”形状。
- `events` 未提供时每个 runtime 自建一个 `EventHub`；提供时必须原样使用外部实例。
- `logger` 未提供时使用 noop；runtime 不负责把 core 的日志策略改成 CLI 策略。
- `configAccessor` 必须随私有 store 一起传给 `ProxyOptions.config`，让 core 的鉴权、ACL、路由等读取与其它 runtime 隔离。

## 生命周期与事件

- `start()`、`stop()` 保持幂等；停止时先让 `BaseProxy` 完成 server close 与 `ConnRegistry` 排空，再释放事件订阅（`EventHub.removeAll()`），绝不退出宿主进程。
- 状态桥接只观察 core 的 `stateChange`：进入 `starting/running/stopping/stopped` 时分别发布 `runtime.starting`、`runtime.started`、`runtime.stopping`、`runtime.stopped`，每次跃迁同时发布 `lifecycle.changed`。
- 启动/停止异常发布 `runtime.error`；启动异常额外通过 `onWarning` 以 `RuntimeWarning` 旁路报告，warning 回调异常不得遮蔽原错误。
- TLS 协议是 `https`、`sockss4`、`sockss5`；明文 `http`、`socks4`、`socks5` 不读取或传递 TLS 路径。

## 与 CLI 的分工

`src/cli.ts` / `src/server/index.ts` 继续拥有 loader 初始化、配置打印、cluster、信号、优雅退出和日志编排。库调用方只拿 `createProxyRuntime()` 门面；两条路径不得互相 import 以恢复副作用。

## 事件桥接（`bridge.ts`）

`CoreEventBridge` 把 core 内部事件翻译成公共 `AppEventMap` 事件发布到 runtime 的 `EventHub`，**库用户只通过 `runtime.events` 观察请求事实**（桥接器是内部机制，不暴露到 `ProxyRuntime` 公共接口、也不从 `runtime/index.ts` 再导出）。它与 `src/server/index.ts:bindProxyEventLogs` 是两条互不 import 的面：后者是 CLI **日志面**（core 事件 → JSONL 落盘），本文件是**库事件面**（core 事件 → 公共事件）。

- **端口**：`NodeEventEmitterWithProxyEvents`（`on`/`off` × `"auth" | "pipe"`，payload 由 `ProxyEventMap` 派生）。`ProxyCore` 公共接口刻意不暴露 EventEmitter，故调用点做一次 `as unknown as` 窄化（与 `runtime.ts:StatefulProxy`、`server/index.ts:ProxyEventSource` 同一手法）；**禁 `any` / 禁字符串索引绕过**。
- **映射契约**：`auth` → `auth.decided`（`{passed,user,attempted,reason}`，身份维度进 context）；`pipe: ip-denied` → `access.client-denied`（`{client,reason}`）；`pipe: target-denied` → `access.target-denied`（`{host,target,reason}`）；`pipe: route` → `route.selected`（`{mode,route,reason?}`）；`pipe: target-unresolved` → `request.rejected`（`{stage:"parse",reason:"target-unresolved"}`）。
- **缺失即跳过，绝不臆造**：`reason` 只认 `src/config/acl.ts:AclReason` 的 `whitelist|blacklist` 闭合集合，缺失/空串/其它值**不发布**（**禁默认成 `blacklist`**）；`target-denied` 的 `host` 缺失同样跳过（公共契约必填），`target` 缺失回落 `host`。必填 `client` 缺失回落 `"unknown"` 哨兵（沿用 `getSocketAddress` 约定）。
- **身份提取 DI**：`extractClient`（默认 `getClientAddress`）/`extractTarget`（默认 `getAuthority`）只在**已映射变体发布前**、且事件自带字段缺失时对 `PipeEventBase.req`（`unknown` → 按「有 headers 的对象」收窄）发生；空串视为缺失。
- **context**：恒含 `{runtimeId, protocol}`，有才带 `client`/`user`/`target`。**不生成 `requestId`/`connectionId`**——core 尚无请求作用域概念，臆造 id 会让「按请求串联事件」变成假象；等 core 引入请求作用域后再补。
- **本波刻意不桥接**：`forward`（是「开始转发」信号，与 `request.completed` 终态事实不同，提前发会让订阅方把开始当完成；等 ErrorBoundary 收口终态再定）；`forwardError`/`serverError`/`clientError`（错误终态与 `stage` 归属属 **ErrorBoundary** 范围）；`pipe` 其余 10 变体 `upstream-refused`/`upstream-error`/`upstream-timeout`/`loop-detected`/`socks`/`bad-request`/`dial`/`established`/`client-error`/`debug`（转发与握手的内部细节，公共契约无对应形状，留给 ForwardPlan/ErrorBoundary）。`onPipe` 的 `default` 里**显式列出**这 10 个变体并以 `e satisfies never` 收口——新增变体必须编译期表态，不许静默吞掉。
- **纯观察 + 异常隔离**：桥接不改 core 的 emit 行为/返回值/异常语义（回归护栏断言「老 listener 顺序与次数不变」）；`observe` 的回调体整体 try/catch，观察者异常绝不反向打断鉴权/转发主流程；本文件不读 env/文件、不注册 `process` 事件、不打日志。
- **清理顺序**：`ProxyRuntimeImpl.stop()` 的 `finally` 里**先 `bridge.subscription.dispose()`（摘 core 监听）再 `events.removeAll()`（清总线）**——顺序反了会出现「已清 hub、仍挂 core 监听」的窗口。`subscription` 是多监听合成解绑点（`attach()` 返回它），`dispose()` 幂等；**dispose 后的 `attach()` 是安全空操作**（不复活监听）。
- 回归护栏：`tests/unit/core-event-bridge.test.ts`（8 类不变量：auth 桥接 / 名单拒绝 + reason 缺失跳过 / route / target-unresolved / 不桥接边界 / 观察者异常隔离 / dispose 后停发 / core 行为不变，外加 runtime 接线与 stop 解绑顺序）。
