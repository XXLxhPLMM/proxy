# src/core/events — 事件内核

core 的全部事实（含生命周期跃迁）都直接发布到注入的 `EventHub`。`src/core/**` 零 `EventEmitter`。

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `types.ts` | `AppEventMap`（**事件契约的类型单一来源**）/ `EventData` / `EventEnvelope` / `EventContext` / `EventListener` / `RequestStage` | 元组声明参数，`EventData` 取元组首项作为实际 payload |
| `hub.ts` | `EventHub` + `EventSubscription` | 只公开 `publish`/`subscribe`/`once`/`listenerCount`/`removeAll`/`merge` |
| `scope.ts` | `EventScope` + `createRuntimeScope` / `createConnectionScope` / `createRequestScope` | 承载**关联事实**，不保存日志或控制状态 |
| `index.ts` | 层出口 | 跨目录一律 `@/core/events/index.js`；层内禁止自引 barrel |

`"pipe"` 的 data 类型是 `import type { PipeEvent }`（编译期擦除；`types/proxy.ts` 不 import 本文件，故无环）。`EventContext.runtimeId` 必填，connection/request 作用域可选，另带 `method?`（日志面要还原 `[forward]` 行的 method，而事件载荷刻意不携带原始 `IncomingMessage`）。

## 硬约定

- **事件内核不直接打印日志**，不读 `process.env.NODE_ENV`。缺省完全静默——只有显式 `reportListenerErrors: true` 才走 `process.emitWarning`，或由调用方直接传 `onListenerError`。
- **分发使用 listener 快照**：emit 期间新增或 dispose 不改变当前这次迭代；单个 listener 抛错被隔离并交给 `onListenerError`，**不得**影响其它 listener 或 `publish` 返回。
- **内部订阅表与分发实现不得暴露 Node `EventEmitter`**。`EventSubscription.dispose()` 幂等。`removeAll()` 之后 publish 是安全空操作。
- **作用域层级固定 `runtime → connection → request`**：`child()` 继承父级 id，可覆写/补 protocol/client/user/target；`toContext()` 只返回不含 runtimeId 的 publish 上下文。
- **事件只发布已经发生的事实，不驱动控制流**：鉴权、访问控制、路由、请求完成/拒绝/失败由生产方发布，订阅方只观察。落盘另收在 `src/runtime/event-log.ts`。
- **`AppEventMap` 事件清单不重抄在这里** —— 它就在 `types.ts` 里，改代码即改清单。

## 管道事件判别联合（`PipeEvent`，声明在 `types/proxy.ts`）

- **14 变体、无索引签名**：生产者与消费者必须按同一契约演进，**禁止** `Record<string, unknown>` 式任意字段。消费方覆盖全部 case 后须在 `default` 用 `e satisfies never` 做穷尽性收口。
- **唯一出口是逐请求的 `RequestScope.emit`**。`ForwarderBase` 零 `emit` 实例字段、零 `emitWithUser` 方法；`PipeEventSink` 在 `core/forward/**` 与 `core/server/**` 里零出现。`server/{http,socks-base}.ts` 只造 scope、不中转发布。
- **`guard.ts` 侧的 `HelperEventSink` 仍在**，但它的**类型**只是 `OpenContext.onEvent` 与 `guardDialing({ onEvent })` 的形参类型（channel 传进来的就是 `scope.emit`），**不是「第二个事件槽」**。`HelperEvent` 是 `PipeEvent` 的真子集，只覆盖五个拨号守卫变体，可直接进入 pipe 事件槽。
- **与 `LogEvent` 重名的 9 个判别键不另写字面量**：`type` 写成 `typeof LogEvent.TargetUnresolved` 之类 9 处，运行时字符串值一字未变，改码只动 `LogEvent` 一处。⚠️ **两侧差集是事实差异，禁止补齐**：`client-timeout`/`tls-client-error` 只属握手/接入期日志（没有对应 pipe 事件）；`route`/`socks`/`dial`/`established`/`debug` 是落盘不走的内部细节事件。
- `PipeRouteEvent.mode` / `.route` 是必填受限字面量，与 runtime 层 `[route]` 日志行保持 1:1，**不得**删字段、改可选或扩成任意 `string`。
- **`PipeTargetDeniedEvent.source` 是自由 `string`，刻意不进 `PipeEventBase`**（那是 14 变体共享维度）。理由与代价见 `types/AGENTS.md` 与 `../AGENTS.md`「三个可插值端口」小节。
- 护栏 `tests/unit/pipe-event.test.ts` 锁全部类型契约（清单、必填字面量、公共可选维度、`toEqualTypeOf` 精确形状、switch 收窄与穷尽性、HelperEvent 子集、无索引签名）。

