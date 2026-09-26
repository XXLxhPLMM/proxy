# Cordis V6 重构计划

> 状态：进行中（Phase 2）
>
> 目标分支：`v6-dev-xxl`
>
> 目标版本：`6.0.0`

## 当前进度

- [x] 包版本推进到 `6.0.0`，发布文档与 banner 同步
- [x] 清理 V5 测试体系，仅保留 `tests/http-test-server.mjs`
- [x] 锁定 Cordis `4.0.0-rc.10`，确定 CLI bundle / CJS library 边界
- [x] 接入最小 Context、legacy ProxyServer adapter 和 lifecycle event
- [x] 接入 ConfigService、PresetService、LoggerService、ErrorService 核心边界
- [x] 接入 ConfigService runtime reload、资源事件桥与 preset 事件边界；完整错误策略和领域服务迁移仍待完成
- [x] 接入 runtime 启动事实 observer/journal、只读 startupFacts 与 handle replay 时序
- [x] 固定 runtime/public library 边界方案 A+：runtime 为 CLI-internal，公共 CJS 库只暴露 `src/index.ts` 闭包，并由 `scripts/assert-library-boundary.mjs` 机器门禁
- [ ] 迁移领域服务和 ForwardPlan 策略

## 1. 目标

将项目重构为 **Cordis-native 的配置驱动插件运行时**：

- 配置决定加载哪些服务和协议插件。
- 用户、鉴权、访问控制、路由、转发、日志和错误处理都作为可组合的 Cordis 插件/服务存在。
- 插件通过强类型 `ctx` 调用其它服务，也通过 `ctx.emit/on` 发布和订阅运行时事实。
- HTTP、HTTPS、SOCKS4、SOCKS5、SOCKSS4、SOCKSS5 各自是协议插件；当前配置只加载一个协议服务。
- 保留真实的 socket、HTTP、TLS、CONNECT、WebSocket、SOCKS 数据面控制流，不把它们伪装成纯事件。
- 统一配置预设、错误策略、日志订阅、资源生命周期和插件卸载行为。

V6 是破坏性架构版本，不为 V5 的旧插件 API、旧事件名或旧服务形状提供兼容层。

## 2. 当前基线与问题

当前代码已经具备部分目标能力，但事件和服务边界不统一：

- `BaseProxy` 已经是实例级强类型 `EventEmitter`，但只覆盖代理实例事件。
- `PipeEvent`、`HelperEvent`、`onAuthEvent`、`onEvent` 分别承担不同事件传递职责。
- `ProxyServer.bindProxyEventLogs()` 统一处理 HTTP/HTTPS 日志，但 SOCKS/TLS 仍有直接日志调用。
- `PipeEvent.type` 是 `string` 并带索引签名，服务端 switch 无法获得真正的穷尽检查。
- `ProxyCore` 没有暴露完整事件接口，`server/index.ts` 通过 `any`/类型断言订阅。
- HTTP、SOCKS、TLS 的生命周期和请求事件并不对称。
- `readJsonCached` 的配置热加载事件已经通过 Cordis-free resource bridge 接入 ConfigService/config-plugin，但仍保持按需 pull，不把资源内容搬进事件总线。
- 当前运行时和构建链是 CommonJS；Cordis 4 当前包是 ESM，且 API 仍处于 RC 阶段。

## 3. 目标总体架构

```text
Cordis Context（每个进程/worker 一个）
├── ConfigService / ConfigPlugin
├── PresetService / PresetPlugin
├── LoggerService / LoggerPlugin
├── ErrorService / ErrorPolicyPlugin
├── UserService
├── AuthService
├── AccessControlService
├── RoutingService
├── ForwardingService
├── ClusterService
└── ProxyService（由 PROXY_PROTOCOL 选择一个实现）
    ├── HttpProxyPlugin
    ├── HttpsProxyPlugin
    ├── Socks4ProxyPlugin
    ├── Socks5ProxyPlugin
    ├── Sockss4ProxyPlugin
    └── Sockss5ProxyPlugin
```

