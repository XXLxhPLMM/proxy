# src/core/traffic — 每用户流量配额

七份文件，职责**互不越界**（与 `../access-control.ts` 的三层纪律同构）。

## 路径说明

| 文件 | 只负责 | 依赖 |
|---|---|---|
| `types.ts` | **端口**：`TrafficDirection`（`up` = 客户端→上游 / `down` = 上游→客户端，**方向不许反**）、`TrafficScope`、`TrafficVerdict`、`TrafficUsage`、`TrafficAccount`、`QuotaResolver`，**落盘四件套** `TrafficSink` / `RestoredLedger` / `TrafficLedgerController` / `TrafficLedgerError` | `@/config/index.js`（type-only `UserQuota`） |
| `window.ts` | **窗口键**：`QuotaWindow`（`day｜month` 闭合字面量集）、`DEFAULT_QUOTA_WINDOW`、`quotaWindow`（缺省归一）、`windowKey`（含 `clampShiftHours`） | **零 import**（纯函数叶子） |
| `memory.ts` | `MemoryTrafficAccount` + `TrafficWindowSource` 注入口 + `createMemoryTrafficAccount` + 显式禁用档 `inertTrafficAccount`；**`bindSink()`**（挂落盘）与 **`seed()`**（恢复播种） | `./types.js`、`./window.js` |
| `ledger.ts` | **落盘账本**：`LedgerEntry` 格式、`TRAFFIC_SLOT_ENV`/`normalizeSlot`/`ledgerFileName`、`parseLedger`/`summarizeCurrent`/`compactEntries`、类 `JsonlTrafficLedger` | `./types.js`、`./window.js`、`./flush-loop.js` |
| `flush-loop.ts` | **落盘驱动** `startFlushLoop` —— **`traffic/` 内唯一的定时器站点**（恰好一处 `setTimeout`、自重排、`unref`） | 零 import |
| `meter.ts` | **计量落点**：`meterStream`（单流被动计数）/ `openLinkMeter`（一对流 + 首批载荷补记口） | `./types.js`、`node:stream` |
| `index.ts` | 层出口 | — |

**不属于本层**：`users.json` 的读面与配额字段校验（`src/config/files/users.ts`）、`UPSTREAM_*` 配置项本身、四个转发器上的三个挂点（`../forward/base.ts`）。跨目录一律 `@/core/traffic/index.js`；`QuotaWindow` 也经此出口被 `config/files/users.ts` type-only 消费。

## 硬约定

