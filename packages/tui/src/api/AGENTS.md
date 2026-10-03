# src/client/ — 控制面 HTTP 客户端（本包对线上契约的**全部**声明）

本目录是本包与控制面之间**唯一**的网络边界：端点表、手写响应形状、逐字段判据、失败三档、请求实现
都在这里。对外唯一出口 `@/api/index.js`（跨目录只引这一个 barrel）。

它是全包**最脆**的一个目录，因为它手抄着别人机器上那个进程的契约 —— 那边随时可能跑着别的版本。
所以这里的每条纪律都在回答同一个问题：**「对面变了」这件事要怎么变成一句看得见的话，而不是一片空白。**

包级那节「端点契约是手抄的、有测试兜着的弱耦合」写的是**为什么**弱耦合，本文件只写**在本目录里
怎么落地**（推导见 `packages/tui/AGENTS.md`，各文件的完整机制见源码文件头）。

## 文件

- `endpoints.ts` — **端点表**（12 条 `(method, path)`，`ENDPOINTS`）与 `:username` 模板代入
  （`endpointPath`）。零判据：它只声明「有哪条路」，不判「回什么」。
- `types.ts` — **手写的响应体接口**（`StatusBody` / `ConfigBody` / `AccountBody` / `ChangeBody` /
  `AclBody` / `UsageBody` / 写面入参）与失败码闭合集 `WireCode`。**零判据**：它只声明形状。
- `decode.ts` — 收窄组合子（`str` / `bool` / `num` / `nullable` / `optional` / `oneOf` / `arr` /
  `strArr` / `obj` / `opaque`）与 `Decode<T>`。零 IO，能被单测逐字断言真值表。
- `wire.ts` — 把上面两张表接起来的**逐字段判据**（`SHAPES` 单例）、编译期契约断言
  （`WireContractAssertions`）、失败码运行时形态 `WIRE_CODES` 与错误体的**宽松**读法
  （`readErrorBody`）。
- `error.ts` — 本包唯一的失败词汇 `TuiError`（三档判别、四个静态构造）、`LOCAL_REQUEST` 占位与
  `isRetryable`。
- `client.ts` — **本包唯一的拨号点**（`ManagerClient`）、请求拼装与响应分流（`call`）、用户输入的
  基址归一（`normalizeBaseUrl`）、空 patch 的本地判据（`assertNonEmptyPatch`），以及名单组名与方向
  两份**唯一**清单（`ACL_GROUPS` / `ACL_LISTS`）。
- `index.ts` — 目录 barrel，**只转发**（本文件不含任何逻辑）。
- `AGENTS.md` — 本文件。

机制与决策的完整推导在各文件头（`@fileoverview` / `@description`），这里只列**不变量**。

## 层不变量

- **唯一拨号点是 `client.ts:ManagerClient.call`，其余文件只做纯变换**。`endpoints` / `types` /
  `decode` / `wire` / `error` 里没有一处能触网、也没有一处能读时钟或环境。理由：契约与判据要能被
  单测逐字断言，而**替身只可能注入到拨号那一处**（本目录没有 fetch 注入点，见 `client.ts:FetchLike`
  的说明）—— 上面五份文件能整份喂进 vitest 而不碰网络，靠的就是它们碰不到网络。
- **端点表是手抄的弱耦合，不是编译期绑定**（为什么见 `packages/tui/AGENTS.md`）。落到本目录上是两条
  纪律：**控制面加端点时 `endpoints.ts` 与 `wire.ts` 都要动**（只动前者 = 本包少一个功能而两边都绿；
  只动后者 = 一个没有解码器的端点，类型上也拼不出来），而**不许**用「import 一下服务端的表」来消掉
  这份重复 —— 那是把「网络两端版本可以不同」这个现实从代码里删掉。
  ⚠️ **两道牙各管一半、谁也不许扩权**：路径集合归根仓 `tests/unit/manager-tui-contract.test.ts`
  （从两侧**源码文本**现取再比集合，不从任何一侧 import），字段形状归 `wire.ts` 的
  `WireContractAssertions`（编译期单向可赋值性）。路径那一道牙**看不见**字段形状，本目录这一道牙
  **看不见**「路径对应哪个字段」，少任一条都有一类漂移两边全绿。
