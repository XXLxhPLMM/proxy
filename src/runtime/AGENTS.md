# src/runtime — Cordis 运行时适配层

## 依赖方向

- `bootstrap.ts → {config,preset,logger,error,observer}-plugin.ts / error-policy.ts / plugins.ts / event-dispatch.ts → {events.ts, config-service.ts, preset-service.ts, logger-service.ts, error-service.ts, proxy-service.ts}`；同层模块不得反向依赖。
- `bootstrap.ts` 必须创建唯一 `EventDispatcher` 并显式共享给 observer、config/preset plugin、error policy 与 lifecycle；dispatcher 不注册 Cordis effect，必须在所有 fiber 逆序释放后 dispose。
- 运行时只认识 `ProxyService` 与 `LegacyProxyServerPort` 的结构契约，禁止 import `@/server`、`ProxyServer` 或具体代理内核，避免 CLI/runtime 与旧 server 形成循环依赖。
- 旧 server 由调用方在 CLI 边界通过 `createProxyService()` 注入；`ctx.provide("proxy", service)` 后，生命周期插件只能用 `inject: ["proxy"]` 与 `ctx.get("proxy")` 消费。

## Cordis ESM / CLI 边界

- 固定使用 `cordis@4.0.0-rc.10` 的 `Context`、object `Plugin`、`ctx.plugin/provide/get/effect` API；禁止装饰器，禁止用 `any` 绕过注入与事件类型。
- Cordis 4 是 ESM 包。当前仅由 CLI runtime adapter 引入并由 esbuild 内联到 `dist/`；它作为构建期 `devDependency`，公共 CJS library 入口不得导出 runtime，避免把 ESM 依赖扩散给库消费者。机器门禁见 `scripts/assert-library-boundary.mjs`（详见下文「公共库边界」）。
- runtime 模块不得使用 `require.main`、信号绑定、配置加载或进程退出；这些副作用继续归 CLI/旧 server 编排层。
- 当前 legacy `ProxyServer` 仍拥有进程信号与 cluster IPC 清理，runtime 只调用其结构化 `start/stop` 端口；后续阶段再把可 disposer 化的进程资源迁出。

## 公共库边界（runtime = CLI-internal，方案 A+）

- **整个 `src/runtime/` 都是 CLI-internal**，没有任何一部分属于公共库契约。公共 CJS library 只暴露 `src/index.ts` 的闭包：`ProxyServer`、`ProxyServerOptions`、`runServer`、`get`、`getAll`、`set`、`initializeConfig`、`ProxyLifecycleErrorCode`（唯一来源：`scripts/assert-library-boundary.mjs` 的 `LIBRARY_BOUNDARY_PUBLIC_EXPORTS`）。
- **禁止**把 `ConfigService`、`PresetService`、`LoggerService`、`ErrorService`、`RuntimeHandle`、`startupFacts`/`replayStartup()`、`eventObserver`/`RuntimeEventEnvelope` 从 `src/index.ts` 导出。**公共库不承诺 runtime 事件，也不承诺 runtime reload**：库用户要进程级托管（事件、reload、启动审计）就 spawn CLI；要程序化控制就用 `runServer()` + `ProxyServer` 句柄 + `get`/`getAll`/`set`。
- **禁止**新增 `exports` 子路径。`package.json` 只有 `"."` 一个入口；不存在、也不计划提供 `@b-hole/proxy/runtime` 之类入口。库侧等价物是 `ProxyServer`（含 `waitForStopSettled()`），不是 `RuntimeHandle.stop()`。
- 理由：cordis 是 ESM-only 且为构建期 `devDependency`，公共库是 CJS + Node >=22.6 基线（`require(esm)` 需 >=22.12）；Phase 3 领域服务与 `ForwardPlan` 未落地，runtime 形状仍会破坏性变更。完整论证与**重新评估触发条件**（Node >=22.12 或 cordis 官方 CJS + 真实库消费方 + Phase 3 完成 + 明确依赖策略，四条全满足才重评）见 `docs/cordis-v6-refactor-plan.md` §14。
- 机器门禁 `scripts/assert-library-boundary.mjs`（导出 `assertLibraryBoundary(libDir)`，也可独立运行）断言：`lib/` 是真实目录且产出 `index.js`+`index.d.ts`；产物树无 `runtime` 路径段、无 `cli.*`；`lib/**/*.js` 无 `require("cordis")`；`lib/**/*.d.ts` 无 `from "cordis"`/`import("cordis")`/`declare module "cordis"`/`types="cordis"`；`tsconfig.build.json` 的 `files` 恰为 `["./src/index.ts"]` 且 `include` 显式为空。
- 门禁只在两处接线，都在 tsc/tsc-alias 之后、library manifest 登记之前：开发 `build:lib`（`package.json` 脚本尾部）与发布 `build:pkg`（`build-release.mjs` 的 `runLibraryBuild()` 进程内调用）。**新增 library 构建路径时必须一并接线**，否则 `build:pkg` 会绕过。门禁失败时 `cleanupFailedRun` 删除未登记的 `lib/` 并保留已验证 manifest。
- 因此 `src/runtime/**` 里的 `import ... from "cordis"` 是**合法且必要**的：它只允许出现在 CLI runtime 内部，一旦被 `tsconfig.build.json` 的 `files` 拉进编译闭包就会变成 `lib/` 里的 cordis 引用并被门禁拒绝。要让某个 runtime 能力变成库能力，必须先按 §14.4 走重新评估，而不是放宽门禁。

