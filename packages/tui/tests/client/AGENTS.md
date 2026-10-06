# tests/client/ — `@/api`（端点函数 + 那一条 axios）对**真 `http.Server`** 的端到端契约单测

契约里有三样东西**只在真 socket 上才存在**，本目录整个存在的理由就是它们：

1. **`Authorization` 头的实际形态**。mock 掉 `fetch` 时「服务端收到的头」是测试自己编的对象，于是
   「`Bearer` + 一个空格」写成 `bearer` 或漏掉空格也照样绿 —— 而服务端 `http/auth.ts` 的判据恰好卡在这里。
2. **状态码真的那样**（401 / 404 / 500 分开），以及**响应体真的能被解码**。
3. **请求行上的百分号编码**：`%2F` 在 `req.url` 里仍然是 `%2F`，而 `#` 会被片段截断、`..` 会被 URL 解析器
   消解 —— 这三样都是 mock 层看不见的。

替身是**本目录自己写的最小控制面**（`http.createServer` + 按 `Authorization` 与路径回 canned JSON），在
`_double.ts` 里。

⚠️ **刻意不 import `@b-hole/proxy`**：TUI 包连的是**别的机器上那个进程**，而那个进程可能跑的是旧版本；
跨包 import 共享契约会把「网络两端版本可以不同」这件事抹掉。契约互锁由根仓那个从两侧源码现取
`(method, path)` 再比集合的护栏（`tests/unit/manager-tui-contract.test.ts`）负责。

## 替身的性质（各档共用的那几条判据）

- ⚠️ **鉴权先于路由**（与 `http/server.ts` 同一顺序）：未鉴权的调用者拿不到 404/405 的区分。
- ⚠️ **未登记的路径回 404 而不是静默 200** —— 路径拼错时断言会红在「拿不到 body」上，而不是在某个恰好也
  通过的地方蒙混过去。（`expectAuthorization(null)` 关掉鉴权判据；`setUnauthorizedRequestId` 供鉴权档断言。）
- ⚠️ **默认要求 `Authorization` 逐字等于 `Bearer <token>`**，不匹配即回 401（复刻
  `respond.ts:sendUnauthorized` 的响应体）—— 于是「客户端确实把凭据送到了」可以是**前提**而不是另写的断言。
- **按 JSON 回时复刻服务端 `respond.ts:writeJson` 的三个头**（`Content-Type` / `Content-Length` /
  `Cache-Control`），并支持 `raw`（非 JSON 原文）、`delayMs`（超时）与 `destroy`（连接中断）三种注入。
- **`seen` 数组断言的是长度与内容**（方法 / 路径 / 请求行 / 头 / 体），不是「至少有一个请求」——
  最后一个请求的断言必须在 `seen.length` 已知的前提下才有意义；要锚在「本次那一条」就用 `seen[before]`。

## 替身生命周期归谁（⚠️ 漏了会让整个 vitest 进程挂着不退）

- **起服务器的动作全在 `startDouble()` 函数体内**：`_double.ts` 有**零模块期副作用**，故 import 它不会开端口。
  ⚠️ 把 `startDouble()` 提到模块作用域，则**每个 import 它的档都在 import 时开一个端口** —— 端口泄漏，
  且一个不用替身的档也被迫挂一个 listener。
- **hooks 是逐文件注册的，没有「装一次全局生效」这回事**：每个**起替身**的档必须自带那对
  `beforeEach` / `afterEach`（`let double` + 每个用例自己起、自己关，不与别的用例共享端口或 token）。
  抄走 `beforeEach` 却忘了抄 `afterEach` 的那一档，症状是**进程不退**，不是「测试失败」。
- **端口用 `listen(0)`**（内核分配空闲端口）⇒ 并行跑也不会撞端口。
- ⚠️ **`close()` 必须允许对同一个实例调第二次**：「服务已关」那一档会在用例体内先 `close()` 一次，而
  `afterEach` 还会再调一次。`server.close()` 传回一个错**也会**回调，故那条 Promise 照样落地 —— 改
  `close()` 的实现时这条要一起验。
- **样本载荷（`STATUS_BODY` / `CHANGE_BODY` / `NOT_FOUND_BODY`）只被序列化、不被改写**（走 `JSON.stringify`），
  故可由多个档共用同一份。

## 各档分工

| 档 | 盯什么 | 替身 |
| --- | --- | --- |
| `success-paths.test.ts` | 五个读面 + 单条读面 + 写面的**成功解码**；请求参数就是那三格 + ⚠️ 「axios 的调用点集合恒等于**空集**」 | 起 |
| `env-proxy.test.ts` | ⚠️ `HTTP_PROXY` 配了**真的用** / `NO_PROXY` 能绕过 / 代理地址的 userinfo 不进错误文案 | 起（真代理 + 真环境变量） |
| `credentials.test.ts` | `Authorization` 的**形态** + 判错之后 `wire` 档该带的四个字段 | 起 |
| `failure-tiers.test.ts` | 失败怎么分三档（`wire` / `transport` / `shape`），每档 `status` 取什么 | 起 |
| `request-shaping.test.ts` | 请求体 / 方法 / `Content-Type` / 幂等 no-op + `:username` 的请求行编码 | 起 |
| `normalize-base-url.test.ts` | 地址文本在**出门之前**被收窄（零 IO、零替身） | 不起 |

## 变异实测（根 `AGENTS.md`「写护栏时」硬要求：任何负向断言都要验「被防住的行为回来时会红」）

1. **凭据判据**：把替身的 `Authorization` 判据设成不可能对上的值后，`status()` 立刻变 401 且
   `credentials.test.ts` 的用例转红 —— 证明成功路径**真的**是靠凭据送达才绿的，不是「反正有个 200」。
2. **`:username` 编码**：把用户名换成未编码的形态（替身回 404 兜底）时，`%2F` 那条会红在「拿不到 body」上 ——
   证明 `%2F` 断言锚的是线上请求行而不是自己编的字符串。
3. **`DELETE` 带 body**：断言的是 `seen[0].body` 的**长度与三键**，`body` 一空就红 —— 而「只断言方法与路径」
   的话，改成查询串那条通路一样绿。
4. **`changed: false`**：断言 `resolve` 出来的那份 body（含 `message` 与 `effective`），而不是断言「没抛」——
   抛了会红、改成 reject 一档也会红。
5. **`status` 恒为 `null`**：`failure-tiers.test.ts` 三档 `transport` 用例都断言 `toBeNull()`；写成 `toBe(0)`
   会红，因为实现给的就是 `null`（这条护栏挡的是 `?? 0` 那种「拿 0 冒充状态码」的改法）。

## 相关

_double.ts`（替身 + 共用样本与判据）· `@/api/`（被测面：`send.ts` 那一次 `axios.request` + 那十二个端点函数）· 根仓
`src/manager/http/*`（请求头与失败码的出处）· 根仓 `tests/unit/manager/tui-contract.test.ts`（**本包这一侧**的 `(method, path)`
的形状）· 根仓 `tests/unit/manager-tui-contract.test.ts`（两侧 `(method, path)` 集合互锁）