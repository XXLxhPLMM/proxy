# src/core/

文件与路径说明。

## 根文件

- `src/core/context.ts` — `CoreContext` 三件套只读接口与 `ContextualBase`，core 的依赖承载体。
- `src/core/access-control.ts` — `AccessControl` 的文件实现 `createFileAccessControl` 与观察面 `bindAclFileEvents`。
- `src/core/error-boundary.ts` — 错误分类与安全消息生成（`classifyError` / `statusForCause`）。
- `src/core/guard.ts` — 拨号后上下游生命周期联动与状态行读取（`guardDialing` / `socksUpstreamGuard` / `readResponseHead` / `awaitStatusLine`）。
- `src/core/log-events.ts` — `LogEvent` 事件码表与 `[event-code]` 文本词汇层。
- `src/core/request-terminal.ts` — `RequestTerminal`，请求一次性终态守卫与终态发布。
- `src/core/request-scope.ts` — `RequestScope` 值对象与工厂 `createRequestScope`。
- `src/core/scope-ids.ts` — 关联 id 生成（`connectionIdFor` / `newRequestId`）。
- `src/core/identity.ts` — 身份层出口，逐个 re-export `identity/` 各文件。
- `src/core/index.ts` — core 的选择性 barrel。

## 子目录

每个子目录一份 `AGENTS.md`。

- `src/core/types/` — 三个端口与判别联合的类型声明处。
- `src/core/server/` — 入站建服骨架、`BaseProxy` 生命周期状态机、两阶段准入、入站派发表。
- `src/core/forward/` — 转发层，根上 `forward/base.ts`，子目录 `forward/channel/`、`forward/upstream/`、`forward/upstream/connector/`。
- `src/core/identity/` — 四种认证模式插件与配置驱动门面。
- `src/core/traffic/` — 每用户流量配额（端口、内存账本、落盘账本、计量落点、窗口键）。
- `src/core/helpers/` — 跨转发层共享纯工具（凭证、目标、自环、头、路由、上游、线缆、拨号前守卫）。
- `src/core/events/` — 事件内核 `EventHub` / `EventScope` / `AppEventMap`。

## 出口与相关路径

- 层 barrel：`@/core/helpers/index.js`、`@/core/events/index.js`、`@/core/traffic/index.js`。
- 相关：`src/config/`（配置状态与加载器）、`src/runtime/event-log.ts`（事件落盘绑定）、`src/server/`（进程编排与进程策略端口）、`src/utils/`（协议无关纯工具）。
- 相关测试：`tests/unit/core-context.test.ts`、`tests/unit/access-control-port.test.ts`、`tests/unit/error-boundary.test.ts`、`tests/unit/request-terminal.test.ts`、`tests/unit/inbound-dispatch.test.ts`、`tests/integration/tls-client-auth.test.ts`、`tests/integration/request-terminal-events.test.ts`。