## Effect、事件观察与 fiber 清理

- 生命周期插件先登记 `ctx.effect` disposer，再等待旧 server 启动；因此启动失败时 Cordis 卸载 fiber 也会尝试停止半启动服务。
- `RuntimeOptions.serviceOperationDeadlineMs` 只限制 runtime 等待单次 `ProxyService.start()` / `stop()` 的时间，默认 15000ms，非正数或非有限值回退默认值。每一次调用都建立独立 timer/deadline；start timeout 后的失败清理会重新调用 stop，并获得完整的新 deadline，不能复用已耗尽的 start 预算。timer 在调用完成或超时后都要清理，底层 operation Promise 永久保留 rejection handler 消费迟到 rejection，迟到 fulfill 不得补发 `running/stopped`。
- service operation timeout 以固定 code `ERR_PROXY_SERVICE_OPERATION_TIMEOUT` reject 当前等待方：它不等于底层操作已被强制取消，runtime 不调用 `process.exit`；stop timeout 只发布既有 `failed` 安全摘要并由 `DisposalTracker` 原样传播，绝不发布 `stopped`。若 `ProxyServer.stop(graceMs)` 的公开等待视图已先超时（server 默认 grace **20000ms**，runtime 默认 service deadline **15000ms**），其私有 full stop ownership 仍可能持有真实 `proxy.stop()`；runtime 不得据此推断“可立即 start”，后续 start 在 server ownership 释放前只会得到固定 code `ERR_PROXY_STOP_IN_PROGRESS`，full stop settle 后才能显式重试。库调用方若直接持有 `ProxyServer`，可用 `waitForStopSettled()` 等待真实 full stop；runtime 不 import server，也不扩展 `ProxyService` 端口。该拒绝同样覆盖「start 失败回滚仍在清理」窗口：server 侧的 `cleanupOwner`/`coreStopOwnership` 未落地时，即使 stop 已 settle，新 start 也只会得到同一 code，runtime 只需按同一路径重试；回滚预算耗尽时 server 另有独立 rollback hard-exit，runtime 不重复发明退出路径。`allowProcessExit` 只由 CLI/宿主构造 server 时决定，runtime 不设置也不接管它；库默认 false 时 stop/signal 只记录并返回，worker IPC/通信不受影响。cluster master 的 shutdown grace 必须不早于 worker 的 stop grace + hard-exit flush（共享 `lifecycle-budget.ts`），runtime 不参与该跨层预算计算。该 deadline 独立于事件观察 deadline，也不得作为 `ProxyService.stop(graceMs)` 的 grace 值或替代 signal hard-exit；server 重入 stop 只收紧既有 deadline、不延长，公开等待先 reject、随后才 arm 的 hard-exit 最终 `exit(1)`（仅 process owner），signal timeout 不得伪装成 `exit(0)`；进程信号、重复信号与优雅停机强退仍归 server/CLI 生命周期。
- `RuntimeHandle.stop()` 必须复用同一个 Promise，并通过 lifecycle fiber 的 `dispose()` 触发 effect；随后再 dispose provider fiber，禁止绕过 fiber 直接操作服务。
- Cordis rc.10 的 `_unload()` 会捕获 effect 错误并只交给内部 logger。lifecycle disposer 因此必须等待 `ProxyService.stop()`，但向 Cordis 返回 fulfilled promise，并用显式 `DisposalTracker` 保存首个原始业务/清理错误；正常 stop 在全部 fiber 释放后 reject 该错误，启动失败清理错误不得覆盖主错误。
- provider 与 lifecycle 严格按顺序加载、逆序释放。启动任一插件失败时，已创建 fiber 必须显式清理后再原样抛出启动错误。
- lifecycle 与 `error/observed` 路径统一经 `event-dispatch.ts` 调用 `ctx.parallel`：同步抛错、异步 rejection 与 timeout 都折叠为非拒绝 `EventDispatchResult`；默认观察 deadline 为 1000ms，可由 `RuntimeOptions.eventObservationDeadlineMs` 覆盖。deadline 后迟到的 rejection 仍被消费，不得产生 `unhandledRejection`，也不得无限阻塞 start/stop。
- `config-plugin.ts` / `preset-plugin.ts` 必须由组合根注入与 error policy、lifecycle 相同的唯一 dispatcher，只能 fire-and-forget 调用 `dispatcher.dispatch`；禁止裸 `ctx.parallel`、禁止在 plugin 内创建第二个 dispatcher。dispatcher 将监听器同步 throw、异步 reject 与 hanging listener 折叠为观察结果，发布结果和防御性 rejection 不得改变已提交的 config/preset/resource 事实。
- dispatcher 的 failure observer 只由 error policy 按现有 runtime 约定注册；config/preset plugin 不自行发布 `error/observed`，也不递归观察自身失败。两个 plugin 在每次 dispatch 前同时检查自身 active 状态、Context fiber 与 dispatcher active 状态；config plugin 的 `ctx.effect` disposer 先撤销领域订阅并关闭 active 闸门，preset 的 startup dispatch 也在 apply 边界检查。停止后迟到的 service/resource/preset 回调不得发起新发布，已发出的 in-flight dispatch 仍由 dispatcher 消费迟到 rejection。
- dispatcher 在发布前从有限标量重建并冻结 payload，按事件 DTO 的字段/标量 allowlist 再校验，拒绝原始 Error/cause、类实例、循环引用、未知快照字段和敏感字段；`onFailure()`/`onEvent()` disposer 幂等，dispatcher 的 `dispose()` 幂等、停止后续发布并取消活动 deadline timer。尚未发布的 dispatch 返回 `inactive`，已开始的 Cordis listener 仍由 rejection handler 消费。`error/observed` 自身失败只通知 failure observer，禁止再次发布 `error/observed`。
- `RuntimeOptions.eventObserver` 只能接收 dispatcher 已重建、冻结的 `RuntimeEventEnvelope`（`event`、安全 `payload`、序号）；observer plugin 无 `inject`，不读取 Context、ConfigService、AppConfig、原始 Error/cause、users/ACL 或 credentials。外部 callback 的 throw/rejection/hang 只被消费，不进入 `ctx.parallel`、不递归 `error/observed`，也不阻塞 `startRuntime` 返回。
- `observer-plugin` 必须在 config/preset 之前挂载；它先写 `startupFacts` ring journal，再隔离调用外部 observer，因此 config/preset 的安全事实在 listener failure 或 ErrorPolicy 尚未注册时仍可 replay。journal 只记录 `config/loaded`、有效 `preset/applied` 与 `proxy/lifecycle` 的 `starting/running`；不记录 resource/reload/error/路径/停止噪声，不保存完整配置快照。journal 与 envelope 都是只读有界副本，dispose 后不再新增；`RuntimeHandle.startupFacts` 与 `replayStartup()` 返回新的冻结快照。
- config/preset 的 `config/loaded` 与 `preset/applied` 各只在 plugin `apply` 里发布一次（`apply` 本身只执行一次，故代码里**没有**一次性 flag——曾经的 `loadedPublished`/`applied` 恒为 false，是死守卫）；禁止恢复进程级 WeakSet 或隐式全局去重，否则同一 service 会在多 Context 重复发。

