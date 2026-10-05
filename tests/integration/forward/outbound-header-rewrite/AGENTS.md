# tests/integration/forward/outbound-header-rewrite/ — 出站报文改写钩子（`OutboundHeaderRewriter`）

这个端口解决的是「出站净化一路**只能剥、不能改**」：加头 / 换 UA / 注入 trace id / 改 Host
这些最高频的自定义需求在它之前没有任何扩展位。本目录钉它带来的全部**可观测后果**——不是
「钩子被调用了」（那只是装配活），而是「上游真的收到了那个字节」与「客户端的字节真的没变」。

## 文件（⚠️ 不变量编号 ↔ 位置对照）

| 档 | 钉哪几条 |
|---|---|
| `absent-and-mutate.test.ts` | **① ② ③** —— 缺席 = 逐字节不变 / 加头（http + upgrade 两条通道）/ 改值与删头 |
| `ordering-and-throw.test.ts` | **④ ⑤** —— 次序（先剥 → 再改写 → 最后强制 `Connection: close`）/ 抛错不改写且请求照常成功 |
| `context-dimensions.test.ts` | **⑥** —— 七个维度逐字段 + 同连接共享 `connectionId` / 逐请求独立 `requestId` + `toProxy` |
| `library-injection.test.ts` | **⑦** 库调用方的注入路径（`services.outboundHeaders` → `runtime.options` → `ProxyOptions` → `CoreServices`）与 **⑧** `applyOutboundRewrite` 的职责边界（**源码级**：这半条在行为面上原理不可观测） |
| `fixture.ts` | 四档共用的装配面（裸 TCP 源站桩 / 裸 socket 客户端 / 钩子记录器 / 注入选项 / 配置基线）。⚠️ **刻意不住 `tests/helpers/`**，理由在该文件头 |

⚠️ 编号写在 `describe` 的标题里且不许重排。**逐条的「锁什么 + 为什么」留在各自档的文件头**，
本文件只放四档共用的那几段。

## 本目录锁的六条契约（判据形状 → 怎么测出来的）

| # | 契约 | 判据形状 |
|---|---|---|
| ① | **缺席 = 逐字节不变** | 两份出站报文**全等**（不是"关键头相等"） |
| ② | **加头生效**（http + upgrade 两条通道） | 源站桩收到的**头字典**里有那个键 |
| ③ | **改值 / 删头生效** | 改后的值 + 键的缺席，**外加一个未被触碰的正控头** |
| ④ | **次序：先剥 → 再改写 → 最后强制 `Connection: close`** | 钩子**入参**里没有 `proxy-*` 与本代理凭证；钩子对 `connection` 的改动在**出站报文**里被覆盖 |
| ⑤ | **抛错 = 不改写且请求照常成功** | 出站报文与 ① 的基线**全等**，且状态码是 200（不是 5xx） |
| ⑥ | **上下文传到位** | `channel`/`toProxy`/`target`/`user`/`client`/`requestId`/`connectionId` 逐字段，外加「同连接共享 connectionId、逐请求独立 requestId」与「`toProxy` 在经 http 上游那一档为 true」 |

## 为什么全部用**行为断言**（源站桩看真字节），一条源码断言都不写在这六条上

这六条的形态都是「**出站那几个字节长什么样**」，而字节不是源码属性：`headers[connection] =
"close"` 挪到 `sanitizeHeaders` 里、改成 `setHeader`、或者在 `http.request` 之前插一段序列化，
源码断言可能照样绿，但线上行为已经变了。故判据一律落在**上游真的收到了什么**上，源站一律用
**裸 `net.Server`**（`http.Server` 会把畸形 request-target 也塞进 `req.url`，把缺陷藏住），
客户端一律用裸 socket 手写报文行，断言的是**逐字节原文**（同一层判据见 `forward/contract/`）。
⚠️ **唯一的例外是 ⑧**，而它例外得有理由（见 `library-injection.test.ts` 的文件头）。

## 变异测试：哪几种改动会让本目录红（逐条已实测）

下面每条都**实测过**（改 → 跑 → 改回），不写「理论上会红」：

- 注释掉 `http.ts` 里改写之后那行 `headers[HEADER_NAME_CONNECTION] = HEADER_VALUE_CLOSE;`
  → **恰好一条红**：次序②「钩子把 connection 改成 keep-alive 或整个删掉」（出站真的变成
  `keep-alive`）。其余 13 条全绿——**这正是本目录要的形状**：那条契约只有它一处后果。
- 注释掉 `http.ts` 里 `applyOutboundRewrite(...)` 的整个调用（退回改动前的形状）
  → ②③④⑤⑥ 会成片红（钩子一次都不被调，上游拿不到新头、`user` 维度无处可取）。
- 钩子抛错那条若改成「把异常往外抛」→ ⑤ 红（请求变成 5xx / 连接被拆）。
- 把 `headers.ts` 里 `applyOutboundRewrite` 的 `if (rewriter === undefined) return headers;`
  短路去掉 → **13 条全绿，只有 ⑧ 的「缺席短路必须在」那条红**。原因是**原理上**如此：
  `rewriter(headers, context)` 在 `rewriter === undefined` 时抛 `TypeError`，而那个 throw 就发生在
  **同一个 `try` 里**、被**同一个 `catch`** 接住、返回**同一个引用**——删掉短路后的字节与不删
  **逐字节全等**。差别全在热路径上（每请求每出站白付一次异常构造 + 栈捕获）。这条短路因此
  **行为面上不可观测**，只能由 ⑧ 那条源码级护栏钉住（它已变异测试验证）。

## 一处**如实记账的覆盖缺口**（已实测，不是猜测）