## 请求终态（实现文件 `../request-terminal.ts`）

- **终态唯一来源原则**：每个请求终态**只由 `RequestTerminal` 抢占并发布一次**（`completed` / `rejected` / `failed` 首次 `claim` 成功后互斥且唯一；`complete` / `reject` / `fail` 在抢占后才发布，观察面异常不会反向改变协议收尾）。`PipeEvent` 侧**不得**再为同一事实发一条公共拒绝 / 失败事件。典型：`target-unresolved` 时刻的 `pipe: target-unresolved` **只服务日志面**（`[target-unresolved]` warn），`runtime/bridge.ts` 刻意不桥它——桥它就是同一次拒绝发两条。**新增任何 pipe 变体前先确认它没有已由终态 publisher 覆盖的公共形状。**
- **publisher 注册表按 accessor 隔离**：走模块级 `WeakMap<ConfigAccessor, Map<protocol, publisher>>`，隔离**只**建立在「每个 runtime 派生自己的 accessor 对象」这个隐含约定上；同 protocol 下后注册的会顶掉前一个，前者终态将静默消失。退订函数幂等且**不误删他人** publisher（`current?.get(protocol) !== publisher` 保护）。
- **`requestTerminals` WeakMap 的职责是跨事件通道取回，不是去重**：Node `clientError` 事件**只给 socket、拿不到 req**，`server/http.ts` 的 clientError handler 靠 `requestTerminalFor(socket)` 判断该连接上是否已有在途请求、有则复用其 guard（避免 malformed 拒绝与请求自身终态互相抢抢占），没有才新建一个专用于该次拒绝。请求自身不需要反查——id 与 guard 都由入口经参数逐层传递。`handleForward` **只把 terminal 关联到 socket，不关联 req**。
- runtime `CoreEventBridge` 按 `ConfigAccessor + protocol` 注册内部 publisher：`rejected` / `failed` 经 `ErrorBoundary` 发布到公共 `EventHub`，`completed` 直接使用既有 `request.completed` 契约；CLI 的 `pipe` 日志面不新增 core 事件。
- **各协议的终态接入点**（HTTP：客户端名单 / 鉴权 / 入口异常 / `clientError` / 目标解析 / 响应 `finish` / 上游 error-timeout-提前 close / CONNECT 与 Upgrade 的建隧与收尾；SOCKS：`onConn` 的客户端名单与连接异常 / `socks-session` 的非法握手 / `connect()` 的目标校验与建隧与上游失败）见 `../server/AGENTS.md`。既有状态码与写报文逻辑不改，事件只在其旁边记录**已经发生**的终态。
- 护栏 `tests/unit/request-terminal.test.ts`（互斥语义）+ `tests/integration/request-terminal-events.test.ts`（真 `ProxyRuntime` 验证 HTTP/SOCKS 的 completed/rejected/failed 生产与唯一性）。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

> **判据被测试断言锁住的条目不在这里。** 那类决策住在**断言它的那条 `*.test.ts` 自己的开头条注释**里
> （判据变红时读到理由的人就是该改它的人，所以理由住在断言旁边而不是这里）。

1. **两个 `client` 是不同事实、刻意不合并** — 否掉「统一成一个字段」— 展示/审计口径走 `getClientAddress(req)`（XFF → X-Real-IP → Forwarded → socket），名单判定与 `ip-denied` 恒走 `getSocketAddress(socket)`（只认 TCP 对端）。合并等于让「能伪造的那个」直接变成「授权判据」。⚠️ **只有前半句有断言**：`tests/unit/ip.test.ts` 逐档钉住 `getClientAddress` 的回退链（XFF / X-Real-IP / Forwarded / socket / `"unknown"` 哨兵），`tests/integration/request-scope-ids.test.ts` 钉住事件 context 的 `client` 是 TCP 对端；**「`ip-denied` 与名单判定恒走 `getSocketAddress`」零断言**（`getSocketAddress` 在 `tests/` 里零命中），也没有一条断言说两个 `client` **不许**合并。
