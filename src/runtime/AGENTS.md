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