### 3.1 配置决定插件图

启动组合根读取并校验配置，然后按依赖关系加载插件：

```text
ConfigPlugin
  → LoggerPlugin
  → ErrorPolicyPlugin
  → User/Auth/ACL/Routing/Forwarding Plugins
  → 当前 PROXY_PROTOCOL 对应的 ProtocolPlugin
```

`PROXY_PROTOCOL` 仍然一次只选择一个协议服务。协议插件负责监听端口和解析协议，不自行实现用户、鉴权、ACL、路由和日志策略。

### 3.2 `ctx` 的使用规则

- `ctx` 是插件服务容器，不是无边界的全局变量。
- 每个服务通过 Cordis `inject` 声明依赖。
- 需要立即返回结果的业务操作使用 `ctx.service.method()`。
- 运行时事实使用 `ctx.emit()`，订阅者使用 `ctx.on()`。
- 可选的策略扩展链使用 `ctx.waterfall()`；核心安全顺序不能依赖插件注册顺序。
- 资源创建和释放使用 `ctx.effect()`。

### 3.3 Runtime 启动观察面

- `RuntimeOptions.eventObserver` 是一个受限旁路，不是 Cordis service 注入点。observer plugin 不声明 `inject`，只接收 dispatcher 在 payload 校验、重建和冻结之后产生的安全 `RuntimeEventEnvelope`；dispatcher 还会按事件 DTO 的字段/标量 allowlist 拒绝未知快照字段。信封不携带 `Context`、`ConfigService`、`AppConfig`、原始 `Error/cause`、users/ACL 内容或 credentials。
- 外部 observer 的同步 throw、异步 rejection 和永不 settle 的 Promise 都被隔离消费；它不进入 `ctx.parallel` 的 deadline，不改变启动/停止结果，也不通过 `error/observed` 递归。dispatcher 的安全事件旁路先通知 journal，再通知外部 callback，因此即使 ErrorPolicy 尚未挂载，config/preset 事实也不会静默丢失。
- `RuntimeHandle.startupFacts` 与 `replayStartup()` 是同一份有界 ring journal 的只读快照。journal 只保存 `config/loaded`、catalog 中有效 preset 的 `preset/applied`、以及 `proxy/lifecycle` 的 `starting/running`；`resource`、`reload`、`error`、路径、停止和失败事件不进入 replay，也不复制完整配置快照。快照在 observer dispose 后冻结为最后状态，不再追加。
- 启动组合根先挂载 observer，再挂载 config/preset，最后才是 ErrorPolicy 与 lifecycle。`startRuntime()` 只等待领域启动和 dispatcher 的有界发布，不等待外部 observer Promise；返回 handle 时 config/loaded、有效 preset/applied、lifecycle starting/running 已由 journal 记录。`stop()` 逆序释放，observer 在 dispatcher 之前释放；启动失败清理不覆盖原始错误，新一次 runtime/plugin 会重新发一次性 config/preset 事实。

## 4. 服务、命令与事件边界

| 服务                   | 主要调用                             | 返回结果                 | 运行时事件                                                                    |
| ---------------------- | ------------------------------------ | ------------------------ | ----------------------------------------------------------------------------- |
| `ConfigService`        | `load/get/reload/refreshResource`    | 配置快照或安全资源元数据 | `config/loaded`、`config/reloaded`、`config/failed`、`config/resource`        |
| `UserService`          | `find/reload`                        | 用户快照/查找结果        | `users/reloaded`、`users/failed`                                              |
| `AuthService`          | `authenticate`                       | `AuthResult`             | `auth/succeeded`、`auth/failed`                                               |
| `AccessControlService` | `checkClient/checkTarget/checkRoute` | ACL 判定                 | `access/allowed`、`access/denied`                                             |
| `RoutingService`       | `resolve`                            | `ForwardPlan`            | `route/selected`、`route/rejected`                                            |
| `ForwardingService`    | `start`                              | `ForwardHandle`          | `forward/planned`、`forward/connected`、`forward/completed`、`forward/failed` |
| `ErrorService`         | `handle/normalize`                   | 统一错误决策             | `error/handled`、`error/fatal`                                                |
| `LoggerPlugin`         | 订阅事件并写日志                     | 无                       | 日志写入结果由 logger 管理                                                    |
| 协议插件               | `start/stop/handleConnection`        | 连接/请求句柄            | 协议生命周期和连接事件                                                        |

