# src/runtime/ — 文件与路径说明

把仓库当库嵌入时的公开装配层；进程策略类文件住在 `src/server/`。

## 文件

- `runtime.ts` — `createProxyRuntime` / `isProxyProtocol`，以及订阅装配与退订（`activateSubscriptions` / `releaseSubscriptions`）。
- `services.ts` — `buildDefaultServices`、`hasConfiguredQuota`、`isAccessOverridden` 与 `RuntimeServices` 的默认服务。
- `context.ts` — `RuntimeContext`（`config` / `logger` / `events` 三件套持有者，`implements CoreContext`）。
- `types.ts` — `ProxyRuntime` / `ProxyRuntimeOptions` / `RuntimeServices` / `RuntimeWarning` 公共类型。
- `presets.ts` — `StartupPreset`、`defineStartupPreset`、`registerStartupPreset`、`pickStartupPreset` 与 6 个内置协议预设。
- `bridge.ts` — `pipe` 三个公开形状到公共 `AppEventMap` 的事件桥（库事件面）。
- `event-log.ts` — `bindProxyEventLogs`（11 类）与 `bindLifecycleLog`（`[lifecycle]`）的日志绑定（日志面）。两族都**恒装配**（`eventLogs` 缺省 `true`），零进程级例外档。
- `index.ts` — 目录 barrel。

对外唯一出口：`@/runtime/index.js`。

## 不属于本目录的路径

- 配置解析来源 — `src/config/`
- 协议实现与连接排空 — `src/core/server/`
- 进程策略 — `src/server/process.ts`

## 相关测试

- `tests/unit/runtime/presets.test.ts` + `assembly.test.ts`、`tests/unit/runtime/`、`tests/unit/core/context.test.ts`
- `tests/unit/runtime/bridge/`、`tests/unit/core/events/pipe-contract.test.ts`
- `tests/unit/datasource/quota/window-key.test.ts`、`tests/unit/datasource/quota/sqlite/`
- `tests/integration/logging/event-binding-runtime.test.ts`、`tests/integration/logging/lifecycle-binding-rows.test.ts`
- `tests/integration/acl/inert-warning.test.ts`、`tests/integration/quota/metering.test.ts`
- `tests/integration/quota/ledger-restart-recovery.test.ts`、`tests/integration/upstream/fail-closed.test.ts`
- `tests/library/entry.test.ts`
