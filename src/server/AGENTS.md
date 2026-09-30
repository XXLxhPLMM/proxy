# src/server/ — 文件与路径说明

进程编排层。

## 文件

- `index.ts` — `ProxyServer`、`runServer` / `RunServerOptions` / `ProxyServerOptions`，并转出进程策略一组符号。
- `cluster.ts` — 多进程 fork、ready 汇总与退出编排（`runAsMaster()`）。fork **不注入任何账本槽位**（旧形态的 `PROXY_WORKER_SLOT` / `takeSlot` / `slotByPid` 已删除：分槽让配额从「账号级封禁」退化成「每进程一份封禁」，账本改为所有 worker 共用一个 SQLite 文件）。
- `process.ts` — 进程策略端口 `ProcessPolicy` / `SignalHost` / `ProcessStartupPreset` 与实现 `cliProcessPolicy` / `managedProcessPolicy` / `cliPreset()`。
- `process-guards.ts` — 进程守卫 `setupProcessGuards`（`uncaughtException` / `unhandledRejection` / `warning`）。
- `banner.ts` — 启动 banner 与 `proxy started:` ready 面；`scripts/gen-banner.mjs` 的生成物。
- `log/` — 配置快照子目录，见 `src/server/log/AGENTS.md`。

对外唯一出口：`@/server/index.js`。

日志行归属：`[config]`、`proxy started:`、`[shutdown]` ×2、banner。

## 不属于本层的路径

- 协议内部状态机（`BaseProxy`）— `src/core/`
- 事件词汇表与 pipe 事件文本 — `src/core/log-events.ts`
- 事件 → 落盘绑定 — `src/runtime/event-log.ts`
- 配置解析来源 — `src/config/`

## 相关测试

- `tests/library/entry.test.ts`
- `tests/integration/library-event-log-binding.test.ts`
- `tests/integration/lifecycle-log-binding.test.ts`
- `tests/integration/acl-inert-warning.test.ts`
- `tests/integration/usage-source-runtime.test.ts`
- `tests/unit/usage-source.test.ts`
