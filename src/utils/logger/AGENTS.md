# src/utils/logger/ — 文件与路径说明

日志端口与实现。

对外唯一出口：`@/utils/logger/index.js`。

## 文件

- `port.ts` — 契约层：`Logger` 端口、`LogFields`、`LogLevel`、等级权重 `ORDER`、终端色码 `COLOR`。
- `sanitize.ts` — 文本净化与参数拆分：`sanitizeLogText` / `renderErrorText` / `isPlainObject` / `splitFields` / `renderFieldValue` / `renderFields` / `stringifyValue`。
- `jsonl.ts` — 落盘子系统：`toHourlyFile`、在途集合 `pendingWrites`、`persistLine`、`flushPendingWrites`（barrel 未导出）。
- `impl.ts` — `LoggerImpl` + `createLogger` + `LoggerOptions`，双通道实现。
- `console.ts` — `createConsoleLogger`，轻量实现。
- `noop.ts` — `createNoopLogger`，库 runtime 的缺省实现。
- `index.ts` — 目录 barrel（`port` / `sanitize` / `impl` / `console` / `noop`）。

## 相关路径

- 事件码词汇表 — `@/core/log-events.js`
- 事件 → 落盘 switch — `src/runtime/event-log.ts` 的 `bindProxyEventLogs`
- 启动配置快照打印 — `src/server/log/config-log.ts`
- JSON 热加载事件的 logger 注入 — `src/utils/json-file/event-log.ts`
- 库缺省 logger 的使用点 — `src/runtime/runtime.ts`

## 相关测试

- `tests/unit/logger.test.ts`
- `tests/unit/logger-port.test.ts`
- `tests/integration/log-structured.test.ts`
