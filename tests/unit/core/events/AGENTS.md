# tests/unit/core/events/ — 事件内核（`src/core/events/`）的判据

本目录只答一件事：**事件面是公共契约**，**哪几处不许漂**。`EventHub`（分发）+
`EventScope`（作用域派生）+ `AppEventMap`（事件名与 payload 的唯一声明处）+ `PipeEvent`
（管道事件的判别联合）。机制与层不变量归 `src/core/AGENTS.md`；落盘那条唯一真源是
`src/runtime/event-log.ts:bindProxyEventLogs`（core 自己不写日志）。

## 不变量放哪（⚠️ 判据是「这段不变量**有几档共用**」）

⚠️ **共用两档以上的不变量住在这份文件里**；只服务一个档的就地住在那个档的文件头里。
本目录两档，分布是：

| 段 | 几档共用 | 住处 |
|---|---|---|
| 事件面**不许退化成弱类型事件袋**（判别联合要穷尽、不许有索引签名） | 2 | 本文件 |
| **关联事实一律交出副本**（`publish` 的 context 浅拷贝 + `runtimeId` 补齐、`toContext()` 不泄漏 `runtimeId`） | 2 | 本文件 |
| 分发的三条替代方案（快照分发 / 异常隔离 / 缺省静默）各自为什么被否 | 1 | `hub.test.ts` 文件头 |
| `PipeEvent` 变体数是**契约**、两条 quota 事件刻意不进联合 | 1 | `pipe-contract.test.ts` 文件头 |

## 三条不变量

① ⚠️ **不许给事件面加索引签名。** `PipeEventBase` 上一个 `[k: string]: unknown` 会让 14 变体的
   **穷尽性彻底消失**：switch 的 `default` 分支里 `event` 永远收窄不到 `never`，于是「漏了新变体」
   从**编译期失败**退化成运行期一条静默的 `debug`。正确形态是让消费者在覆盖全部 case 之后于
   `default` 用 `e satisfies never` 收口。

② ⚠️ **`@ts-expect-error` 本身就是断言，而 vitest 不过问它。** 「故意漏掉一个 case 时收口失败」
   与「未知字段必须编译失败」这两处，靠的是「收窄意外成功时 `@ts-expect-error` 变成**未使用的
   抑制注释**」—— 那时 `pnpm typecheck` 当场红。⚠️ 所以这两档的判据**只有 typecheck 过得去**：
   测试全绿而类型契约已经松了，是这里最容易出现的状态。

③ ⚠️ **关联事实一律交出副本**：被否掉的是「把原对象交出去」（一个订阅方改了它就污染别的订阅方
   看到的**同一份** context）与「同一个对象既当上下文又当作用域」（作用域是**可变载体**，
   publish 上下文是**当次发布的值**）。锁点是「发布时浅拷贝 context，显式 `runtimeId` 优先且调用方
   后续修改不污染信封」+「`child`/`withIdentity` 返回独立快照，`toContext` 不泄漏 `runtimeId`」。

⚠️ `EventHub` **不暴露** Node `EventEmitter`（core 零 `EventEmitter` 是层不变量）。被否掉的三条替代
方案各自一条用例：借 `EventEmitter.emit` → 不保证「emit 期间改订阅表不改变本次迭代」；
借 `'error'` 事件 → 带来 `process` 耦合（诊断出口与库调用方的进程）是纯负债；
默认 `emitWarning` → **库总线**不该往用户的 stderr 写东西，诊断是**调用方的选择**
（`onListenerError` 逃生口与 `reportListenerErrors` 开关是同一条线上的两档，且默认档连
`NODE_ENV` 都不读）。

## 文件（⚠️ 不变量 ↔ 位置对照）

- `hub.test.ts` — **不变量 ③ 加上分发那三条**：快照分发（`emit` 中新增/释放 listener 不改变本次
  迭代）、单个 listener 异常隔离、缺省完全静默，外加 `dispose` 幂等 / `removeAll` 之后 publish 是
  安全空操作 / `once` 自动摘链 / `merge` 统一释放。
- `pipe-contract.test.ts` — **不变量 ① + ②**：14 变体在编译期与运行时均完备、`route` 两个路由字段
  必填字面量、公共维度保持可选、`switch` 收窄后字段可见、`e satisfies never` 穷尽收口、
  `HelperEvent` 的五个变体是 `PipeEvent` 的真子集、不接受联合未声明的任意字段。
- `../AGENTS.md` — 跨子目录共用的那两条（源码级负向断言锚点纪律 / 端口级必填）。

## 相关路径

- `src/core/events/types.ts` — `AppEventMap`（事件名与 payload 的唯一声明处）。
- `src/core/events/hub.ts` · `src/core/events/scope.ts` — `EventHub` 与 `EventScope`。
- `src/core/types/proxy.ts` — `PipeEvent` / `PipeEventBase` / `PipeEventType` / `HelperEvent` 的类型面。
- `src/runtime/event-log.ts` — 落盘那条唯一真源（`bindProxyEventLogs`）。
- `tests/unit/runtime/bridge/*.test.ts` — 事件订阅面（`data.kind` 契约值的消费点）。
- `tests/unit/core/error-boundary.test.ts` — 另一处 `EventHub` 消费者（收尾事实的出口）。