`upgrade.ts:buildUpgradeReq` 里那个「钩子缺席就早返回 `headerLines` 拼串」的分支，本目录**测不到**：
删掉它 → **14 条全绿**。原因是本目录的 upgrade 用例（② 的后半）**总是注入钩子**，于是那条早返回
在测试里**恒不生效**；而「钩子缺席 + upgrade 通道」这一组合本目录确实没有用例（① 的缺席基线只在
http 通道上跑，upgrade 通道的缺席路径会**保留客户端原始头名大小写与重复头**，那是与 http 通道
**不同的字节形态**，本目录刻意没去锁它）。**这是覆盖缺口，不是不存在**：真要有人把那条早返回删掉、
恒走「小写字典 → 序列化」那条路，upgrade 通道的出站报文形态会静默变样（头名全变小写、重复头被
合并）而本目录全绿。补法是加一条「upgrade 通道 + 钩子缺席 → 报文里保留客户端的原始头名大小写」
的用例；本目录不写它是因为**没有行为后果的判据可写**（现有断言形态要么与它无关、要么恒真），
写一条恒绿的断言正是本仓明令禁止的那种「伪装成护栏」的东西。

## ⚠️ 库模式的每一档必须自己钉 `configDir`（否则账本 / 名单路径会落到仓库根）

`library-injection.test.ts` 那两处内联 config 都显式给到临时目录。理由不是洁癖：本目录**不跑
`loadConfig`**（`tests/setup-env.ts` 那层钉值只覆盖走 `loadConfig` 的用例），而库模式是
`new ConfigStore(内联)` 补缺省，于是所有路径类字段的缺省会按 **cwd（= 仓库根）**绝对化 ——
`authUsersFile` / `aclFile` / `quotaUsageDir` 就会指向仓库的 `cfg/`，而仓库里**真的**躺着
`cfg/users.json` 与 `cfg/acl.json`。（`quotaUsageDir` 那一项更硬：配额为零也照建账本目录。）

## 四条刻意**不给**断言的（如实记账，不留给下一个人自己撞上）

1. **「钩子加回来的代理凭证不会被再剥一次」不钉**。它是端口注释里**明写的自觉代价**（要先剥
   后改，就必然没有第二次剥离），但它也是一条**待裁决的形态**：将来真要收紧成「剥两次」，这里
   恰恰不该是拦住它的理由。钉死它只会把一次改进变成「先来改测试」。
2. **「钩子就地改自己的入参再抛错」不钉**。`applyOutboundRewrite` 的 `catch` 返回的是**同一个
   引用**，所以这种钩子留下的就地改动**会**真的出站——而这与「纯函数」的端口约定相悖。要不要
   由 core 兜住（传副本 / catch 时返回副本）是一个**尚未裁决**的设计问题；⑤ 刻意用
   「不碰入参、只 return」的钩子，于是它锁的是**返回值被丢弃**这条（那才是契约），对就地改动
   既不背书也不禁止。
3. **上下文的 `protocol` 维度已被从端口上删掉**（起草时实测恒 `undefined`，属类型层面撒谎）。
   两个调用点都从 `terminal.snapshotContext()` 取，而那个方法返回 `Partial<EventContext>`、
   `RequestTerminal` 的初始关联上下文只有 `{ client, connectionId, requestId, target? }`（SOCKS
   之外无人补）；挂一个恒为 `undefined` 的可选字段只会诱使插件作者写一条永远走 false 的分支。
   故 `OutboundHeaderContext` **没有**这个字段，插件要判入站协议读 `channel` 即可（本端口只长在
   http / upgrade 两条有 HTTP 头的通道上）。本目录因此**没有**任何关于它的断言——它是缺席，
   不是不变式。
4. **`client` 维度不与 `eventContext.client` 统一断言**。hook 拿到的是 `terminal` 那份
   （**TCP 对端**，准入/名单判定口径），而 `pipe` 事件 / `request.started` 用的
   `eventContext.client` 是 `getClientAddress(req)`（**XFF > X-Real-IP > Forwarded > socket**）。
   本目录断言的是它此刻真是什么，并在 ⑥ 里用「客户端发了 XFF 而 `client` 仍是对端」把这份差异钉住；
   该不该统一是待裁决的口径问题。⚠️ **这个差异为什么会咬人**：hook 那一侧的 `client` 来自
   `admission.ts:createInboundAdmission` 建 terminal 时给的 **`getSocketAddress(socket)`**
   （准入/名单判定那一档），而 `http.ts:handleForward` 另建的 `eventContext.client`
   （`pipe` 事件 / `request.started` 用的那份）才是 **`getClientAddress(req)`**。
   两条注释都说「客户端地址」，读代码极易误以为是同一份。

## 相关路径

- `src/core/helpers/headers.ts` — `applyOutboundRewrite`（⑧ 那条源码级判据咬的就是它的函数体）
- `src/core/forward/channel/http.ts` / `src/core/forward/channel/upgrade.ts` — 两条调用点（次序 ④
  与那处覆盖缺口都在这两处）
- `src/core/types/proxy.ts` — `OutboundHeaderRewriter` / `OutboundHeaderContext` 的端口声明
- `../../../helpers/source-scan.ts` — `codeOf` + `blockAfter`（⑧ 的文本面）
- `../../../helpers/upstream-stub.ts` — ⑥ 的 client 模式那一档用它那份可观测上游桩
- `../../../helpers/public-hosts/integration-forward-ohr.ts` — 本目录那条零外网白名单条目
  （`203.0.113.9` 只作为 `X-Forwarded-For` 头值出现，全目录**唯一**一处字面量）