事件描述已经发生的事实；鉴权、ACL、路由和转发的控制流不能只依赖无返回值事件。

## 5. 转发模型：计划与传输策略分离

转发不能写成一个万能插件。路由层只生成明确的 `ForwardPlan`，转发层根据计划选择策略。

```ts
interface ForwardPlan {
  inbound: "http" | "connect" | "upgrade" | "socks";
  route: "direct" | "upstream";
  target: { host: string; port: number };
  upstream?: {
    protocol: string;
    host: string;
    port: number;
    secure: boolean;
    username?: string;
    password?: string;
  };
  payload: "http-request" | "raw-stream";
}
```

### 5.1 传输策略

- `HttpRequestForwarder`：直连或经 SOCKS 隧道后使用 `http.request`/`https.request`。
- `DirectStreamForwarder`：直连 CONNECT/Upgrade/SOCKS，使用 `net.connect`/`tls.connect`。
- `HttpUpstreamForwarder`：通过 HTTP/HTTPS 上游发送 CONNECT，再桥接原始流。
- `SocksUpstreamForwarder`：完成 SOCKS4/5（必要时 TLS）握手，再执行 HTTP 请求或原始流转发。

`Dialer` 负责建链，Forwarder 负责数据面传输，协议插件负责协议应答。策略选择由 `ForwardPlan` 决定，不通过事件监听顺序或字符串 type 猜测。

## 6. 配置、预设与热加载

### 6.1 配置优先级

```text
默认值 < Preset < .env 文件 < 终端环境变量 < CLI 参数
```

`ConfigPlugin` 是唯一读取外部配置的模块；其它服务只能读取 `ConfigService` 快照，不能直接读取 `process.env`。

### 6.2 启动配置与运行时配置

- 启动配置：协议、监听地址、端口、cluster 数量、TLS 监听证书。修改后必须重启；runtime reload 对任何 startup 字段整批拒绝。
- 运行时配置：鉴权、用户文件、ACL、上游和日志。`ConfigService.reload(patch)` 只消费内存中的当前 store，不重新读取 env/CLI/preset；字段表、范围、枚举、URL 派生和跨字段守卫仍由 loader/fields 统一执行。
- reload 是事务：先构造完整 candidate 并 force 校验 candidate 指向的 JSON 资源，成功后一次性 `store.commitConfig()`；失败不写半批字段，service 保持 ready。成功的实际变化才发布 `config/reloaded`，空操作不伪造事件。
- 配置错误通过 `ErrorService` 统一处理；启动配置错误 fail-fast，运行时坏配置保留上一份有效值。`config/failed` 只带脱敏的 name/code/message，不带原始 Error/cause。

### 6.3 Preset

Preset 是“配置片段 + 插件集合 + 策略集合”，不是散落在代码中的魔法开关。首批预设：

- `http-server-basic`
- `http-client-chain`
- `socks5-server`
- `sockss5-mtls`
- `strict-acl`

Preset 只能提供默认值，最终配置仍由统一优先级合并。它是 startup-only：runtime reload 不切换 preset，也不动态加载 `plugins` 列表。`preset/applied` 事件只表示启动时确实选择了一个 catalog 定义；事件名不代表后续消费者已经挂载完毕，`plugins` 只是目录元数据。

