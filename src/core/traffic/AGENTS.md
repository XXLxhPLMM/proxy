# src/core/traffic/

文件与路径说明。

## 层不变量

以下几条已逐条核过（`src/core/traffic/**` 内零反例）。**本节只列不变式，理由留在各文件的头注释里。**

- **只有 `day` / `month` 两个日历窗**：`"week"` / `"hour"` / 非字符串在 `config/files/users.ts:validateUserQuota` 判**整组非法 → 启动期 abort**。滚动窗的取舍（解释成本 / 聚合成本 / 假安全感）见 `window.ts` 头注释。
- **只有一个合计上限**（`UserQuota.bytes`，上传 + 下载算在一起），**不分方向**：耗尽判定是**账号级封禁**，分方向上限实际等于「整号断网 + 要先撞满那个方向才触发」。故 `TrafficVerdict` / `traffic.quota-exceeded` 事件**都没有 `scope` 字段**，而 `dir`（本次流动方向）只作为**事件与账本的事实**透出。
- **`consume` 必须同步：无 `await`、无定时器、零 `node:` 内置模块 import**。无锁论证依赖「Node 单线程 + 同步区间内无让出点」。⚠️ **「同步」不等于「无 IO」**——这两层边界都锁进 `tests/unit/traffic-account.test.ts` 第 ⑧ 条决策。
- **窗口滚动只有惰性一种机制**（`memory.ts:slotFor` 的键比对），全目录零 `.delete(`、零「已释放」自设标志；**定时器站点唯一**是 `flush-loop.ts`（`ledger.ts` 与 `memory.ts` 零定时器，牙齿 `tests/unit/traffic-ledger.test.ts`）。
- **账本零配置依赖**：目录 / 间隔 / 窗口 / 「有没有配额」全由装配点以闭包注入，`core/**` 与 `runtime/**` 一律不读 `process.env`（槽位是显式参数，见 `TRAFFIC_SLOT_ENV`）。

## 文件

- `src/core/traffic/types.ts` — 流量端口与落盘端口类型：`TrafficDirection` / `TrafficVerdict` / `TrafficAccount` / `QuotaResolver` / `TrafficSink` / `RestoredUsage` / `RestoredLedger` / `TrafficLedgerController` / `TrafficLedgerError`。
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
