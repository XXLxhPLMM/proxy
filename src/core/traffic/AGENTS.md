# src/core/traffic/

文件与路径说明。

## 层不变量

以下几条已逐条核过（`src/core/traffic/**` 内零反例）。**本节只列不变式，理由留在各文件的头注释里。**

- **只有 `day` / `month` 两个日历窗**：`"week"` / `"hour"` / 非字符串在 `config/files/users.ts:validateUserQuota` 判**整组非法 → 启动期 abort**。滚动窗的取舍（解释成本 / 聚合成本 / 假安全感）见 `window.ts` 头注释。
- **只有一个合计上限**（`UserQuota.bytes`，上传 + 下载算在一起），**不分方向**：耗尽判定是**账号级封禁**，分方向上限实际等于「整号断网 + 要先撞满那个方向才触发」。故 `TrafficVerdict` / `traffic.quota-exceeded` 事件**都没有 `scope` 字段**，而 `dir`（本次流动方向）只作为**事件与账本的事实**透出。
- **`consume` 必须同步：无 `await`、无定时器、零 `node:` 内置模块 import**。无锁论证依赖「Node 单线程 + 同步区间内无让出点」。⚠️ **「同步」不等于「无 IO」**——这两层边界都锁进 `tests/unit/traffic-account.test.ts` 第 ⑧ 条决策。
- **窗口滚动只有惰性一种机制**（`memory.ts:slotFor` 的键比对），全目录零 `.delete(`、零「已释放」自设标志；**定时器站点唯一**是 `flush-loop.ts`（`sqlite-ledger.ts` 与 `memory.ts` 零定时器，牙齿 `tests/unit/traffic-ledger.test.ts`）。
- **账本零配置依赖**：目录 / 间隔 / 窗口 / 「有没有配额」全由装配点以闭包注入，`core/**` 与 `runtime/**` 一律不读 `process.env`。
- **账本有两个后端、一个端口**：`TrafficLedger`（`types.ts`）由 `QUOTA_LEDGER_DRIVER` 选实现器 —— `SqliteTrafficLedger`（`sqlite-ledger.ts`，**所有进程共用一个库文件**，默认）/ `JsonlTrafficLedger`（`jsonl-ledger.ts`，单文件 JSONL，保留为单进程与人肉可读档）。两档的判定语义（窗口、硬切、事件）逐字相同，差别只在落盘机制。
- **账本是所有进程共用的同一个 SQLite 文件，零「槽位」概念**：`ledgerFileName(dir)` 只接目录。分槽（旧的 `worker-<slot>.jsonl`）让配额判定从「账号级封禁」退化成「每进程一份封禁」，故 `PROXY_WORKER_SLOT` / `normalizeSlot` / cluster 的 `takeSlot` / `trafficWorkerSlot` 整条链**已删除**，不得复活。
- **表结构只有一处**：`sqlite-ledger.ts:CREATE_TABLE`。`usage(u, w, v)` 主键 `(u, w)`、存**按 `(用户, 窗口键)` 求和后的绝对值**（不是增量行——数据库能就地求和，累加是 UPSERT 的原子操作）。UPSERT **必须只带 3 个占位符**（复用 `excluded.v`）：WASM 档按 `params.length` 逐位绑定，多一个就 `column index out of range`，而内置档静默接受——4 个占位符会让同一份 SQL 在两档行为不同。

## 文件

- `src/core/traffic/types.ts` — 流量端口与落盘端口类型：`TrafficDirection` / `TrafficVerdict` / `TrafficAccount` / `QuotaResolver` / `TrafficSink` / `RestoredUsage` / `RestoredLedger` / `TrafficLedgerController` / `TrafficLedgerError` / `TrafficLedger`（**注入面用的并集** = `TrafficSink` + `TrafficLedgerController`，只满足其一时那份替身会 open/close 却收不到 `record`）。
- `src/core/traffic/window.ts` — 窗口键：`QuotaWindow` / `DEFAULT_QUOTA_WINDOW` / `quotaWindow` / `windowKey` / `clampShiftHours`。
- `src/core/traffic/memory.ts` — `MemoryTrafficAccount`、`TrafficWindowSource` 注入口、`createMemoryTrafficAccount`、禁用档 `inertTrafficAccount`、`bindSink` 与 `seed`。
- `src/core/traffic/sqlite-ledger.ts` — 落盘账本：`SqliteTrafficLedger`、`LEDGER_DB_NAME`、`ledgerFileName`，表结构与 UPSERT、恢复（`restore`）、运行期与启动期的过期窗口清理（`pruneExpired` / `pruneExpiredIfDue`）。
- `src/core/traffic/jsonl-ledger.ts` — 账本的 **json 档**（`JsonlTrafficLedger`、`JSONL_LEDGER_FILE_NAME`、`sharedLedgerFileName`、`parseLedger` / `summarizeCurrent` / `compactEntries`、`DEFAULT_LEDGER_COMPACT_BYTES`）。`worker-<slot>.jsonl` 与 `normalizeSlot` 仍在文件里但**无调用方**：分槽是本仓换掉的真实配额逃逸，不给它复活的机会。
- `src/core/traffic/flush-loop.ts` — 落盘驱动 `startFlushLoop`，本目录的定时器站点。过期窗口清理挂进这个循环（**不另起定时器**），故它与累加共享同一条串行 Promise 链。
- `src/core/traffic/meter.ts` — 计量落点 `meterStream` 与 `openLinkMeter`。
- `src/core/traffic/index.ts` — 层出口 barrel。

## 路径指引

- 对外唯一出口：`@/core/traffic/index.js`。
- 相关：`src/utils/sqlite/`（驱动端口与两档实现：Node ≥ 22.5 内置 `node:sqlite` / Node 16–22 `node-sqlite3-wasm`）、`src/config/files/users.ts`（`users.json` 读面与配额字段）、`src/core/forward/base.ts`（四个转发器上的计量挂点）、`src/core/log-events.ts`（`QUOTA_INERT_DETAIL` 文案）、`src/runtime/services.ts`（账本装配与注入）、`src/runtime/event-log.ts`（事件落盘）。
- 相关测试：`tests/unit/traffic-account.test.ts`、`tests/unit/traffic-window.test.ts`、`tests/unit/traffic-ledger.test.ts`、`tests/unit/user-quota.test.ts`、`tests/integration/traffic-quota.test.ts`、`tests/integration/traffic-ledger-runtime.test.ts`。
