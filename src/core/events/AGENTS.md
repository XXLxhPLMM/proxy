# src/core/events/

文件与路径说明。

## 文件

- `src/core/events/types.ts` — 事件契约类型 `AppEventMap` / `EventData` / `EventEnvelope` / `EventContext` / `EventListener` / `RequestStage`。
- `src/core/events/hub.ts` — `EventHub` 与 `EventSubscription`（publish / subscribe / once / listenerCount / removeAll / merge）。
- `src/core/events/scope.ts` — `EventScope` 与三个作用域工厂 `createRuntimeScope` / `createConnectionScope` / `createRequestScope`。
- `src/core/events/index.ts` — 层出口 barrel。

## 路径指引

- 对外唯一出口：`@/core/events/index.js`。
- 相关：`src/core/types/proxy.ts`（`PipeEvent` 判别联合声明处）、`src/core/request-terminal.ts`（请求终态实现）、`src/core/guard.ts`（`HelperEventSink` 形态）、`src/core/log-events.ts`（`LogEvent` 事件码）、`src/runtime/event-log.ts`（事件落盘绑定）、`src/runtime/bridge.ts`（`CoreEventBridge`）。
- 相关测试：`tests/unit/core/events/pipe-contract.test.ts`、`tests/unit/core/request-terminal.test.ts`、`tests/unit/runtime/bridge/`、`tests/unit/utils/addr/inbound.test.ts`、`tests/integration/runtime/request-terminal-events.test.ts`、`tests/integration/runtime/scope-ids.test.ts`。