- **`WireContractAssertions` 必须是导出的并集，不是局部 `type` 别名**：类型别名在运行时不存在，局部
  那个会被 eslint 的 `no-unused-vars` 判死，而「判据被 lint 判死」与「判据不存在」在效果上一样 ——
  它会**静默消失**。导出即引用，故这条必须有人用上它（`index.ts` 转发了整个模块）。
  ⚠️ 判据**单向**（`DecodeResult extends Interface`）就够，且**必须**单向：接口为了可赋值性刻意把数组
  写成 `readonly`，而解码器产出的是可变数组，反向那条会恒红 —— 而恒红的断言就是没有断言。
- **`TuiError` 三档（`wire` / `transport` / `shape`）分开的理由是处置动作不同**，不是分类癖：
  服务端答了「不」⇒ 读文案（`unauthorized` 就去查 token）；**根本没答上** ⇒ 查地址与网络；答了但不像
  本包声明的形状 ⇒ 多半是对面版本新/旧、**不是**操作者的错。把「服务没起来」显示成「token 不对」会把人
  带去改一份完全正确的凭据，把「对面版本对不上」显示成「内部错误」会让人去翻服务端日志里一行根本不存在
  的东西。
- **本地形状不对挂 `wire` 档 + `invalid` 码**（`TuiError.local`），**不塞 `transport`、不新开一档**：
  `transport` 的定义是「根本没答上」，而这里根本**没问**（塞进去会让界面提示「检查网络与地址」，而操作者
  敲错的是地址文本本身）；服务端对同样的坏输入回的**就是** `invalid`，同一种失败在两端同一个 code，界面
  只认一个。⚠️ 代价是 `status` 恒为 `null` —— **没收到响应就没有状态码，不许拿 `0` 冒充**（那是拿一个
  假状态码说「服务端回了个 0」）。
- **`LOCAL_REQUEST` 那个占位是契约**：它是「这一次没有真的发出去」的标记，界面上**必须**能把「地址敲
  错了，请求没出门」与「出了门被 401」显示成两件事 —— 后者一定有 `status` 与一条真实路径，两者混成一句
  「出错了」就等于让人对着一个从没发生过的请求去排查。
- **`isRetryable` 判 `code` 而不是 `kind`**：只有 `timeout` 值得重试（对面在忙，与本机输入无关）。
  只看 `kind` 会把 `unreachable`（地址敲错 / 网络断了 / 服务没起）也算成可重试，于是界面对着一个明显
  敲错的地址提示「重试」—— 那是在教操作者反复按一个不可能成功的按钮。
- **表外的 `code` 一律降级成 `internal`，但 `requestId` 保留**：本包并不认识那个 code 的语义，而
  `message` 是服务端为**它的**语义写的一句中性事实陈述，原样显示等于宣称「我知道这是什么」。降级时
  `requestId` 是唯一还能接上服务端日志的线索，丢掉它 5xx 就成了死路。⚠️ 这是**错误体走宽松读法**的
  全部理由：错误体**刻意不走**上面那套严格解码器 —— 严格解码器会把一句服务端认真写清楚的
  `quotaBytes 只能是非负整数…` 换成本包四个字「形状不对」，操作者拿到的信息严格变少。
  ⚠️ 另一半纪律：`WIRE_CODES` 是**手抄的一份**，**只抄不加**（服务端加档必须同步改它）；抄来的每一个
  字面量都要在服务端找得到，而它也是**唯一**那份 `Set`，别处不许另起一份。
- **`nullable` 与 `optional` 严格分工，不许互换**：`JSON.stringify({a: undefined})` 产出 `{}`，故服务端
  「没这个字段」在线上是**键不存在**而不是 `null`。用 `nullable` 去收 `fileOrigin` / `quota` /
  `expiresAt` 会把「服务端没配配额」判成「配了个坏配额」，而那种错一路流到界面才炸。
- **收窄范围 = 界面会读的**全部**字段，一条不落**：只收「界面上要分支的」、其余当 `unknown` 透传是
  **弱化判据**的一种 —— 漏掉的那个字段会在某个不相关的页面变成 `undefined`。故 `types.ts` 里每个字段
  都有对应组合子；**唯一**刻意的透传是 `configKey.value`（`opaque`）：它的类型由服务端的配置 schema
  决定，本包替它猜就是造出第二份字段类型表。
  ⚠️ `obj` **放行未知键**（不判别）：「本包声明的键都在」是本包的责任，「服务端不许加字段」会让对面每加
  一个字段就把老版本客户端打挂。
