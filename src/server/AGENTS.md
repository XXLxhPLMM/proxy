# src/server — 服务端编排

`index.ts`（`ProxyServer`：纯 CLI 进程壳）+ `cluster.ts`（多进程）+ `log/`（结构化日志）。协议内部状态机归 `src/core/AGENTS.md` 的 `BaseProxy`，本层不管。

## ProxyServer（`index.ts`）

- `ProxyServer` 已降级为**CLI 进程包装器**：真正的代理由 `createProxyRuntime()` 承载，鉴权显式用 `createAuthFromConfig(globalConfigAccessor)` 装配；库调用方不要实例化本类，直接拿 runtime 门面。
- `createProxyRuntime()` 之前的 `config-log` / `process-guards` 不在模块加载期引入：`logConfig()` 与 `setupProcessGuards()` 只在 CLI `start()`（`runServer()` 传入 `configInitialized: true`）时惰性加载。直接 `new ProxyServer()` 用于库式/测试构造时不会触发 loader，也不会覆盖调用方刚写入的配置。
- `start()`：`setupProcessGuards()` → CLI 路径打掩码配置（`logConfig()`，关键事实走 `notice`：默认 error 级控制台也可见）→ 创建 runtime → 订阅 `lifecycle.changed` / 代理事件 → 绑信号 → `runtime.start()`。
- `bindProxyEventLogs()`：core/server 只抛不记，落盘收拢于此。core 的强类型 `ProxyEventMap` 先同步桥到 server-local `EventHub`，日志通过 EventHub 订阅执行；桥接只取代旧的 `any`/`EventEmitter` 强转，**消息文本、等级、字段、敏感头掩码与落盘契约一字不变**：`forward`（按 kind 打行；debug 级 headers dump 经 `maskSensitiveHeaders` 把 `proxy-authorization`/`authorization`/`cookie`（大小写不敏感，含数组值）掩码为 `"***"`，其余头原样）/ `forwardError` / `serverError` / `clientError` / `auth`（allow→debug，deny→info 留审计）/ `pipe`（按 `type` 分发：`target-unresolved/loop-detected/upstream-refused/upstream-error/upstream-timeout/route（与 `[route]` info 行 1:1：字段 `target`/`route`/`reason`，core 在 server 模式短路不发）/ip-denied/target-denied/socks/debug`；**转发层 502 必须带成因**：`upstream-error` 含 `target` + `err.message` 落 warn，否则 TLS 失败/ECONNREFUSED 在 info/error 级无痕）。
- `stop(graceMs)`：经 `runtime.stop()` 优雅停机（返回前 `await logger.flush()` 等齐在途日志）+ 超时兜底 `process.exit(1)`（timer `unref`）。信号与 master IPC 可能同时到达（同一次 Ctrl+C 的控制台广播 + IPC 扇出），重复触发幂等、不得打断排空；单进程下停机中再收信号才强退，worker 永不强退（兜底交 master 的 grace SIGKILL 与 `stop()` 自身超时）。
- `EADDRINUSE`：提示查占用 + `pnpm start -- --port <next>`（逻辑在 `src/cli.ts`）。

## 库入口零副作用保证

- `src/index.ts` 的静态依赖不包含 `config/loader.js`、`server/cluster.ts` 的执行路径或 `process-guards.js`；`ProxyServer`/`runServer` 虽可由库入口 re-export，但只有显式调用 CLI API 才会进入这些职责。
- `cluster.ts` 顶层只定义函数；`cluster.on`、`process.on`、fork 与退出兜底全部在 `runAsMaster()` 内发生。配置日志同样等到真正进入 master 生命周期才惰性加载。
- `createProxyRuntime()` 的默认路径只建私有 `ConfigStore`、noop logger、EventHub 与未监听的 core，不读 env/argv/文件、不写 stdout/日志、不注册 process 事件、不退出进程。
- `src/index.ts` 的 `loadConfig` 目前是惰性兼容门面：import 入口不加载 loader；但 `src/config/loader.ts` 仍有历史性的底部 `initConfig()` 自执行，因此**首次调用**门面仍会触发该遗留初始化。彻底纯化需要配置层另行拆出无副作用模块，本 server 改造不越权修改。

## Cluster（`cluster.ts`）

- `clusterWorkers>1` 才 fork。生命周期/崩溃行走 `notice`（默认 error 级控制台可见）；worker 快速退出（`<5s`）1s backoff 重启，连续 5 次快速退出 → master `exit(1)`（先 flush）；第二个信号强制 master 退出（不强等）；全部 worker 退出后 master 以 0 退出（先 flush）。这些语义与副作用均只在 `runAsMaster()` 调用后发生。

## 本目录注意

- `server/log/`：`[event-code]` 结构化事件 + 启动期掩码配置快照。查日志用 `jq`（示例见 `src/utils/AGENTS.md`）。