### 6.4 资源事件与 pull 模型

- `resource-events` 是 Cordis-free 的进程内通知总线；`auth-users.ts`/`acl.ts` 在 reader 提交缓存后发布 `resource/path/transition/outcome/mtimeMs/size/error` 元数据，ConfigService/config-plugin 只订阅并映射到安全的 `config/resource`。
- 事件是 pull 通知，不是状态载荷：消费者若需要当前生效值，仍调用 `readAuthUsers`/`readAcl` 或对应服务。事件不携带 AppConfig、users/ACL 内容、密码、token、cause 或原始 Error。
- `ConfigService.refreshResource(resource)` 只强制走现有 reader 的 force 路径，没有 fs watcher；`load/reload/refreshResource` 串行化。`ctx.effect` 负责取消服务事件和资源事件订阅，Context 停止后不再向销毁的 Context 发布；监听器抛错/reject 不影响提交或停止。
- `json-file-log.ts` 仍是唯一资源 notice sink；config-plugin 不重复写日志。

## 7. 错误处理与资源生命周期

### 7.1 错误分类

- 配置错误：启动阶段终止，运行时保留旧值。
- 请求错误：映射为 HTTP 状态码、SOCKS reply 或 TLS 收尾。
- 上游错误：携带 target、cause、timeout/source 等结构化字段。
- 协议错误：由对应协议插件转换为协议响应。
- 订阅者错误：隔离并记录，不能反噬主请求。
- 进程错误：由 `process-guards` 插件转换为 `runtime/error`，按策略决定记录或退出。

### 7.2 资源管理

协议 server、连接集合、定时器、日志文件句柄和 cluster 资源都通过 `ctx.effect()` 注册清理。Cordis 插件卸载必须幂等，不能留下 listener、timer、socket 或未完成任务。

每个 cluster worker 创建独立 Cordis Context；master/worker IPC 仍由 Node cluster 负责，不把跨进程序列化混入进程内事件总线。

## 8. 迁移阶段

### Phase 0：基线冻结

- 记录当前协议、配置、错误响应和日志 JSONL 行为。
- 记录当前行为并定义黑盒验收矩阵；V5 测试代码已按重构策略移除。
- 明确 V6 破坏性 API 清单。

### Phase 1：运行时与构建决策