## Phase 2 服务边界

- `startRuntime()` 的组合顺序固定为 `observer → logger → config → preset → error policy → proxy provider → lifecycle`；停止严格逆序，observer 最后释放且 dispatcher 在所有 fiber 之后 dispose。
- `ConfigService` 只委托现有 loader/store/fields，`PresetService` 只读 catalog；runtime 不读 `process.env`、不复制 FIELDS、不动态加载 preset 插件列表。
- `LoggerService` 的唯一 sink 仍是 `src/utils/log/logger.ts`；`appLogger` 是项目门面，不能覆盖 Cordis 内置 `ctx.logger`。`LoggerPlugin` 只订阅 `error/observed` 且仅记录 `handling.logOwner === "runtime"` 的事件，稳定事件码为 `[runtime-error]`；CLI 独占 start failure 最终日志，ProxyServer 独占 stop failure 最终日志，config/json-file 继续走既有唯一 sink。
- `ErrorService` 只有纯 `normalize(error, hint)`：删除 `cause`、`fatal`、`reported` 与 `handle/classify` 兼容面，任意输入都只产生脱敏、限长、深度冻结的标量 DTO；原始 cause 留在直接调用者或完全丢弃。`ErrorPolicy` 只观察 lifecycle/dispatcher 控制面事实，集中生成强类型 `origin/handling/impact/sequence`，不记录 source error、不调用 `process.exit`、不接管 process guards。
- `config/*` 事件不得携带 `AppConfig` 全快照或密钥；敏感配置只能通过 `ConfigService.getAll()` 按需读取。错误观察字段只允许显式 hint 中通过敏感键过滤的标量，不得从异常对象批量复制可枚举属性。

