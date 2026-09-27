# src/core — 代理内核

各文件头 `@fileoverview` 是第一手说明；本目录**每个子目录恰好一份 `AGENTS.md`**，零分册。**本文件只收敛跨子目录的约定与决策**，子目录机制一律去那一份。

## 路径说明

### 根文件

| 文件 | 装什么 | 判据 |
|---|---|---|
| `context.ts` | `CoreContext`（`config`/`logger`/`events` 三件套只读接口，全必填）+ `ContextualBase`（投影成三个 protected getter） | core 内**唯一**的依赖承载体。`ProxyOptions.ctx` 必填，core 侧零缺省解析 |
| `access-control.ts` | `AccessControl` 的唯一内置实现 `createFileAccessControl` + `bindAclFileEvents` | 只管**请求期名单判定**；读文件与结构校验归 `src/config/files/acl.ts` |
| `guard.ts` | `guardDialing` / `socksUpstreamGuard` / `readResponseHead` / `awaitStatusLine` | 拨号后的**上下游生命周期联动**。零日志，事件上抛 |
| `log-events.ts` | `LogEvent` 事件码表 + `[event-code]` **文本**词汇层 | **不是**渲染层（那是 `@/utils/logger/sanitize.ts`）。事件码是类型级唯一真相源 |
| `request-terminal.ts` | `RequestTerminal` —— 每个请求一次性终态守卫 | 互斥 `claim`，**请求终态的唯一发布方** |
| `request-scope.ts` | `RequestScope` 值对象 + 唯一工厂 `createRequestScope` | 逐请求易变数据的载体。**不是** `events/scope.ts` 里那个同名的 `EventScope` 工厂 |
| `scope-ids.ts` | `connectionIdFor(socket)` / `newRequestId()` | 注入点只有 `server/http.ts:handleForward` 与 `server/socks-base.ts:onConn` |
| `identity.ts` | 身份层出口（**本目录没有 `index.ts`**），相对路径逐个 re-export | 刻意不建 barrel：避免自我引用 barrel 造成循环 |
| `index.ts` | 选择性 barrel | **连 `access-control` / `error-boundary` / `request-terminal` 都不在里面**。不要为了导出而导出 |

### 子目录（各有一份 `AGENTS.md`）

| 子目录 | 装什么 | 读它 |
|---|---|---|
| `types/` | 三个端口 + 判别联合的 SSOT。**端口声明处** | [`types/AGENTS.md`](./types/AGENTS.md) |
| `server/` | 入站建服骨架、`BaseProxy` 生命周期状态机、两阶段准入、派发表 | [`server/AGENTS.md`](./server/AGENTS.md) |
| `forward/` | 两轴子目录 + 根上 `base.ts:ForwarderBase` | [`forward/AGENTS.md`](./forward/AGENTS.md) |
| `forward/channel/` | 四条入站协议通道 + 握手读取器 | [`forward/channel/AGENTS.md`](./forward/channel/AGENTS.md) |
| `forward/upstream/` | `dial.ts` 纯传输层 | [`forward/upstream/AGENTS.md`](./forward/upstream/AGENTS.md) |
| `forward/upstream/connector/` | 「怎么到达 dest」的唯一抽象 + 四个连接器 + registry | [`forward/upstream/connector/AGENTS.md`](./forward/upstream/connector/AGENTS.md) |
| `identity/` | 四种认证模式的插件 + 配置驱动门面 | [`identity/AGENTS.md`](./identity/AGENTS.md) |
| `traffic/` | 每用户流量配额（端口 / 内存账本 / 落盘账本 / 计量落点 / 窗口键） | [`traffic/AGENTS.md`](./traffic/AGENTS.md) |
| `helpers/` | 跨转发层共享的纯工具（凭证 / 目标 / 自环 / 头 / 路由 / 上游 / 线缆 / 拨号前守卫） | [`helpers/AGENTS.md`](./helpers/AGENTS.md) |
| `events/` | 事件内核 `EventHub` / `EventScope` / `AppEventMap` | [`events/AGENTS.md`](./events/AGENTS.md) |

**不属于本层**：配置状态与加载器（`src/config/`）、事件 → 落盘的整套绑定（`src/runtime/event-log.ts`）、进程编排与进程策略端口（`src/server/`）、协议无关的纯工具（`src/utils/`）。

## 硬约定

