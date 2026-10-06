# tests/unit/core/events/ — 事件内核（`src/core/events/`）的判据

本目录只答一件事：**事件面是公共契约**，**哪几处不许漂**。`EventHub`（分发）+
`EventScope`（作用域派生）+ `AppEventMap`（事件名与 payload 的唯一声明处）+ `PipeEvent`
（管道事件的判别联合）。落盘那条唯一真源是
`src/runtime/event-log.ts:bindProxyEventLogs`（core 自己不写日志）。

## 相关路径

- `src/core/events/types.ts` — `AppEventMap`（事件名与 payload 的唯一声明处）。
- `src/core/events/hub.ts` · `src/core/events/scope.ts` — `EventHub` 与 `EventScope`。
- `src/core/types/proxy.ts` — `PipeEvent` / `PipeEventBase` / `PipeEventType` / `HelperEvent` 的类型面。
- `src/runtime/event-log.ts` — 落盘那条唯一真源（`bindProxyEventLogs`）。
- `tests/unit/runtime/bridge/*.test.ts` — 事件订阅面（`data.kind` 契约值的消费点）。
- `tests/unit/core/error-boundary.test.ts` — 另一处 `EventHub` 消费者（收尾事实的出口）。