- **形状不对时，一个字节的值都不许转述**：`TuiError.shape` 的 `message` 只说「哪个路径期望什么」。
  那串字节来自一个本包不认识版本的进程，它既可能是凭据也可能是名单，打印到终端等于把对面的数据抄进
  本机的滚动缓冲。同理 `normalizeBaseUrl` 拒绝带 userinfo 的地址时，**错误文案里不重打**那一段。
- **传输面不改写服务端的文案**：`ChangeBody.message` / `notice` / `effective` / `TuiError.message` /
  `ErrorBodyRead.message` 原样透传。改写等于把「服务端认真答了的一句话」换成本包自己发明的说法，而
  措辞是**服务端那边**的知识。
- **`changed: false` 是**一次成功的 no-op**，不是失败**：名单写是幂等的（加一条它已经有了的 / 移一条它
  本来就没有的，服务端回 200 + `changed: false`，一个字节都没动）。抛了会让界面说「操作失败」而用户
  已经达到目的；谎报「已改」同样错。故它**不许**被抛成 `TuiError`，界面也不许显示「已改」。
- **`notice` / `effective` / `lagMs` / `sideEffect` / `note` 是强制限定，不是可选信息**：
  - `notice`（账号写特有，`AUTH_TYPE=jwt` 下 `expiresAt` / disabled 不生效）丢掉它，「以为把这个账号
    封住了」会一直活到下一次重启；
  - `effective`（名单写特有，`changed: false` 时服务端给 `null`）**不承诺一件没发生的事**，反过来一个
    字节都没落盘却承诺生效，是本仓最恨的形状；
  - `lagMs` / `sideEffect` / `note`（用量三段）少一段就把「账本此刻记着多少」显示成「这个账号现在还能用
    多少」/ 让一次会物化账本文件的读取被当成纯读 / 让「本工具不能清账」这件事消失。
    ⚠️ 方向由服务端给，本包**只透传不重算**（`restartRequired` 由 `phase` 在对面派生、`sideEffect` 由数据
    源的物化纪律给出）。
- **打码是服务端的决定，本目录不重打码、也不造第二份「哪些键是秘密」的清单**：`GET /api/config` 的密钥
  值一律是 `***`（空串保持空串）、账号的密码一律是 `{set: boolean}`，本包**一个字明文都拿不到**。
  ⚠️ 本目录**不许**再判一次「哪些键是秘密」：那是服务端 `CONFIG_SECRET_KEYS` 一份清单的读者，读一份拷贝
  就是清单漂移的起点，而漂了的后果是一处打码一处明文。本包只负责把服务端给的 `secret` 标志如实呈现。
- **`endpointPath` 代入必须 `encodeURIComponent`，且「判有没有这个段」与「替换」必须用同一条整段判据**：
  控制面在 decode **之后**才判字符白名单，不编码就是给路径穿越留一条路；而用 `includes(":username")` 判、
  逐段替换，会让 `:usernames` 这种含子串的段名通过校验却原样返回 —— 那是一条「判据说有、实际没换」的
  路径，调用方拿到一个带占位符的 URL。⚠️ 本端**不**再发明一份字符白名单（`encodeURIComponent` 不转义
  `.`，真正的闸门在服务端；两侧各一份就是两侧会漂）。
- **`call` 先读 text 再判成败**，且 **`DELETE` 也带 body**：错误体也是 JSON，按状态码分流会逼出两条
  解析路径；而服务端 `routes/input.ts` 的 `aclMutationInput` 明确收请求体，很多 HTTP 客户端会在 `DELETE`
  上丢 body —— 改用查询串就得多写一条分支，而那正是「删了 A 实际删了 B」那条事故最容易长出来的地方。
- **每个端点一个方法，不暴露通用 `request(method, path)`**：通用入口会让「路径拼错」「用错了解码器」
  「给 GET 发了 body」三类错误全部推迟到运行期，且没有任何东西会红。逐端点的方法让「用错解码器」变成
  一次类型不匹配（`call` 的 `shape` 形参是必填的）。
- **`normalizeBaseUrl` 只保留 origin，五条拒绝各挡一种具体的坏法**：⚠️ 「协议头后面多打一个斜杠」
  （`http:///api`）**必须在 `new URL` 之前按原始文本判** —— WHATWG 解析会把三个斜杠消解成「一个斜杠 +
  主机分隔符」，`http:///api` 于是**合法地**解析成主机 `api`，判 `url.hostname === ""` 那一支永远走不到，
  而用户看到的是「静默去连一台叫 `api` 的机器」。⚠️ 尾斜杠 / 尾路径必须拒（`http://h:3010/` +
  `/api/status` 拼出 `//api/status`，服务端逐段比对路径 ⇒ 一句毫无线索的 404）。
