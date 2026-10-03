# src/api/ — 控制面 HTTP 客户端（本包对线上契约的**全部**声明）

本目录是本包与控制面之间**唯一**的网络边界：端点表、手写响应形状、逐字段判据、失败三档、请求实现都在这里，
对外唯一出口 `@/api/index.js`。它是全包**最脆**的一个目录，因为它手抄着别人机器上那个进程的契约 ——
所以这里的每条纪律都在回答同一个问题：**「对面变了」怎么变成一句看得见的话，而不是一片空白。**
机制与决策的完整推导在各文件头，这里只列**不变量**（为什么弱耦合见 `packages/tui/AGENTS.md`）。

## 文件

- `endpoints.ts` — **端点表**（12 条 `(method, path)`）与 `:username` 模板代入。零判据。
- `types.ts` — **手写的响应体接口** + 写面入参 + 失败码闭合集 `WireCode`。**零判据**。
- `decode.ts` — 收窄组合子（`str` / `bool` / `num` / `nullable` / `optional` / `oneOf` / `arr` / `obj` / `opaque`）与 `Decode<T>`。零 IO。
- `wire.ts` — 把上面两张表接起来的**逐字段判据**（`SHAPES`）、编译期断言 `WireContractAssertions`、`WIRE_CODES` 与错误体的**宽松**读法 `readErrorBody`。
- `error.ts` — 本包唯一的失败词汇 `TuiError`（三档判别、四个静态构造）、`LOCAL_REQUEST` 与 `isRetryable`。
- `client.ts` — **本包唯一的拨号点**（`ManagerClient` / `call`）、基址归一 `normalizeBaseUrl`、空 patch 的本地判据，以及名单组名与方向两份**唯一**清单。
- `index.ts` — 目录 barrel，**只转发**。
- `AGENTS.md` — 本文件。

## 层不变量

- **唯一拨号点是 `client.ts:ManagerClient.call`，其余文件只做纯变换**（没有一处能触网、读时钟或读环境）。理由：契约与判据要能被单测逐字断言，而**替身只可能注入到拨号那一处**（本目录**没有** fetch 注入点）。
- **端点表是手抄的弱耦合**：控制面加端点时 `endpoints.ts` 与 `wire.ts` 都要动，⚠️ **不许**用「import 服务端的表」消掉这份重复。⚠️ **两道牙各管一半**：路径集合归根仓 `tests/unit/manager-tui-contract.test.ts`（从**两侧源码文本**现取再比集合），字段形状归 `wire.ts` 的编译期断言（**单向**就够，反向那条恒红）。
- **`WireContractAssertions` 必须是导出的并集**，不是局部 `type` 别名 —— 类型别名在运行时不存在，局部那个会被 eslint 判死，而「判据被 lint 判死」与「判据不存在」效果一样（静默消失）。
- **`TuiError` 三档分开的理由是处置动作不同**：服务端答了「不」⇒ 读文案；**根本没答上** ⇒ 查地址与网络；答了但形状不对 ⇒ 多半是对面版本新/旧。⚠️ **`message` 绝不转述对面的数据**（响应的 body、带凭据的地址、任何一段 token）—— 只说「哪个路径期望什么」。表外的 `code` 一律降级成 `internal` 但**保留 `requestId`**（唯一能接上服务端日志的线索），故错误体**刻意不走**严格解码器。
- **本地形状不对挂 `wire` 档 + `invalid` 码**（`TuiError.local`），不塞 `transport`、不新开一档；⚠️ 代价是 `status` 恒 `null`（**没收到响应就没有状态码，不许拿 `0` 冒充**）且 `request` 恒为 `LOCAL_REQUEST`。
- **`nullable` 与 `optional` 严格分工**：JSON 里「键不存在」不是 `null`，故 `fileOrigin` / `quota` / `expiresAt` 一律 `optional(...)`；用错会把「没配配额」判成「配了个坏配额」。收窄范围 = UI 会读的**全部**字段，唯一刻意的透传是 `configKey.value`（`opaque`）；`obj` **放行未知键**。
- **传输面不改写服务端的文案，也不重打码**：`message` / `notice` / `effective` / `sideEffect` / `note` / `lagMs` 原样透传，打码是服务端的决定。⚠️ `changed: false` 是**一次成功的 no-op**，不是失败。
- **`call` 先读 text 再判成败**，且 **`DELETE` 也带 body**（改用查询串就得多写一条分支，而那正是「删了 A 实际删了 B」最容易长出来的地方）。**每个端点一个方法**，不暴露通用 `request()`。**`normalizeBaseUrl` 只保留 origin**，⚠️「协议头后多打一个斜杠」（`http:///api`）**必须在 `new URL` 之前按原始文本判**。
- **零 `console`、零 `process.*`、零 React、零文件系统**：本目录**不 import 本目录以外的任何东西**（台账在 `@/ledger`，终端设施在 `@/terminal`）。

## 相关路径

- `@/ledger/index.js` — 上游：台账 → `ManagerEndpoint`（`connect.ts:clientFor` 是唯一转换点）与探活。
- `@/view/index.js` — 下游：`@/exec/run.js` 是**唯一**拨号的地方；执行层**原样透传**本目录交出的文案。
- 根仓 `src/manager/routes/*.ts` — 端点集合的另一侧真值；`src/manager/http/{auth,respond,router}.ts` 是请求头、失败码与路径判据的出处。
- 根仓 `src/ops/{error,report}.ts` — `WireCode` 前五档与 `DataRef` / `StatusData` 的镜像来源。

## 相关测试

- `packages/tui/tests/{endpoints,decode,wire,client}.test.ts` — 端点表自洽性、组合子真值表、逐字段判据（喂**从服务端源码抄来的等价样本**）、对**真 `http.Server`** 的端到端契约。
- `packages/tui/tests/ledger.test.ts` 的「台账 → 客户端」一节。
- 根仓 `tests/unit/manager-tui-contract.test.ts` — 路径集合那道牙。
- ⚠️ **本目录的「零 console / 零 `process.*` / 不 import 本目录以外」目前没有源码级护栏**（`tests/ledger.test.ts` 只扫 `src/ledger`）。改本目录时**必须**跑 `pnpm --filter @b-hole/proxy-tui lint` / `typecheck` / `test`。