- **core 不依赖 `src/server`**，只允许 import `@/utils/*` 与 `@/config/*`。跨目录优先走层 barrel（`@/utils/{logger,constants,tls,json-file}/index.js`、`@/config/files/rules/index.js`、`@/core/helpers/index.js`、`@/core/events/index.js`）；`utils/ip.ts` 与 `utils/host-text.ts` 是单文件叶子、无 barrel，只能直接引。唯一允许的 `@/config/*` 深路径是 `@/config/files/rules/index.js`。
- **core 零日志禁区（保留一条例外）**：`src/core/**` 禁止直接打印日志（生命周期行也不行），**请求期**事实一律经 `this.events.publish(...)` 上抛。落盘收在 `src/runtime/event-log.ts`，CLI 与库共用同一份绑定。`this.log` 的唯一用途是把 logger 显式传给告警端口（`@/utils/tls/index.js:loadCerts` 等）；**不得**调 `getLogger()` 或任何全局 logger 回退。
  - **唯一例外**：`core/server` 在**握手 / 接入期**（请求尚未成立、无 pipe 事件可挂）把 SOCKS 非法握手、首包超时、TLS 握手失败经 `core/log-events.ts` 的 `logBadRequest` / `logClientTimeout` / `logTlsClientError` 直接写进注入的 `this.log`。这是「进程内告警端口」而非转发管道落盘。DI 契约由 `tests/integration/tls-client-auth.test.ts` 锁定（直构 core 并 spy 注入实例的 `warn`），改这里必须同步改那个测试。
- **零 `EventEmitter`**：`grep -rn "node:events" src` 零命中。core 的全部事实（含生命周期跃迁）直接发布到注入的 `EventHub`。`this.emitRoute(...)` 是**路由事件**的独立方法名，与 EventEmitter 无关，grep 时别误判。
- **core 零 `process.env` / `process.argv`**：账本槽位是显式参数。
- **配置只经 `ctx.config` 这一个必填访问器**：`ConfigAccessor` 只有泛型 `get`，无 `getAll`/`set`/模块级 Map/`globalConfigAccessor`。**所有会读配置的参数 / 选项均必填，不设全局默认。**
- **依赖载体只有一个 `ctx`**：`ForwarderBase` / `Dialer` / `BaseProxy` 都 `extends ContextualBase`，零自有 `config` 字段与投影 getter。`ContextualBase` 构造零副作用（不订阅事件、不读配置、不打日志、不碰 `process`/文件），getter 名字是契约。
- **判定输入收成只读入参对象**（`AccessControl` 三个方法）：位置参数在下一次加维度时必须改所有调用点，入参对象加字段是纯增量。字段全 `readonly`。
- **`readJsonCached` 的 missing 判据**只有 `ENOENT` / `ENOTDIR` / 非普通文件；其它 stat 错误（`EACCES` 等）保留上一份有效值并发 `error`，**ACL 不得静默全放行**。权威在 `src/utils/json-file/AGENTS.md`。
- **`ListenableServer` + `listenAsync` 只从 `server/base.ts` 取**（net / tls / http.Server 结构满足的最小形状）。别再各自包 `listen` Promise，也别为它新开 `utils/net.ts`。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

> **判据被测试断言锁住的条目不在这里。** 那类决策的「结论 + 否掉了什么 + 为什么」住在**断言它的那条
> `*.test.ts` 自己的开头条注释**里——判据变红时读到它的人就是该改它的人。这与本仓既定政策同源
> （`src/core/forward/base.ts:72` 与 97 个测试文件的头注释）：抄一份在这里就等于造一个无人守着的
> 副本，**没有任何测试断言文档内容**，抄错一边就静默地留着错的。

### 依赖承载体

1. **`CoreContext` 三项全必填、承载体里零兜底** — 否掉「给 logger / events 一个 noop 缺省」— 在承载体里兜底会把「忘注入」变成静默的运行期怪问题；缺省解析只允许发生在唯一组装根 `createProxyRuntime()`。⚠️ **本条没有测试牙齿**：`core-context.test.ts` 只证明「三个 getter 恒等转发、保持 `protected`、ctx 只读」——在 `ContextualBase` 里加一行 `?? createNoopLogger()` 全仓仍绿。**零兜底靠本条与 `context.ts` 的文件头**。
2. **`BaseProxy` 里 `this.events` 必须每次现读、绝不允许缓存成字段** — 否掉「构造期存一份」— `RuntimeContext.setEvents()` 能在运行期换总线，缓存会把「换完立刻生效」变成半个进程级暗改。⚠️ **这条纪律在本仓是靠注释与源码级断言维持的，不是靠运行时压力**：`setEvents` 的调用方全在**库调用方**（`ProxyRuntime` 公开面），`src/` 内零调用是**预期形态**。**谁把 `this.events` 缓存成字段，全仓测试都不会红**——改读取形态时必须自己复核，别把「护栏不存在」当成「没人发现问题」。
3. **`identity` 与 `services.identity` 两个访问路径并存是刻意的** — 否掉「统一成一个」— `BaseProxy` 上的 `protected readonly identity` 是 `socks-session.ts` 那份最小接口的字段名，比 `services.identity` 更贴近那份接口的语义；转发器一律写 `this.services.identity`。顺手统一会让 `sessionHost` 的接口读起来像转发器内部实现。⚠️ **本条没有测试牙齿**：`forwarder-request-path-allocation.test.ts` 那组只禁 `user`/`requestId`/`connectionId` 三个字段，**不涉及** `this.identity` 这个名字；改掉访问路径写法不会让任何用例变红。

