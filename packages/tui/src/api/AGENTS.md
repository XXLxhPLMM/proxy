# src/api/ — 控制面 HTTP **契约**（本包对线上契约的**全部**声明）

本目录只回答「**对面说了什么**」：有哪些端点、每个端点回什么 JSON、逐字段的判据是什么。它**不拨号、不改写**。
分界判据是**依赖方向**：工具形状的东西（拨号点与地址变换）在 `@/services/index.js`，失败词汇与收窄组合子在
`@/lib/`，而本目录**不引**那些 barrel（唯一例外是 `wire.ts` 为拿组合子而引 `@/lib/decode.js` 的深层路径 ——
走 barrel 就是一条运行期环）。
这是全包**最脆**的一个目录，因为它手抄着别人机器上那个进程的契约 —— 所以这里的每条纪律都在回答同一个问题：
**「对面变了」怎么变成一句看得见的话，而不是一片空白。**（为什么弱耦合见 `packages/tui/AGENTS.md`）

## 文件

- `endpoints/index.ts` — 端点表的**平表装配** + `Method` / `Endpoint` 类型 + `:username` 模板的说明。零判据。
- `endpoints/{status,config,users,acl,usage}.ts` — **按服务端模块分段**的端点字面量，各镜像根仓
  `src/manager/routes/` 下的同名文件。零判据。
- `types.ts` — **手写的响应体接口** + 写面入参 + 失败码闭合集 `WireCode`。**零判据**。
- `wire.ts` — 把上面两张表接起来的**逐字段判据**（`SHAPES`）、编译期断言 `WireContractAssertions`、`WIRE_CODES`
  与错误体的**宽松**读法 `readErrorBody`。
- `index.ts` — 目录 barrel，**只转发**。
- `AGENTS.md` — 本文件。

## 层不变量

- ⚠️ **端点表是手抄的弱耦合**：控制面加端点时 `endpoints/` 与 `wire.ts` 都要动，⚠️ **不许**用「import 服务端的表」
  消掉这份重复（网络两端版本可以不同，那份重复是现实）。⚠️ **两道牙各管一半**：路径集合归根仓
  `tests/unit/manager-tui-contract.test.ts`（**现列**两侧目录、从**源码文本**取 `(method, path)` 再比集合），
  字段形状归 `wire.ts` 的编译期断言（**单向**就够，反向那条恒红）。
- **平表只有一份**：消费面只认 `@/api/index.js:ENDPOINTS`（它由五个模块常量装配而来，顺序与服务端
  `managerRoutes()` 一致）。⚠️ 不许在别处另起一张表，也不许让某个模块常量绕过平表单独流通。
- **`WireContractAssertions` 必须是导出的并集**，不是局部 `type` 别名 —— 类型别名在运行时不存在，局部那个会被
  eslint 判死，而「判据被 lint 判死」与「判据不存在」效果一样（静默消失）。
- **`WireCode` 是服务端的闭合集，本目录不许扩充**；本包自造的三个 code 在 `@/lib/errors.js:LocalCode`。
- **打码是服务端的决定，本目录不重打码、也不许再判一次「哪些键是秘密」**（那是服务端 `CONFIG_SECRET_KEYS`
  一份清单的读法，读一份拷贝就是清单漂移的起点，漂了的后果是一处打码一处明文）。
- **传输面不改写服务端的文案**：`message` / `notice` / `effective` / `sideEffect` / `note` 原样透传。⚠️
  `changed: false` 是**一次成功的 no-op**，不是失败。
- **`nullable` 与 `optional` 严格分工**：JSON 里「键不存在」不是 `null`，故 `fileOrigin` / `quota` / `expiresAt`
  一律 `optional(...)`；用错会把「没配配额」判成「配了个坏配额」。收窄范围 = UI 会读的**全部**字段，唯一刻意的
  透传是 `configKey.value`（`opaque`）；`obj` **放行未知键**。
- **零 `console`、零 `process.*`、零 React、零文件系统、零 IO**：本目录没有一处能触网、读时钟或读环境。

## 相关路径

- `@/services/index.js` — 下游：唯一拨号点 `ManagerClient`；`@/lib/errors.js` — 失败三档的词汇。
- `@/services/config/index.js` — 上游：台账 → `ManagerEndpoint`（`connect.ts:clientFor` 是唯一转换点）与探活。
- 根仓 `src/manager/routes/*.ts` — 端点集合的另一侧真值；`src/manager/http/{auth,respond,router}.ts` 是请求头、
  失败码与路径判据的出处；`src/ops/{error,report}.ts` 是 `WireCode` 前五档与 `DataRef` / `StatusData` 的镜像来源。

## 相关测试

- `packages/tui/tests/endpoints.test.ts` — 端点表自洽性 + `:username` 代入。
- `packages/tui/tests/wire.test.ts` — 逐字段判据（喂**从服务端源码抄来的等价样本**）与错误体宽松读法。
- 根仓 `tests/unit/manager-tui-contract.test.ts` — 路径集合那道牙（**现列** `endpoints/`，不是手写清单）。
- ⚠️ **本目录的「零 console / 零 `process.*` / 不引本目录以外的 barrel」目前没有源码级护栏**
  （`tests/ledger.test.ts` 只扫 `src/services/config`）。改本目录时**必须**跑 `pnpm --filter @b-hole/proxy-tui`
  的 `lint` / `typecheck` / `test`。