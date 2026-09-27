# src/core/traffic/

文件与路径说明。

## 文件

- `src/core/traffic/types.ts` — 流量端口与落盘端口类型：`TrafficDirection` / `TrafficScope` / `TrafficVerdict` / `TrafficUsage` / `TrafficAccount` / `QuotaResolver` / `TrafficSink` / `RestoredLedger` / `TrafficLedgerController` / `TrafficLedgerError`。
- `src/core/traffic/window.ts` — 窗口键：`QuotaWindow` / `DEFAULT_QUOTA_WINDOW` / `quotaWindow` / `windowKey` / `clampShiftHours`。
- `src/core/traffic/memory.ts` — `MemoryTrafficAccount`、`TrafficWindowSource` 注入口、`createMemoryTrafficAccount`、禁用档 `inertTrafficAccount`、`bindSink` 与 `seed`。
- `src/core/traffic/ledger.ts` — 落盘账本：`LedgerEntry` 格式、槽位与文件名、`parseLedger` / `summarizeCurrent` / `compactEntries`、`JsonlTrafficLedger`。
- `src/core/traffic/flush-loop.ts` — 落盘驱动 `startFlushLoop`，本目录的定时器站点。
- `src/core/traffic/meter.ts` — 计量落点 `meterStream` 与 `openLinkMeter`。
- `src/core/traffic/index.ts` — 层出口 barrel。

## 路径指引

- 对外唯一出口：`@/core/traffic/index.js`。
- 相关：`src/config/files/users.ts`（`users.json` 读面与配额字段）、`src/core/forward/base.ts`（四个转发器上的计量挂点）、`src/core/log-events.ts`（`QUOTA_INERT_DETAIL` 文案）、`src/runtime/services.ts`（账本装配与注入）、`src/runtime/event-log.ts`（事件落盘）。
- 相关测试：`tests/unit/traffic-account.test.ts`、`tests/unit/traffic-window.test.ts`、`tests/unit/traffic-ledger.test.ts`、`tests/unit/user-quota.test.ts`、`tests/integration/traffic-quota.test.ts`、`tests/integration/traffic-ledger-runtime.test.ts`。
