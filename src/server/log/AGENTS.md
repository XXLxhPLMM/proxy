# src/server/log/ — 文件与路径说明

配置快照子目录。

## 文件

- `config-log.ts` — `logConfig(context, logger)`：启动期配置冻结快照的打印与脱敏（secret / 口令 / 上游凭证 / 管理面 token）。

## 相关路径

- 调用方 — `src/server/index.ts` 的 `ProxyServer.start()`
- 启动 banner — `src/server/banner.ts`
- 事件词汇表 — `src/core/log-events.ts`
- 事件 → 落盘绑定 — `src/runtime/event-log.ts`
- 运行期 logger 注入 — `src/runtime/context.ts`

## 相关测试

- `tests/library/entry.test.ts`
- `tests/integration/logging/event-binding-source.test.ts`
- `tests/integration/logging/structured.test.ts`
- `tests/unit/config/store/instance.test.ts`
