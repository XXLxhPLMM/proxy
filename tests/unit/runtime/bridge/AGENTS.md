# tests/unit/runtime/bridge/ — `src/runtime/bridge.ts` 的事件桥接

本目录只答一件事：**core 那边的请求期事实，怎么变成库调用方在 `EventHub` 上看到的那套公共事件面**。
⚠️ **档间不变量住在这份文件里**，单档文件头只留「这一档管哪一段 + 指向本文件」；
「runtime 生命周期事件的唯一来源与订阅组归属」那份更长的不变量在 `../AGENTS.md`（①③④ 那几条）。

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

## 锁什么

① ⚠️ **`auth.decided` 的 `tag` 放 data、不放 context** — 被否掉的是「放 context」：`tag` 是「本次判定
   独有的事实」，不是跨事件复用的关联维度；放进 context 会让**每个**事件的 context 都背上它。
   牙齿（`deny-events.test.ts`）：`data` 与 `context` 两侧**逐字 `toEqual`** ——
   `data` 恰是 `{ passed, user, attempted, reason, tag }`、`context` 恰是
   `{ runtimeId, protocol, client, user, target, requestId, connectionId }`。任何一侧挪动 `tag`
   （或增删一个键）都同时红，故这条是**真断言**而不是「至少 tag 在某一处」。
   身份维度（client / target / user）进 context 是另一半：订阅方要靠它跨事件串联同一个请求，
   而 `data` 里只留一个 `passed` 什么也串不起来。

② ⚠️ **`request.started` 走 core 直发、不经 bridge，且它是公共事件面上唯一的非终态请求级事件** ——
   终态三件套是**结果**、`started` 是**过程**；缺过程的结果不可诊断：`auth.decided` 要开了鉴权才有、
   `route.selected` 要 client 模式才有，所以在**server 模式直连 + 关闭鉴权**这个最常见部署下，
   一次请求只剩终态，慢上游 / 长连接无法判断卡在哪一步。
   ⚠️ 「唯一」不是自称：`tests/integration/runtime/scope-ids.test.ts` 的
   `expect(events.map((e) => e.name)).toEqual(["request.started", "request.completed"])`
   正面证明「在这个部署下中间确实没有别的锚点」。

③ ⚠️ **关联 id 由 pipe 载荷派生、core 自己写进 `EventContext`；缺失即不带，桥接器不臆造** ——
   **桥接器可以臆造的唯一后果是「把不同请求串成同一个」**，那是比字段缺失更坏的事：
   宁可让订阅者知道「未知」。牙齿：`context.requestId` 与 `context.connectionId` 各一条
   `toBeUndefined()`。

④ ⚠️ **入站头的展示掩码与出站头剥离是两套方向相反的判据，不许「顺手统一」；且掩码必须在 publish
   之前完成** — 出站那一套（`core/helpers/headers.ts`）全部导出都是**出站**判定，而入站展示掩码是
   **入站**判定：同一个 `Authorization: Bearer` **出站要保留、日志里必须掩码**。混在一处迟早被统一掉
   而放大泄漏面。归属判据是「core 事实 → 可展示形态」而非「日志文本拼装」，故它就近住在
   `core/server/http.ts`、不进公共导出面。
   牙齿（`forward-events.test.ts`）：**整份载荷**里不得出现任何一段原值（含**未被列入敏感表**的头的
   值），而不只是「敏感表里那几个」——**「掩码在 publish 之前完成」是这条的前提**（事件总线对库调用方
   可见，不是 CLI 私有通道）；键仍在（就地掩码，不是删键）；**掩码不得误伤**（`x-trace` 原样）。
   断言只锁「值不再是原值」而**不锁掩码串的形状**：将来文案改成 `***redacted***` 不该让本护栏变红。
   ⚠️ `core/log-events.ts` 是 `[event-code]` **文本**层，`@/utils/logger/sanitize.ts` 才是**渲染**层
   ——判据是「谁拥有事件词汇」。

⑤ ⚠️ **桥接**缺失即跳过、绝不臆造**；但**表外 `reason` 原样透传**（这两半是一对，方向相反）** ——
   - `reason` **缺失 / 空串 → 整条不发布**。载荷里没有 `reason` 就没有「为什么被拒」这条事实，
     倒填一个（哪怕默认成 `blacklist`）等于**编造一条安全审计记录**。牙齿：五条样本（缺 `reason` /
     空串 / `target-denied` 缺 `reason` / 空串 / `target-denied` **缺 `host`**）**一条都不许发**。
     同档把「`host` 缺失有正当的跳过理由」（公共契约必填，缺了没法复述这次拒绝）钉在一起。
   - `source` **缺失不倒填 `global`** ——会把「个人名单拒的」伪装成「全局拒的」，运维去改错文件。
     牙齿：`expect(events[0].data).toEqual({ client: "10.0.0.9", reason: "blacklist" })` 是**逐键**
     比较，倒填一个 `source: "global"` 当场红。
   - `reason` **表外值（如 `rate-limited`）必须原样透传发布**，不得落到跳过那一个 `return`。
     访问控制变成可注入端口后，替换实现可能判出 `"rate-limited"` / `"geo-blocked"` 这类自由字符串；
     整条不发布等于「每一次这样的拒绝都不会在事件面上留痕迹」——**静默丢事件比字段缺失更坏**。
   - `pipe: target-unresolved` **刻意不桥接** — 它的事实已由协议入口的
     `requestTerminal.reject(..., "parse", 400)` 发布过一次，bridge 再桥一遍会在同一请求上造出第二条
     重复拒绝。

⑥ ⚠️ **桥接器**只认 pipe 载荷、完全重建 context**（忽略 core 已写进 context 的身份维度）** ——
   同一维度两个来源会让订阅方无法判断「哪个是权威」。牙齿：`context` **逐字相等**：
   `protocol` 恒取桥接器构造期的那个（**不是**载荷里 `protocol: "socks5"` 那个），
   多带任何一个 core 写进 context 的维度都红。身份提取 DI 只在**已映射变体发布前**且事件自带字段
   缺失时发生，不在桥接这一层。

⑦ ⚠️ **桥接是旁路、且只多挂一个观察者** — 观察者异常绝不能顺着 core 的发布反向打断鉴权 / 转发主流程；
   桥接也不许改事件投递语义（顺序、次数），它是「加一个 listener」而不是「接管 publish」。
   牙齿：`onListenerError` 收到那条异常而 `publish` 不抛 + 其它桥接事件照常发布；
   `listenerCount("pipe")` 从 1 变 3（宿主两个 + 桥接一个）而 `order` 顺序不变。

## 文件（⚠️ 不变量编号 ↔ 位置对照）

| 档 | 承载的不变量 |
|---|---|
| `deny-events.test.ts` | ①⑤ + `route` 映射与 `target-unresolved` 不桥接 |
| `forward-events.test.ts` | ②③④ + 身份提取 DI |
| `lifecycle.test.ts` | ⑦ + 「不派生」边界（`CORE_FACTS` 反向断言）+ runtime 启停接线 |
| `_core-event-bridge.ts` | 三档共用的观测面（`PROTOCOL` / `BRIDGED` / `recordAll` / `contextFor` / `newHub`） |

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
- `../AGENTS.md` — runtime 层的不变量 ①③④ 与账本纪律。
- `../../../helpers/{config,net,proxy,access}.ts` — `testConfig`/`testLogger`、`getFreePort`、
  `withProxy`、`openAccessControl`。