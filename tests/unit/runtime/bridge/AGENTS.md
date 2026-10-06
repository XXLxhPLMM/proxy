# tests/unit/runtime/bridge/ — `src/runtime/bridge.ts` 的事件桥接

本目录只答一件事：**core 那边的请求期事实，怎么变成库调用方在 `EventHub` 上看到的那套公共事件面**。

## 地图

- `deny-events.test.ts` — **名单拒绝事件**那一半：core 直发 `auth.decided`（`BaseProxy.authorize`）
  的 payload/context 逐字形状 + `ip-denied`/`target-denied` 的桥接映射 + 缺失即跳过 / 表外
  `reason` 原样透传这一对方向相反的纪律 + `route` 映射与 `target-unresolved` 刻意不桥接。
- `forward-events.test.ts` — **core 直发事实**那一半：`forward.request-headers` 的掩码与订阅关系、
  `request.started` 作为唯一非终态请求级事件、关联 id 缺失即不带、身份提取 DI 覆盖默认提取。
- `lifecycle.test.ts` — **边界、隔离与接线**：哪些 core 事实**不派生**公共事件、桥接是旁路、
  `dispose()` 幂等、`attach` 只多挂一个观察者、runtime 的 `start`/`stop` 接线。
- `_core-event-bridge.ts` — 三档共用（不带 `.test.ts`）：`PROTOCOL` / `BRIDGED` / `Recorded` /
  `recordAll` / `contextFor` / `newHub`。

## 划界：三条通道，别混成一条

core 的事实进公共面有**三条**互不重叠的通道，本目录三档各钉一条：

1. **core 直发** — `auth.decided` / `request.started` / `forward.request-headers` /
   `forward.error` / `server.error` / `server.client-error` / `server.listening` / `server.closed`。
   它们**不经**桥接器：core 直接 `publish` 到注入的 `EventHub`，不经自带 EventEmitter 中转。
2. **bridge 桥接** — 只认 `pipe` 载荷，四条映射（`access.client-denied` /
   `access.target-denied` / `route.selected` / `request.rejected`）。
3. **runtime 派生** — `lifecycle.changed` → `runtime.*`，以及配置面那十几条（见 `../AGENTS.md`）。

⚠️ 被否掉的是「让 core 造一个通用事件包装器」——那是**第三个事件槽**与第二条发布路径。
⚠️ **新增任何 `pipe` 变体前先确认它没有已由终态 publisher 发布过**（变体清单是契约，见
`tests/unit/core/events/pipe-contract.test.ts`）；重复发布会在同一请求上造出第二条终态。

## 防假绿的位置

- ⚠️ **`recordAll` 的默认订阅集只有 4 条**（`BRIDGED`）：「不发的没发」那类断言必须显式传全集
  （`ALL_EVENT_NAMES.filter((name) => name !== "pipe")`），且**刻意不订阅 `pipe` 本身** ——
  那 10 个变体是**被发布的事实**，混进「派生」计数里就等于自己判自己。
  ⚠️ `ALL_EVENT_NAMES` 是**手抄**的 `AppEventMap` 全集：新增公共事件名时它不会自己跟着长，
  那条反向断言的覆盖面会静默收窄 —— 改 `AppEventMap` 时必须同一次提交里改它。
- ⚠️ `recordAll` **摊平信封成 `{ name, data, context }` 三元组**是为了让断言能逐键 `toEqual`；
  直接断 `EventEnvelope` 会在 `data`/`context` 上多出运行期字段而让逐字断言失去意义。
- ⚠️ 「公共事件观察者抛错」那条的对照是**同一 hub 上另一条订阅**（`route.selected`）：只断
  `onListenerError` 被调用的话，「其它事件也照常发布」那一半没人判。
- `dispose()` 幂等那条**正向**断「dispose 后 `attach` 再 `dispose` 不抛且 `listenerCount` 仍为 0」——
  只断「dispose 后不再发布」的话，「dispose 是个 no-op」的实现会绿。
- ⚠️ **账本目录**：本目录「runtime 桥接接线」那一档真 `runtime.start()` ⇒ 必须显式给
  `quotaUsageDir`（`LEDGER_DIR`），理由见 `../AGENTS.md`「账本目录」一节。

## 相关路径

- `src/runtime/bridge.ts` — `CoreEventBridge`（`attach` / `subscription` / `passthroughReason`）。
- `src/core/events/index.ts` — `EventHub` 与 `AppEventMap`（公共事件面全集的唯一真相）。
- `src/core/request-terminal.ts` — 请求终态的**唯一** publisher（`pipe: target-unresolved` 已由它发过）。
- `src/core/types/proxy.ts` — `PipeEvent` 变体清单（契约，增量前先查它）。
- `../../../helpers/{config,net,proxy,access}.ts` — `testConfig`/`testLogger`、`getFreePort`、
  `withProxy`、`openAccessControl`。
