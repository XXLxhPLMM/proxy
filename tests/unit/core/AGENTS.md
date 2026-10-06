# tests/unit/core/ — core 那一层（`src/core/**`）的判据

本目录只答一件事：**core 这一层**（依赖承载体、错误边界、事件内核、日志词汇、终态守卫、
关联 id、拨号守卫、计量落点、入站派发表、转发器分配面、生命周期），**哪几处不许漂**。

## 相关路径

- `src/core/events/{types.ts,hub.ts,scope.ts}` — `AppEventMap` / `EventHub` / `EventScope`。
- `src/core/forward/base.ts` + `src/core/forward/channel/` — 四个入站通道与它们共用的基类。
- `src/core/server/{http.ts,admission.ts}` — 三个 `server.on` 回调、派发表、`createRequestScope`
  在 `src/**` 里**唯一**的那个调用点。
- `src/core/quota-meter.ts` / `src/datasource/quota/` — 计量落点与它消费的 `UsageAccount` 端口。
- `tests/helpers/source-scan.ts` — 源码级断言的公共文本面。

- `tests/helpers/{config,access,net}.ts` — `testConfig` / `openAccessControl` / `getFreePort`。
- `tests/integration/runtime/{request-terminal-events,scope-ids}.test.ts` — 这两层的端到端那一半
  （真 `ProxyRuntime` 下的终态唯一性 / `data.kind` 契约值）。