## 事件边界与所有权

- 代理生命周期事件名固定为 `proxy/lifecycle`，阶段仅表达 `starting/running/stopping/stopped/failed` 的既成事实；start 顺序为 `starting → (failed | running)`，stop 顺序为 `stopping → (failed | stopped)`，stop 失败后禁止发布 `stopped`。
- 取消与 service operation timeout 继续沿用既有 `failed` 阶段和安全 `ErrorSummary`；禁止新增 `cancelled` phase、把原始 Error/cause 放进事件，或让迟到 fulfill 把已超时操作改写成成功事实。
- lifecycle `failed` 只携带安全 `ErrorSummary` 与 `impact`，原始 Error/cause 保持在本地并按原顺序原样 reject；`fatal` 不存在，startup-aborted/shutdown-incomplete 只描述操作影响。
- 错误观察事件名固定为 `error/observed`，不保留 `error/handled` 或 `error/fatal` 别名。`origin` 是封闭联合，`handling.logOwner` 只能是 `runtime/cli/proxy-server`（`decideHandling` 的全部可能产出；`process-guards` 已删除——它从不经过 ErrorPolicy，`utils/process/guards.ts` 直接用 logger 单例，别把它当第四个 owner 加回来），ErrorPolicy 不得接管其它 owner 的日志或进程 guard。
- 所有公开事件 DTO 不含原始 Error/cause、凭据、headers、users/ACL 或配置快照；lifecycle/error 对象与数组由 dispatcher 重建并冻结，config/preset 桥只允许只读标量数组，监听器不得互相修改。observer envelope 只能转发这些 DTO 的安全副本；startupFacts 进一步只保留启动成功路径，不复制完整 `AppConfig`。

- 禁止把 socket、连接、请求、字节流或旧 core 转发事件搬进 Cordis 事件总线；这些高频 I/O 事件继续留在旧 server/core 边界。