### 三个可插值端口

- 三方法必须同步 / `proxyMode` 模式门归属 / 判定面只导出一个出口 / `upstream` 组动作与 `target` 组相反 → `tests/unit/access-control-port.test.ts`
- 凭证判据归 `IdentityProvider.isOwnCredential`（必填、无缺省）/ `proxy-` 前缀与凭证形态分开且顺序不可换 → `tests/unit/identity-credential-seam.test.ts`
- `reason` / `source` 是自由 `string`、消费方两条负向纪律、内置引擎的源码级自律 → `tests/unit/access-control-port.test.ts` + `tests/unit/user-acl-merge.test.ts`

### 配置访问

4. **ACL 观察面只有一个入口 `bindAclFileEvents(config, handler)`，工厂刻意不收 `onFileEvent`** — 否掉「给 `createFileAccessControl` 加个便利形参」— 两个入口会写同一个 `WeakMap`：两个 handler 都装上而判定层只认后装的那个，先装的静默收不到事件，外部表现是「日志说名单没变、判定却换了」。**少一个入口永远优于多一个便利形参。** ⚠️ **半个牙齿**：`access-control-port.test.ts` 的 import 白名单锁住「从 `@/core/access-control.js` 只能 import 这两个出口」，**但「工厂收几个形参」没有任何断言**——给 `createFileAccessControl` 加第二个 `onFileEvent` 形参不会让任何用例变红。
5. **显式传 `config` 只决定「读哪份 store」，不决定「读哪一份值」** — 否掉「把 store 快照进 core」— runtime accessor 对 runtime 相位字段**现读 live store**、对 startup 字段读 **runtime 构造时的冻结值**。故同一个 accessor 上「改了就生效」与「改了不生效」是**按相位**的，不是按读法。`UPSTREAM_URL` 属于 startup，改它必须重建 runtime。⚠️ **半个牙齿**：`config-access.test.ts` 逐条钉住「accessor 每次现读 store / 换一份 accessor 就换一份真相源 / 互不串号」，`config-instance.test.ts` 钉住「startup 键集合来自 `keysByPhase()`」；但**「runtime 对 startup 字段读冻结值」这条行为本身没有端到端断言**——把 accessor 改成对 startup 字段也现读 live store，那几档仍会全绿。

### 请求作用域与终态

- `RequestScope` 是纯值对象、逐请求身份绝不存实例字段 → `tests/unit/forwarder-request-path-allocation.test.ts`
- 关联 id 只从 `context` 派生、`RequestScopeOptions` 不再收 id 形参 → `tests/unit/dead-optionality-cleared.test.ts`
- 身份注入只发生在 `createRequestScope` 一个地方（`src/**` 恰好一个调用点）→ `tests/unit/inbound-dispatch.test.ts`

### 错误边界

6. **`error-boundary.ts` 只分类与生成安全消息，不读环境 / 文件、不写协议、不打印日志** — 否掉「让协议层各自判 502/504」— 分类、脱敏与公共事件发布集中在一处，协议入口只负责记录**已经发生**的 completed / rejected / failed。观察者（`EventHub` listener）异常不得改变分类结果或调用方控制流。`statusForCause` 只表达拨号收尾的 504/502 分工，**不让调用方在 catch 里再复制一套判断**。`classifyError` **不猜测客户端 400**。⚠️ **只有前半句被测**：分类集中、`statusForCause` 与 `classifyError` 状态码一致、观察者异常隔离、不猜客户端 400 这四条有断言（`tests/unit/error-boundary.test.ts`）；**「零环境读取 / 零文件 / 零协议写入 / 零日志」全仓零断言**（没有任何对应的源码级护栏）。改这半句只能自己复核，别把「护栏不存在」当成「没人发现问题」。

### 拨号守卫

7. **状态行等待统一走 `awaitStatusLine`；`upstreamTimeout` 只兜时间不兜内存** — 否掉「每处自己写超时 + 大小判定」— 字节封顶在 `readResponseHead`，两者是两种不同的兜底，混写就会出现「只兜了内存」或「只兜了时间」的半份。⚠️ **这条分工没有任何断言**：`readResponseHead` 在 `tests/` 里零命中，`awaitStatusLine` 只被当普通函数调用过。「只兜时间不兜内存」是纯设计取舍，靠本条与源码头注释。