- **判据能被单测逐条咬住，因为它是数据**：判据全部导出（`ENDPOINTS` / `WIRE_CODES` / `SHAPES` /
  `ACL_GROUPS` / `ACL_LISTS`），故「端点表少一条」「失败码集合漂了」「形状漏字段」都能写成断言而不是
  靠人记得看。反过来，`SHAPES` 是**单例**：这些解码器无状态，每次调用现造只是白花 CPU。
- **零 `console`、零 `process.*`、零 React、零文件系统**：本目录**不 import 本目录以外的任何东西**
  （import 面只有六个 `./xxx.js`；台账的读写在 `@/ledger`，终端呈现全在 `@/ui`）。一个传输面自己决定
  「写哪条通道 / 上不上色 / 屏幕多宽」，就是把这些宿主事实的采集面从组合根拆成 N 处；挂上 React 就
  不再是纯函数，而 Ink 组件在测试里渲染要起 stdin/stdout。

## 未做（是「不变量」，不是「没来得及」）

- **本目录没有源码级「层边界」护栏**。`tests/ledger.test.ts` 有一节逐字扫源码（零 console / 零
  `process.*` / 内部不自我引用 barrel / barrel 只 export，全部带判据自检），**本目录没有对应的一档**
  —— 上面那条「零 console / 不 import 本目录以外」目前只有人的纪律，没有牙齿。真要加，锚点必须钉在
  今天仍存在的形状上（入口调用 / 构造调用 / 值导入），不许锚一个已删的符号名。
- **没有 fetch 注入点**（`call` 直接取全局那个）。故测试只有两条路：起真 `http.Server`
  （`tests/client.test.ts` 选的是这条，因为 `Authorization` 头的实际形态、状态码、请求行上的百分号
  编码这三样只在真 socket 上存在）或替掉全局。代价是本目录的单测档比台账那一档重。
- **没有重试、没有退避、没有请求数上限**。`isRetryable` 只回答「值不值得重试」，按几次、隔多久是**界面**
  的决定（`@/exec/run.js:controlFailure` 把「可重试」显示成一句提示，让操作者自己决定要不要
  敲 `r`）。把重试放进本目录就等于让一个传输面自己决定「这件事要不要再来一遍」。
- **没有缓存**：每次调用都发一次请求，故「数据什么时候重拉」是调用方的判据（`@/app.tsx` 决定什么时候
  敲哪条命令）。在本目录加缓存等于让「屏上这份数据是什么时候的」这件事在一个没人看得见的地方被决定。
- **成功响应没有「尽力而为」的宽松读法**：整个 body 不像 JSON 就抛 `shape`（空响应体同样抛 —— 空不是
  「合法的空配置」）。**唯一**的宽松路径是错误体（`readErrorBody`），理由与代价在上面那条。
- **端点表里没有查询串与分页**，`GET /api/usage` 一次给全量，故本目录**没有**分页形态，也没有
  「这一屏没拿全」的第三种形态。哪天对面加了分页参数，本目录要**整条**改而不是在解码器里悄悄截断。

## 相关路径

- `@/api/index.js` — 本目录**唯一**的出口（`console` / `ledger` / `ui` 三个目录消费的**全部**数据
  形状与失败类型都从这里来，跨目录不许引深层路径）。
- `@/ledger/index.js` — 上游：台账 → `ManagerEndpoint`（`connect.ts:clientFor` 是唯一的转换点；`Target`
  `extends ManagerEndpoint`）与探活（`probeTarget` 不 re-throw，把三档原样交给界面）。
- `@/view/index.js` — 下游：`@/exec/run.js` 是**唯一**拨号的地方（一条命令 → 若干行 + 一组
  副作用）。⚠️ 执行层**原样透传**本目录交出的 `message` / `notice` / `effective` / `sideEffect` /
  `note`，一个字都不改写；而 `@/ui/theme.ts` 的 `severityColor` 把 `TuiCode` 映射到色档，
  `maskToken` 是屏幕侧唯一的打码出口（本目录给的是真值与 `secret` 标志，打码由那一侧做）。
