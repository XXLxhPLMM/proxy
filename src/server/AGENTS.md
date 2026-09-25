# src/server — 服务端编排

`index.ts`（`ProxyServer`/`runServer`：CLI 进程壳）+ `cluster.ts`（多进程）+ `log/`（只剩 `config-log.ts`）+ `banner.ts`（生成物）+ `process-guards.ts`（进程守卫）。协议内部状态机归 `src/core/AGENTS.md` 的 `BaseProxy`，本层不管。**本目录是进程编排层**：`[event-code]` 事件词汇表与 `[route]` 等 pipe 事件文本归 `src/core/log-events.ts`（core 事实的翻译层），本目录只负责订阅与落盘。

## ProxyServer（`index.ts`）

- `ProxyServer` 是**CLI 进程包装器**，构造参数必须含 `{ context: ConfigContext }`；logger 未显式注入时才按 `context.accessor` 创建独立 `LoggerImpl`。它不读 env/argv、不调用 `loadConfig()`、不创建配置状态，库调用方不要实例化本类，直接用 `createProxyRuntime()`。
- server 创建 runtime 时显式传同一 `context` 与 `LoggerImpl`；默认 auth 由 runtime 的 `createAuthFromConfig(context.accessor, fileEventHandler)` 装配，core 只收到必填 `ProxyOptions.config`，不存在全局 accessor/鉴权回退。
- `start()` 顺序为：动态 import 并调用 `setupProcessGuards(this.logger)`（`./process-guards.js`，**文件本身在本目录**，原在 `utils/`；惰性只为不打模块顶层副作用）→ 非 worker 时动态 import `logConfig(context, this.logger)`（`./log/config-log.js`）→ 创建/接收 runtime → 订阅 lifecycle 与代理事件 → 绑信号 → `runtime.start()`。配置日志依赖调用方已完成加载，模块 import 本身不加载配置。
- `bindProxyEventLogs()`：core 只抛事件不直接打印（握手/接入期那条保留例外见 `src/core/AGENTS.md`），落盘收拢于此。**事件函数从 `@/core/log-events.js` 取**（`logUpstreamRefused`/`logLoopDetected`/`logBadRequest`/… 及 `LogEvent`；原先住在 `server/log/events-log.ts`，已下沉到 core，导出符号一字未改）——只有直接调用方是 `core/server/*`，留在本层会逼出 `core → server → core` 的目录环。强类型 `ProxyEventMap` 先同步桥到 server-local `EventHub`，再经订阅执行本 server 注入的 logger；消息文本、等级、字段、敏感头掩码与 JSONL 契约不变。转发 debug headers 会掩码 `proxy-authorization`/`authorization`/`cookie`；`auth` allow→debug、deny→info；`pipe: route` 与 `[route]` info 行 1:1；`upstream-error` 带 target/err.message 落 warn，保留 502 成因。
- `stop(graceMs)`：经 `runtime.stop()` 优雅排空（返回前 `await logger.flush()`）+ 超时兜底 `process.exit(1)`（timer `unref`）。信号与 master IPC 同时到达时重复触发幂等；单进程停机中再收信号可强退，worker 永不强退，兜底交 master grace SIGKILL 与 stop 自身超时。
- `EADDRINUSE`：CLI 提示查占用 + `pnpm start -- --port <next>`；端口从已加载 `context.store` 读取，不再从任何全局函数获取。

## 库入口零副作用保证

- `src/index.ts` 的静态依赖不执行配置加载、cluster fork、`server/process-guards`（本目录 `process-guards.ts`）或日志落盘；它导出 `loadConfig`/`createConfigContext` 供调用方显式使用，并 re-export 接收 context 的 `ProxyServer`/`runServer` 作为进程级 API。包入口明确不导出 `get/getAll/set/defaultConfigStore/globalConfigAccessor`。
- import `src/config/load.ts` 只定义 async `loadConfig()`；省略 `env`/`envFiles`/`argv` 即空，不读 `process.env`/`process.argv`、不扫描默认文件、不写 `process.env`。只有调用方 await 且显式给来源后才执行 IO 与校验。
- `src/cli.ts:main()` 是唯一宿主组合根：第一次 await 前快照 env/argv/cwd/NO_COLOR → `defaultEnvFileNames(env.NODE_ENV)` → `await loadConfig(...)` → `createLogger({ config: context.accessor })` → `runServer(context, logger, noColor)`。`runServer(context, logger?, noColor?)` 本身不采集宿主来源；logger 省略时只按已给 context 新建。
- `cluster.ts` 顶层只定义函数；`cluster.on`、`process.on`、fork 与退出兜底全部在 `runAsMaster(context, logger, noColor)` 内。`ProxyServer` 的进程守卫（同目录 `./process-guards.js:setupProcessGuards`）也只在显式 `start()` 时动态安装，并接收当前 logger；`config-log` 同样接收 `ConfigContext` 与 `LoggerImpl`。
- `createProxyRuntime()` 的 context 模式只创建 runtime accessor/服务/EventHub（或复用注入项）与未监听 core；config/preset 模式另建私有 store。两种模式都不读 env/argv/配置文件、不写 stdout/日志、不注册 process 事件、不退出进程。

## Cluster（`cluster.ts`）

- `runServer(context, logger, noColor)` 按 `context.store.get("clusterWorkers")` 决定 master 或单进程；`runAsMaster(context, logger, noColor)` 显式使用同一 context/logger，配置日志读取 `context.config` 的加载时冻结快照，shutdown grace 读取 live `upstreamTimeout`。
- `clusterWorkers>1` 才 fork。生命周期/崩溃行走 `notice`；worker 快速退出（`<5s`）1s backoff 重启，连续 5 次快速退出 → master `exit(1)`（先 flush）；第二个信号强制 master 退出，全部 worker 退出后 master 以 0 退出（先 flush）。这些副作用仅在 `runAsMaster()` 调用后发生。
- banner 由同目录 `./banner.js:printBanner(logger, noColor)` 打（`index.ts` 单进程 ready 后、`cluster.ts` master 汇总判据「当前就绪 pid 集合」成立时各打一次，重复就绪不重复打）。**`banner.ts` 是 `scripts/gen-banner.mjs` 的生成物，勿手改**；生成路径由 `build.mjs` / `scripts/gen-banner.mjs` 同步维护（曾长期住在 `utils/`），`RE_ANSI_ESCAPE` 从 `@/utils/constants/index.js` 取。
- master 与 worker 不共享内存 store：每个 `cluster.fork()` 启动的新进程重新进入 CLI 组合根，独立快照宿主来源、独立 `await loadConfig()`、独立创建 context/accessor/logger/ACL/auth 缓存；master 只负责 fork/ready/退出编排。

## 本目录注意

- `server/log/config-log.ts:logConfig(context, logger)` 打印初始冻结快照并脱敏 secret/口令/上游凭证；运行期文件事件由 runtime 显式把当前 logger 注入 config 层，不由本模块抓全局 logger。
- `server/log/` **只剩 `config-log.ts` 这一块**：结构化事件码（`[event-code]`）与 pipe 事件文本归 `src/core/log-events.ts`，启动 banner 归本目录 `banner.ts`。**不要再往本目录塞事件词汇表**——唯一直接调用方是 `core/server/*`，事件词表放这里就要求 core 反向依赖进程编排层。
- 查日志用 `jq`（示例见 `src/utils/AGENTS.md`）。
