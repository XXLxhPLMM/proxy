# src/utils/ — 工具面（本包唯一**会动手**的那一半）

回答「怎么把 `@/api` 那份契约**变成一次真的请求**」：唯一的拨号点、地址与路径的两处变换、失败三档词汇、
收窄组合子。契约本身在 `@/api/index.js`（本目录**依赖**它，反向不成立）。

## 文件

- `client.ts` — **本包唯一的拨号点**（`ManagerClient` / `call`）、空 patch 的本地判据 `assertNonEmptyPatch`，
  以及名单组名与方向两份**唯一**清单（`ACL_GROUPS` / `ACL_LISTS`）。⚠️ 本目录**没有** fetch 注入点。
- `error.ts` — 本包唯一的失败词汇 `TuiError`（三档判别、四个静态构造）、`LOCAL_REQUEST`、`isRetryable`
  与本包自造的三个 `LocalCode`。
- `http.ts` — 拨号之前的两处 `字符串 → URL` 变换：`endpointPath`（`:username` 模板代入并编码）与
  `normalizeBaseUrl`（只保留 origin）。零 IO。
- `decode.ts` — 收窄组合子（`str` / `bool` / `num` / `nullable` / `optional` / `oneOf` / `arr` / `obj` /
  `opaque`）与 `Decode<T>`。零 IO。
- `index.ts` — 目录 barrel，**只转发**。⚠️ `decode.ts` 的九件零件**不在**这里（见下）。
- `AGENTS.md` — 本文件。

## 层不变量

- ⚠️ **唯一拨号点是 `client.ts:ManagerClient.call`，其余文件只做纯变换**（没有一处能触网、读时钟或读环境）。
  理由：契约与判据要能被单测逐字断言，而**替身只可能注入到拨号那一处**。
- ⚠️ **本目录的 barrel 不引 `@/api/index.js`，反过来 `@/api` 也不许引本 barrel** —— 依赖方向只能是
  `utils → api`。`@/api/wire.js` 要收窄组合子，故走**深层路径** `@/utils/decode.js`；走 barrel 会拉起
  `client.ts`（它要 `SHAPES`）而形成 `api/index → api/wire → utils/index → utils/client → api/index`
  的运行期环。这条是结构性的，不是省字的取舍。
- **`decode.ts` 的零件不转发**：收窄器是判据的装配料，全包唯一的调用点是 `@/api/wire.js`。取它的档经深层路径。
- **路径与形状一个都不许重打**：`client.ts` 的每个方法从 `ENDPOINTS` / `SHAPES` 取，写不出一条自己的
  `(method, path)`（除表里那个 `:username` 模板）。重打就是第二份真相源。
- **`call` 先读 text 再判成败**，且 **`DELETE` 也带 body**（改用查询串就得多写一条分支，而那正是「删了 A 实际删了 B」
  最容易长出来的地方）。**每个端点一个方法**，不暴露通用 `request()`。
- ⚠️ **文案绝不转述对面的数据**（响应的 body、带凭据的地址、任何一段 token），**也绝不重打 userinfo** ——
  只说「哪个路径期望什么」与「地址的哪一段不对」。
- ⚠️ **`TuiError` 三档分开的理由是处置动作不同**：服务端答了「不」⇒ 读文案；**根本没答上** ⇒ 查地址与网络；
  答了但形状不对 ⇒ 多半是对面版本新/旧。本地形状不对挂 `wire` 档 + `invalid` 码（`TuiError.local`），
  ⚠️ 代价是 `status` 恒 `null`（**没收到响应就没有状态码，不许拿 `0` 冒充**）且 `request` 恒为 `LOCAL_REQUEST`。
- **`isRetryable` 的判据是 `code` 而不是 `kind`** —— 只有 `timeout` 值得重试（对面在忙）。
- **零 `console`、零 `process.*`、零 React、零文件系统**（台账在 `@/ledger`，终端设施在 `@/terminal`）。

## 相关路径

- `@/api/index.js` — 上游：端点表 / 响应体形状 / `SHAPES` / `readErrorBody` / `WIRE_CODES`。
- `@/ledger/index.js` — 下游：台账 → `ManagerEndpoint`（`connect.ts:clientFor` 是唯一转换点）与探活。
- `@/exec/run.js` — 下游：`@/exec` 是**唯一**拨号的地方；执行层**原样透传**本目录交出的文案。
- 根仓 `src/manager/http/{auth,respond,router}.ts` — 请求头、失败码与路径判据的出处（服务端那一侧）。

## 相关测试

- `packages/tui/tests/client.test.ts` — 对**真 `http.Server`** 的端到端契约 + `normalizeBaseUrl` 真值表。
- `packages/tui/tests/endpoints.test.ts` 的「`:username` 代入」一节 · `tests/decode.test.ts` — 组合子真值表。
- `packages/tui/tests/exec.test.ts` — 失败三档怎么变成一行字（转换点在 `@/exec`，不在这里）。
- ⚠️ **本目录的「零 console / 零 `process.*` / 不引本目录以外的 barrel」目前没有源码级护栏**
  （`tests/ledger.test.ts` 只扫 `src/ledger`）。改本目录时**必须**跑 `pnpm --filter @b-hole/proxy-tui`
  的 `lint` / `typecheck` / `test`。