- 固定 Cordis 版本和 API 适配边界。
- 决定迁移 ESM，或明确由 esbuild 打包 ESM 依赖。
- 建立 `src/runtime/context.ts` 和最小插件加载验证。
- 不改协议行为。
- **构建决策（Phase 1）**：Cordis 只进入 CLI runtime adapter，由 esbuild 内联到 `dist/`；公共 CJS library 入口暂不依赖 Cordis，避免 Node 22.6 原生 `require(ESM)` 兼容性问题。该决策的机器门禁与重新评估条件见 [§14 公共库边界（方案 A+）](#14-公共库边界方案-a)。
- 单进程/worker 先由 `src/runtime/` 创建 Context 并包裹旧 `ProxyServer`；cluster master 保持现有 supervisor，不挂载代理插件。

### Phase 2：配置、预设、日志、错误插件

- 抽取 `ConfigService`、`PresetService`、`LoggerService`、`ErrorService`。
- **Preset 合并决策**：Preset 作为 `FIELDS` 默认回退层的一部分，优先级为 `defaults < preset < env/CLI`；preset 值仍经过现有范围、JSON 和跨字段校验，不在 runtime 复制合并算法。
- ConfigService 提供显式 load、只读快照、phase 查询、事务式 runtime reload 和按需 resource refresh；reload 不读取外部来源，resource event bridge 已接入 runtime 的安全 `config/resource` 事件。
- LoggerService 只包装现有 `logger` 单例，保留 console/JSONL/flush 语义，不替换 Cordis 内置 logger。
- ErrorService 第一版只做纯归一化和可注入策略边界，不接管 `process.exit`、process guards 或既有 server 错误所有权。
- Runtime observer 只观察安全、重建冻结的事件 envelope；startupFacts/replayStartup 是有界只读启动审计，不是 Event Sourcing，也不把 resource/reload/error 或配置快照纳入重放。
- 保持现有 JSONL schema 与稳定事件码。

### Phase 3：领域服务

- 将 `Auth`、用户文件加载、ACL 判定、路由解析包装为 Cordis Service。
- 保留纯判定函数，Service 负责依赖、快照、调用和事件发布。
- 删除 `onAuthEvent`、`PipeEventSink` 等旧传递链。

### Phase 4：ForwardPlan 与转发策略

- 引入 `ForwardPlan`、`ForwardHandle` 和 `ForwarderRegistry`。
- 将 HTTP 请求转发、原始流转发、HTTP 上游、SOCKS 上游拆成策略插件。
- 保留 `Dialer`、`ConnRegistry` 和协议收尾的正确语义。
- 为每个策略定义 direct/upstream/TLS/timeout 的黑盒验收场景。

### Phase 5：协议插件迁移

- `HttpProxyPlugin`、`HttpsProxyPlugin`、四个 SOCKS 插件只负责协议适配和服务生命周期。
- 统一连接、请求、鉴权、ACL、路由和错误事件。
- 删除旧的 `ProxyServer` 手工事件绑定和 core 到 server/log 的反向依赖。

### Phase 6：清理与发布

- 删除 V5 旧事件类型、旧 sink、旧直接日志路径和废弃导出。
- 更新 AGENTS、README、配置文档和发布说明。
- 完整执行 `pnpm typecheck`、`pnpm lint`、`pnpm build`，并完成与改动风险相称的黑盒验证。

## 9. 目标目录结构

```text
src/
├── runtime/
│   ├── context.ts
│   ├── events.ts
│   ├── config-service.ts
│   └── bootstrap.ts
├── plugins/
│   ├── config/
│   ├── logger/
│   ├── errors/
│   ├── users/
│   ├── auth/
│   ├── acl/
│   ├── routing/
│   ├── forwarding/
│   └── protocols/
│       ├── http.ts
│       ├── https.ts
│       ├── socks4.ts
│       ├── socks5.ts
│       ├── sockss4.ts
│       └── sockss5.ts
└── core/
    ├── transport/
    ├── protocol/
    └── types/
```

现有文件可以在迁移期间保留，但最终不再由 `ProxyServer`、`BaseProxy`、`PipeEvent` 和 `HelperEvent` 同时承担应用编排职责。

## 10. 验收标准

V6 完成必须满足：

- `PROXY_PROTOCOL` 只加载一个对应协议插件。
- 配置、预设、日志、错误、用户、鉴权、ACL、路由和转发均可独立测试和替换。
- 服务调用有明确返回值，事件只表达事实，不承担隐式控制流。
- HTTP 请求转发和原始流转发策略明确分离。
- direct、HTTP 上游、SOCKS 上游、TLS、超时、ACL 拒绝和鉴权失败行为保持正确。
- 订阅者抛错不会破坏代理主流程。
- 插件卸载、重载、停止不会泄漏 listener、timer、server 或连接。
- 保留的本地 HTTP 测试源站可独立启动，代理核心行为完成与风险相称的黑盒验收。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 全绿，并完成必要的黑盒验证。

## 11. 非目标

- 不把 socket 读写、HTTP framing、TLS 握手和 SOCKS 握手改成纯事件。
- 不在 V6 第一阶段做跨进程消息总线或远程服务化。
- 不做 Event Sourcing；当前事件用于运行时通知和审计，不用于重放重建全部状态。
- 不允许任意第三方插件在生产环境热替换核心数据面；先限制为受控的内部插件和预设。

## 12. 主要风险

- Cordis 当前版本仍是 RC，API 变化需要通过适配层隔离。
- ESM/CommonJS 转换会影响 `tsc`、esbuild、`pkg` 和库导出。
- `emit` 监听器异常隔离必须由 V6 错误策略明确保证。
- 协议插件的加载顺序不能取代鉴权和 ACL 的安全顺序。
- 多 worktree/多 worker 的 Context 生命周期必须独立，不能共享可变服务状态；资源事件仍是进程内通知，不能误当作跨 worker 同步。
- 配置 candidate 的字段校验与资源 force 读取必须保持同一事务边界；外部文件在验证与提交之间变化时，当前 reader 的 last-good 语义仍需后续领域服务继续遵守。

## 13. Definition of Done

- `package.json` 版本为 `6.0.0`。
- 运行时由 Cordis Context 统一创建和管理。
- 配置决定服务和协议插件图。
- 所有领域能力均可作为插件服务注入和测试。
- 所有重要运行时事实通过类型化事件发布。
- 所有转发路径由 `ForwardPlan` 明确选择策略。
- 所有错误通过统一错误策略处理。
- 旧 V5 传递链和重复实现被删除。
- 文档、测试、构建和发布产物全部切换到 V6 语义。

## 14. 公共库边界（方案 A+）

### 14.1 结论

`src/runtime/` 整体是 **CLI-internal**，公共 CJS library 只暴露 `src/index.ts` 的闭包。

| 面                          | 归属        | 说明                                                                                                                  |
| --------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `ConfigService`             | CLI-internal | 启动期初始化与 `reload()` 只在 CLI/runtime 生命周期内有意义，库入口只提供 `initializeConfig()` 与进程化 `set()`           |
| `PresetService`             | CLI-internal | 只被 `preset-plugin` 消费；`preset/applied` 不构成库契约                                                                |
| `LoggerService`             | CLI-internal | 唯一 sink 仍是 `src/utils/log/logger.ts`，通过 JSONL 落盘，不作为库 API                                                       |
| `ErrorService` / `ErrorPolicy` | CLI-internal | 错误策略归属 runtime 控制面；库调用方按 `ProxyLifecycleErrorCode` 处理 `runServer()`/`start()` 的拒绝                   |
| `RuntimeHandle`             | CLI-internal | `stop()`/fiber 逆序释放/disposal 语义随 runtime 形状变化，库侧等价物是 `ProxyServer` 句柄                              |
| `startupFacts` / `replayStartup()` | CLI-internal | 启动审计 journal 是 runtime 内部观察面                                                                                  |
| `eventObserver` / `RuntimeEventEnvelope` | CLI-internal | 事件总线是 CLI 内的通知通道；**公共库不承诺 runtime 事件，也不承诺 runtime reload**                                     |

公共 library 的承诺清单（唯一来源：`scripts/assert-library-boundary.mjs` 的 `LIBRARY_BOUNDARY_PUBLIC_EXPORTS`）：

`ProxyServer`、`ProxyServerOptions`、`runServer`、`get`、`getAll`、`set`、`initializeConfig`、`ProxyLifecycleErrorCode`。

不新增 `exports` 子路径：`package.json` 只有 `"."` 一个入口，`@b-hole/proxy/runtime` 之类的路径**不存在且不计划提供**。

### 14.2 理由

- **Cordis 是 ESM-only**：`cordis@4.0.0-rc.10` 只提供 ESM 产物。公共库是 CJS（`package.json` `type: commonjs`，`main: lib/index.js`），一旦 `lib/` 里出现 cordis 引用，Node 22.6 的库消费者就要面对 `require(ESM)` 的兼容性悬崖。
- **Node >=22.6 基线**：`require(esm)` 需要 Node >=22.12。抬高基线会破坏现有消费者，而 runtime 并不能给库用户带来等价价值。
- **依赖策略**：cordis 是构建期 `devDependency`，只被 esbuild 内联进 `dist/`。库消费者 `npm i @b-hole/proxy` 不会、也不应该被迫安装它。
- **Phase 3 形状未稳定**：领域服务（`UserService`/`AuthService`/`AccessControlService`/`RoutingService`/`ForwardingService`）还没落地，`ForwardPlan` 与协议插件拆分也未完成。现在把 runtime 暴露成公共 API，等于把一个必然破坏性变更的接口提前冻结给外部消费方。

结论：库用户要进程级托管能力（含 runtime 事件、reload、启动审计），就 spawn CLI 进程（`dist/app.js` / `proxy` bin）并用环境变量与配置文件驱动；要程序化控制，就用 `runServer()` + `ProxyServer` 句柄 + `get`/`getAll`/`set`。两者都不是「import 库再拿 runtime」。

### 14.3 机器门禁

`scripts/assert-library-boundary.mjs` 导出可复用函数 `assertLibraryBoundary(libDir)`，脚本自身也可独立运行。它是 fail-closed 的，断言：

1. `lib/` 存在、是真实目录（非 symlink/junction），且产出 `index.js` 与 `index.d.ts` —— 空 `lib/` 不能空过；
2. 产物树中没有任何名为 `runtime` 的路径段，也没有 `cli.*` 产物；
3. `lib/**/*.js|.cjs|.mjs` 不含 `require("cordis")`（以及 `import ... from "cordis"` 等其它引用形式）；
4. `lib/**/*.d.ts` 不含 `from "cordis"` / `import("cordis")` / `declare module "cordis"` / `types="cordis"`；
5. `tsconfig.build.json` 的 `files` 恰为 `["./src/index.ts"]`，且 `include` 显式为空数组（tsc 会把 `files` 与 `include` 求并集，`include` 还会经 `extends` 被继承；两者任一丢失都会把闭包重新放大到整个 `src/`）。

内容匹配刻意粗糙（注释里的字面量也会命中）：边界守卫宁可误报一次，也不接受一次漏报把 ESM 依赖漏给 CJS 消费者。

接线点只有两处，且都在 tsc/tsc-alias 之后、library manifest 登记之前：

| 路径                | 接线                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| 开发 `build:lib`    | `clean-lib && tsc && tsc-alias && node scripts/assert-library-boundary.mjs` |
| 发布 `build:pkg`    | `build-release.mjs` 的 `runLibraryBuild()` 内联调用 `assertLibraryBoundary(libDir)` |

`build-release.mjs` 走进程内调用（而不是 spawn 子进程）是有意的：违规时能保留真实诊断信息，而不是只剩一个子进程退出码。此时 `libraryStageStarted` 已为 true，`cleanupFailedRun` 会删除未登记的 `lib/` 并保留已验证的 manifest。由于 `build-pkg.mjs` / `package-dist.mjs` 只接受同一批次已登记并通过 SHA-256 校验的 `lib/`，`build:pkg` 无法绕过这道门禁。

### 14.4 重新评估触发条件

以下条件**全部**满足后，才重新评估是否把 runtime 提升为公共库 API（届时是破坏性变更，按项目政策不需要兼容层）：

1. **Node 基线 >=22.12**（原生 `require(esm)` 可用），或 **cordis 提供官方 CJS 产物**；
2. 出现**真实的库消费方**（不是「未来可能有」），且其需求无法由 `runServer()` + `ProxyServer` + `set()` 满足；
3. **Phase 3 完成**：领域服务已成 Cordis Service，`ForwardPlan` 策略与协议插件拆分落地，runtime 形状不再必然破坏性变更；
4. **依赖策略明确**：cordis 从 `devDependency` 提升为 `peerDependencies`（或 `dependencies`），并接受随之而来的安装体积与版本约束代价。

在条件 1–4 全部满足前，任何「把 runtime 导出到库」的改动都应被 `assertLibraryBoundary` 挡住；放宽门禁本身就是一次需要写进本节记录的决策。