- `packages/tui/AGENTS.md` — 包级说明与「端点契约为什么是弱耦合」那一节（**本文件不复述它**）。
- 根仓 `src/manager/routes/*.ts`— 端点集合的另一侧真值（表头在 `routes/index.ts`）；本目录的
  形状逐条对着它们的 `reply()` 调用抄。
- 根仓 `src/manager/http/respond.ts`— `ErrorBody` 与传输层自造那四档失败码的出处，也是
  `WIRE_CODES` 后四档的镜像来源。
- 根仓 `src/ops/error.ts`— `OpsErrorCode` 五档，`WireCode` 前五档的镜像来源。
- 根仓 `src/manager/http/auth.ts`— `Authorization: Bearer <token>` 的判据（本目录的请求头逐字照它
  拼）；空 token 恒 401、`$` 锚定（故本目录的凭据只判「非空」）。
- 根仓 `src/manager/http/router.ts`— 404 与 405 分开、路径 decode 之后才判形状：本目录
  `endpointPath` 必须编码、`Method` 闭合集两处的理由。
- 根仓 `tests/unit/manager-tui-contract.test.ts` — 路径集合那道牙（从两侧源码文本现取，不 import）。
- 根仓 `tests/unit/runtime-floor.test.ts` — 扫全工作树（含本目录）：文件头里**不许**出现任何
  `Node >= X.Y` 形态的字面量（本目录一个版本号都没写）。

## 相关测试

- `packages/tui/tests/endpoints.test.ts` — 端点表本侧的自洽性（条数、`(method, path)` 无重复、形态
  合法）+ `:username` 代入（编码、分隔符不越权、模板缺段即抛）。⚠️ 路径集合与**对面**相等不在这一档，
  归根仓那个契约档 —— 且那两条断言刻意用「无重复」与「条数是 12」互相独立地锁，删掉一条另一条仍在。
- `packages/tui/tests/decode.test.ts` — 组合子真值表：类型不符一律抛 `shape`（kind 必落 `shape` 档）、
  `nullable` / `optional` 严格分工、文案里**一个字节的值都不带**（且与「文案确实说了点别的」成对断言 ——
  单独一条 `not.toContain` 在空文案时也会绿）。
- `packages/tui/tests/wire.test.ts` — 每个端点喂一份**从服务端源码抄来的等价样本**（注释点名抄自哪个
  `reply()`），逐个删字段必须抛 `shape` 且 message 点名那条路径；`usage` 与 `usageOne` 是两个形状；
  `WIRE_CODES` **编译期与运行期双向锁** `WireCode` 联合（只锁运行期的话，联合里加一个字面量而 Set 没
  跟上，`tsc` 一声不响）；错误体的宽松读法（认得出原样透传、认不出降级而 `requestId` 保留）。
- `packages/tui/tests/client.test.ts` — 对着**真 `http.Server`** 的端到端契约（不用 mock `fetch`：
  `Authorization` 的实际形态、真实状态码、请求行上的百分号编码三样只在真 socket 上存在）。覆盖
  `Bearer` 逐字形态（负向样本全被拒）、三档失败各自的四个字段、文案原样透传、表外 code 的降级、
  `transport` 档 `status` 恒 `null`、超时与连不上分开、`DELETE` 也带 body、`changed: false` 正常
  resolve、空 patch 在**本地**先判且一个请求都没发出去、`:username` 真的进了路径，以及
  `normalizeBaseUrl` 整组（去尾斜杠 / 只保留 origin / 吃首尾空白 / 五条拒绝，含 `http:///x` 不静默
  去连一台叫 `x` 的机器）。
- `packages/tui/tests/ledger.test.ts` 的「台账 → 客户端」一节 — 本目录被上游怎么接线（`clientFor` 与
  `probeTarget` 的四档），归台账那一档。
- 根仓 `tests/unit/manager-tui-contract.test.ts` — 端点表互锁那一半（见「层不变量」第二条）。
- ⚠️ **本目录的「零 console / 零 `process.*` / 不 import 本目录以外」目前没有源码级护栏**
  （见「未做」第一条）。改本目录时**必须**跑 `pnpm --filter @b-hole/proxy-tui lint` / `typecheck` /
  `test`，而 `tsc` 看不见「忘了原样透传 `notice`」或「多加了一份「哪些键是秘密」」这类退化 —— 它们
  只在**对端源码**变过时才会以「界面少显示一句」或「一处打码一处明文」的形态出现。