- **无鉴权 → 配额整体不生效**（产品决策）：没有身份就没有归属，故 `meterStream` 在 `user === undefined` 时**一个监听器都不挂**（关鉴权的部署零开销）。启动时若账号表里真有非全 0 的配额则打一条 `[quota-inert]` warn（文案 `../log-events.ts:QUOTA_INERT_DETAIL`，**判据是文件事实而非配置猜测**）。护栏断言的是「`consume` 一次都不许被调」而不是「usage 恒零」——后者区分不出「没调」与「调了但查不到配额」。
- **`consume` 必须同步**。无锁的全部论证就是「一次 `consume` 从读到写没有 `await` 点，Node 单线程事件循环不可能在中间插入另一个 `consume`」。护栏 `tests/unit/traffic-account.test.ts` 把它钉成源码级事实（零 `async`/零 `await`/零定时器/零微任务），并额外钉住「**`traffic/` 内唯一的定时器站点是 `flush-loop.ts` 那一处 `setTimeout`**」。
- **窗口化：每用户槽位带 `windowKey`，滚动即清账**。槽位是 `{windowKey, up, down}`，**每次访问槽位时**（`consume` 与 `usage` 共用私有 `slotFor`）比对当前窗口键——不同即用量清零并换键。**惰性滚动，零定时器**。
- **`src/core/**` 与 `src/runtime/**` 一律不许读 `process.env`，槽位是显式参数。** 传递链是 `cli.ts` 的 env 快照 → `runServer(context, { trafficWorkerSlot })` → `ProxyServer.trafficWorkerSlot` → `createProxyRuntime({ trafficWorkerSlot })` → `runtime/services.ts:buildDefaultServices` → `JsonlTrafficLedger`。理由与其它配置端口同源，但在这里**更硬**：槽位**会被拼进账本文件名**，一次「猜来源」就是一次「写错文件 / 读别人的账」。env 名 `PROXY_WORKER_SLOT` 的**唯一写入方**是 `server/cluster.ts` 的 fork（`core → server` 是被禁方向），且它**刻意不进 `FIELDS`**。护栏 `tests/unit/traffic-ledger.test.ts` 的「core/** 与 runtime/** 零 process.env」**逐文件扫全文**。
- **四个转发器必须共享同一个账本实例**（各建各的等于没配配额），故它们构造时都收 `ctx` + `services` + `connectors` 三个**必填**参数。
- **账本本身零配置依赖**：不读 `ConfigAccessor`、不读 `process.env`，目录 / 间隔 / 窗口 / 「有没有配额」全部由装配点以闭包注入（`slot` 是显式的**字符串**）。窗口口径（`resetHour` 闭包、`now` 不注入）**只**在 `runtime/services.ts:buildDefaultServices` 注入——理由见 `src/runtime/AGENTS.md`。
- **`ProxyOptions.traffic?` 缺省 = 显式禁用档 `inertTrafficAccount()`**，与 `identity` 的 `noneIdentity()` 先例完全同构，归一只发生在 `BaseProxy` 构造期一处。**落盘副本也只在那里注入，且与默认内存账本同生共死**：调用方显式注入 `services.traffic` 时 `services.trafficLedger` 恒为 `undefined`。

## 计量落点与落盘账本（机制正文在文件头）

本目录四个实现文件的头注释已各带 3-6 KB 完整机制（`ledger.ts` / `meter.ts` / `window.ts` / `flush-loop.ts`，合计 17 KB）——**本节只留跨文件的裁决**，逐行机制去读那些文件。

- **计量是被动计数**：在**源流**上挂 `data` 监听器只读 `chunk.length`，**不插 Transform、不改 pipe、不用 pause/resume 整形**。⚠️ **HTTP 的 `up` 绝不能挂 `req.socket`**：入站 socket 被 keep-alive 的多个请求共享，在它上面计数就是账本串号。不经 `data` 事件的首批载荷（`head`/`rest`/SOCKS 余量）经 `meter.charge(dir, n)` 显式补记，判定不通过就**不写**。
- **已知不对称（诚实记录，不假装两侧对称）**：隧道 / SOCKS / WebSocket 走裸 socket，**两个方向都精确**；HTTP 普通转发的 `IncomingMessage` 流**只覆盖消息体**（请求行+头、状态行+头是 Node 直接写进 socket 的），故 HTTP 路径**两个方向各少算一个 HTTP 头**（`up` 约 90–200B、`down` 约 60–150B）。**不要为了「补齐」在 core 里合成 Node 已经写出去的字节**——那就不是被动计量了。护栏按「显式说明的误差」断言：HTTP 路径只断言**消息体字节数逐字节相等**。
- **账本格式** `<quotaLedgerDir>/worker-<slot>.jsonl`，一行一条 delta `{ ts, u, d, b }`，**只写增量绝不写绝对值**（写绝对值等于让「谁最后写」成为唯一真相）。坏行**跳过而不是抛错**：一行脏数据让整本账打不开 = 配额整体失效。
- ⚠️ **压缩流程里的「关句柄」不是洁癖，它承重**：Windows 上 `rename` 覆盖一个**仍打开**的文件必然 `EPERM`。`compact(reopen)` 的参数就是为「压缩后要不要重开句柄」留的。**压缩幂等**靠**保留幸存条目里的最大 `ts`**（不是压缩时刻）——`ts` 必须落在该窗口内，重压才算出同一个键。`compactEntries`（丢弃过期窗口）与 `summarizeCurrent`（恢复只认当前窗口）**必须用同一条 `windowKey` 判据**，否则「恢复算进来的量比压缩保留的量多」。
- **写盘失败韧性**的正确形态只有一种：**内存计数继续 + 未落盘 delta 累积留待下次重试 + 一条可见事实**（`traffic.ledger-error` → `[quota-ledger-error]` error 级，**文案必须写明「不要为此重启」**——重启会把队列里未落盘的增量一起丢掉）。**重试可能重复计一次账**，这是刻意选的**安全方向**：多算 = 少用一点额度，少算 = 白拿额度；压缩会把重复行求和收敛回正确值。
- **`clampShiftHours` 必须把 `shiftHours` 夹到 `[0,23]`**：`quotaResetHour` 在配置层已被 FIELDS 校验，但**库调用方可以绕过 `loadConfig`**（`ConfigStore` 零校验），所以「配置层保证 0..23」对库路径**不成立**。不夹的代价是具体的：畸形键会进恢复结果的 `windowKey` 并参与判定。`flush-loop.ts` 的间隔下限夹 1 同理（0 / 负数 = 忙循环 = 纯 CPU 挂死）。
- **`now` 必须可注入**（`TrafficWindowSource.now?`，缺省墙钟）：窗口边界最容易写错，靠真实时钟只能写出「今天大概对」这种测不出回归的用例。生产路径**不需要**注入（账本只用它算键，滚动是惰性的），故做成可选。
- **`traffic.quota-exceeded` 的 `user` 必填**：无身份即不计量，这条事件不可能出现在无鉴权部署上；写成可选就等于允许消费方回答「配额是谁的」这个答不出来的问题。

- **`traffic.quota-exceeded`**（`AppEventMap`），载荷 `{ user, dir, scope, usage, limit }`（`user` **必填**：无身份即不计量，这条事件不可能出现在无鉴权部署上；写成可选就等于允许消费方回答「配额是谁的」这个答不出来的问题）。生产点唯一：`../forward/base.ts:ForwarderBase.publishQuotaExceeded`，**直接发公共事件而不走 `pipe`**——刻意**不**给 `PipeEvent` 判别联合加第 15 个变体。`EventContext` 恒带 `user`，其余关联维度取自 `scope.terminal.snapshotContext()`。
- **`traffic.ledger-error`**（`{ path, error }`），生产点 `JsonlTrafficLedger.report`（经 `runtime/services.ts` 注入的 `onLedgerError` 闭包）→ `runtime.ts` 只 `publish`，**不落日志**。落盘那一跳是 `src/runtime/event-log.ts` 的职责（判据见 `src/runtime/AGENTS.md`）。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

> 已被测试断言锁住的决策不在这里——它们的「结论 + 否掉了什么 + 为什么」写在**那条断言自己所在的测试文件的头注释**里（判定与同步性在 `tests/unit/traffic-account.test.ts`；窗口键与滚动在 `tests/unit/traffic-window.test.ts`；槽位与写盘韧性在 `tests/unit/traffic-ledger.test.ts`；硬切收尾在 `tests/integration/traffic-quota.test.ts`；四个被否决方向在 `tests/unit/user-quota.test.ts`）。本清单只留**没有任何测试会红**的纯设计取舍。

1. **`consume` 里时刻只取一次**（`const now = this.clock()`）并同时喂给 `slotFor` 与 `record` — 否掉「两处各调一次时钟」— 窗口键与落盘 `ts` 必须同源，否则同一批字节会被判定分到窗口 A、却按窗口 B 落盘（重启恢复后用量就错了）。⚠️ **没有测试会红**：`tests/unit/traffic-account.test.ts` 的 `now: () => 1_000` 与 `tests/unit/traffic-ledger.test.ts` 的 `now: (): number => clock.now` **都是稳定值**（不是单调计数器），调两次得到同一个数，两处断言都照样过。要让这条有牙齿，得先有一个会「每调一次就前进」的注入时钟。
2. **端口拆成 `TrafficSink` 与 `TrafficLedgerController` 两个** — 否掉「合成一个 `TrafficLedger` 接口」— 两个调用方、两种失败代价：`record` 由 `consume` 在**同步区间内**调用（每 chunk 一次），抛错就等于把「写盘失败」变成「转发失败」，必须是最小同步面；`open`/`close` 只在 `runtime.start/stop` 各调一次，**允许 Promise**。合在一个接口上最容易顺手让 `record` 也返回 Promise——那正是**明确禁止**的方向。同理 `seed(restored)` / `bindSink(sink)` 刻意**不进 `TrafficAccount` 端口**（端口是「用量与判定」的契约，落盘位置与规模诊断是装配决策）。⚠️ **没有测试会红**：合端口是**编译期**破坏（调用点的实参形状对不上），不是静默退化；本仓没有一条断言去数 `TrafficSink` 的方法闭集。
3. **`enabled()` 判据与 `quota-inert` 告警判据必须是同一个函数**（`hasConfiguredQuota`）— 两处各写一份，迟早出现「告警说没配、账本说配了」。判据表见 `tests/unit/traffic-ledger.test.ts` 头注释 ⑪。⚠️ **本条只有一半有牙齿**：⑪ 的「锁点」写的是一句 `import { hasConfiguredQuota } from "@/runtime/services.js"`——**那是 import，不是 `expect()`**，而该档脚手架是直接注入 `enabled: () => false` 的。**若 `runtime.ts` 改用自己的一份副本去算 `quota-inert`，本档全绿。****账本零成本档与告警共用它**这一点是本条的全部要求；窗口口径（`resetHour` 闭包、`now` 不注入）**只**在 `runtime/services.ts:buildDefaultServices` 注入——理由同样见 `src/runtime/AGENTS.md`。⚠️ **没有测试会红**：`tests/unit/traffic-ledger.test.ts` 的脚手架**直接注入** `enabled: (): boolean => false`，而 `hasConfiguredQuota` 那条只测它自己的行为；两份实现即使分叉，全仓仍然全绿。要有牙齿必须断言「生产装配点传给账本的那个闭包 === 告警用的那个」。

## ⚠️ 已知限制（**不要假装已修**）

- **账本是纯内存无淘汰的 `Map`**。`users.json` 固定规模时天然有界，但 `authType=jwt` 的 `sub` 理论上可无限增长。**落盘压缩解决了这条限制的「持久」那一半**（压缩按 `(用户, 窗口键)` 求和并丢弃已过期窗口的条目，故「28 个 `sub` 跨 28 天」在压缩后文件行数降到 0，重启恢复时这些过期槽位根本不会回到内存——**磁盘上那一份，现在是有界的**）。**未解决的是同一个长跑进程内的内存 `Map` 仍不淘汰**（`memory.ts` 零 `.delete(` 仍是护栏）。
- **刻意不加 LRU 之类猜测性淘汰** — 淘汰策略必须与配额窗口一起设计，否则会出现「配额还没过期、账本先被淘汰」这种更糟的行为（被淘汰的用户拿到一份清零的账 = **凭空多出一份额度**）。彻底解决需要先定义那条语义、再重启一次进程；**谁想加淘汰，必须先改 `tests/unit/traffic-window.test.ts`（`memory.ts` 零 `.delete(`、零 LRU/容量上限字样）与 `tests/unit/traffic-ledger.test.ts`（同一条负向断言扩展到 `ledger.ts`/`flush-loop.ts`）并说明淘汰语义**。
