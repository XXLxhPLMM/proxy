# tests/unit/core/ — core 那一层（`src/core/**`）的判据

本目录只答一件事：**core 这一层**（依赖承载体、错误边界、事件内核、日志词汇、终态守卫、
关联 id、拨号守卫、计量落点、入站派发表、转发器分配面、生命周期），**哪几处不许漂**。
机制与层不变量归 `src/core/AGENTS.md`（本目录**不复制**那四条：core 只 import
`@/core` / `@/utils` / `@/config` / `@/datasource`、零日志只抛不记、零 `EventEmitter`、
依赖载体只有一个 `ctx`）。

## 不变量放哪（⚠️ 判据是「这段不变量**有几档共用**」）

⚠️ **共用两档以上的不变量住在这份文件里**；**只服务一个档的就地住在那个档的文件头里**。
后者不是「篇幅问题」，是**读者判断力的问题**：一份只有一档用到的不变量躺在目录 `AGENTS.md` 里，
读的人分不清「这是全目录的纪律」还是「那一个档的来龙由」，而那两种的**改法与影响面完全不同**
（前者一动要重跑整棵树，后者一动只动一档）。

于是本树的分布是：

| 段 | 几档共用 | 住处 |
|---|---|---|
| **① 源码级负向断言的锚点纪律** | 5（根层 `dead-optionality`·`error-boundary` + `request-scope/{allocation,assembly}` + `server/inbound-dispatch`） | 本文件（跨子目录） |
| **② 端口级必填 / 字段级可选项 / 一个事实一个入口** | 5（根层 `context`·`error-boundary`·`dead-optionality` + `guard/client-lifetime` + `request-scope/assembly`） | 本文件（跨子目录） |
| 入站派发表的形状（哪一项走哪个方法） | 1 | `server/inbound-dispatch.test.ts` 文件头 |
| 生命周期跃迁与并发启停 | 1 | `server/base-lifecycle.test.ts` 文件头 |
| `RequestScope` 组装唯一性 | 1 | `request-scope/assembly.test.ts` 文件头 |
| 转发器只在构造期组装（零实例字段） | 1 | `request-scope/allocation.test.ts` 文件头 |
| `clientLifetime` 为什么是第三个位置参数 | 1（`core/guard/` 只有这一档） | `guard/client-lifetime.test.ts` 文件头 |
| `log-events` 的 `fields` 透传位置 | 1 | `log-events.test.ts` 文件头 |
| `PipeEvent` 14 变体穷尽契约 | 1 | `events/pipe-contract.test.ts` 文件头 |

⚠️ **`core/guard/` 与 `core/quota/` 各只有一档，故刻意不建 `AGENTS.md`** —— 那两份不变量就地住在
唯一一档的文件头里。判据是「这段不变量有几档共用」，不是「目录里有没有 `AGENTS.md`」。

## 不变量 ① 源码级负向断言的锚点必须落在**今天仍存在的形状**上

本树是**负向源码断言的密集区**（读源码文本 → `codeOnly` 去注释 → 逐行/逐块匹配），而这类断言的
死法是**恒真**：锚在一个**已删除的符号**上时，它在 `src/**` 的唯一命中很可能落在注释里，
`codeOnly` 剥掉之后恒为零命中 —— 它看起来在保护不变量，实际已经不判任何东西。
**自检三条**：① 锚到的形状今天还在吗？② 判据形状天然跨行吗（跨行判据必须整段文本匹配，
逐行匹配会静默失效）？③ 注释里点名被禁符号会不会被自己误判（`codeOnly` 只去注释正是为此）。

现成的两半纪律：
- **`codeOnly` 只去注释、不去字符串字面量**：文件头不得不点名自己禁止什么（「请求路径不得 new
  转发器」「`opts?` 已删」），把注释纳入断言就成了自我否定、只能靠删文档来过；而字符串里出现被禁
  词汇往往正是要盯的泄漏形态。
- **每条负向断言配一条正向面**：正向面负责证明**锚点今天还成立**，负向面才是被防的那件事。
  正向面钉的必须是**真实存在的形状**（`scope: RequestScope` 入参、`protected readonly dialer`
  字段、四项链式 `createRequestScope(ctx, …)` 调用），不是任何符号名。

⚠️ **路径层数只许出现在 `tests/helpers/source-scan.ts` 那一处**（`REPO_ROOT` / `TESTS_DIR` /
`SRC_DIR`）：测试目录会继续往下嵌套，而层数跟着调用点搬家。少一个 `..` 解析到 `tests/src` 会抛
`ENOENT`（**自己暴露**）；**多一个 `..` 枚举到空集则恒绿** —— 后者只会静静地不再判任何东西，
正是上面那条失效形态本身。

## 不变量 ② 端口级必填 / 字段级可选项 / 一个事实只许一个入口

**端口与守卫的形参必填，缺省解析只许发生在唯一组装根**（`createProxyRuntime()` /
`BaseProxy` / `buildDefaultServices`）。判据是**「缺席会走到哪条路」，不是「谁在用」**：四个
守卫形参的缺席会走到那份向客户端写 502/504 原始 HTTP 报文、并让上下游同生命周期的缺省档，
恰好违反「连接器绝不向 `ctx.client` 写任何字节」——那不是自洽的备用路径，是**会静默破坏契约的
兜底**。`ContextualBase` 的三个 getter、`RuntimeServices.errorClassification`、
`PreDialOptions.access`、`OpenContext.logPrefix` 都是同一条裁决。

⚠️ **但字段级可选项必须保留**（`DialGuardOptions` 的字段、predial 的判定输入对象）——各调用点
确实只设其中的一部分。**同类中必须显式置位的是 `keepClientOnFailure`**：空 reply 不等于调用方
会写（`keepClientOnFailure` 默认必须为 `false`，调用方显式传 `true` 保住客户端）。

⚠️ **同一个事实不许两个入口。** 被否掉的都是「同一事实抄成两份，而两份必然漂移」：
`RequestScopeOptions` 不许重新收 `requestId` / `connectionId`（`emit` 把身份合并进发布的
`context`，所以「id 在 `context` 里、却不算身份」是自相矛盾的形状）；`createRequestScope` 在
`src/**` 里恰好一个调用点；`socksUpstreamGuard` 的 `clientLifetime` 是**第三个位置参数**而不是
选项里的一枚（让 `undefined` 混进选项会把「明确要 linked」与「忘了传」在运行期混成同一个值，
而两者后果完全不同）。

## 文件（⚠️ 不变量 ↔ 位置对照）

根层六档：

- `context.test.ts` — `ContextualBase` 的三个 protected getter 只做**恒等投影**（依赖热替换靠它，
  改成构造期快照就静默失效），加上「getter 保持 protected」那条**编译期**护栏。
- `dead-optionality.test.ts` — 六处端口/守卫的**必填**（四个守卫形参、`guardDialing` 的 opts、
  `establishTunnel` 的 opts 与两个字段、`logPrefix`、`access`、`RequestScopeOptions`）。
- `error-boundary.test.ts` — 分类真值表 + 脱敏截断 + `ErrorClassifier` 端口可替换，
  以及**类体里不许直调 `classifyError`**（否则注入悄悄失效而全部行为断言照绿）。
- `log-events.test.ts` — `[event-code]` 文本词汇与 `extra` / `fields` 的透传位置。
- `request-terminal.test.ts` — 三个互斥终态共用**一份抢占**，终态只发一次。
- `scope-ids.test.ts` — `connectionId` 恒等 / 唯一、`newRequestId` 每次新值、两个命名空间不互相覆盖。

子目录：

- `events/hub.test.ts` — 分发契约（快照分发 / 异常隔离 / 缺省静默 / context 副本）+ `EventScope` 派生。
- `events/pipe-contract.test.ts` — `PipeEvent` 14 变体穷尽、**无索引签名**、收窄后字段可见。
- `guard/client-lifetime.test.ts` — `guardDialing` 的 `linked` / `independent` 两形态与
  `socksUpstreamGuard` 第三参（本目录**只有这一档**，故无 `AGENTS.md`）。
- `quota/meter.test.ts` — 计量落点是**被动计数**（不得整形），无身份时零挂点（本目录同）。
- `request-scope/allocation.test.ts` — 转发器只在服务构造期组装：请求路径零 `new`、
  四通道构造签名逐字三件套、零逐请求身份实例字段、服务层恰好 4 个构造点。
- `request-scope/assembly.test.ts` — `RequestScope` 组装**调用点唯一 + 入参形状一致**
  （双源档：第一段 describe 来自 `allocation` 那一档的末段）。
- `server/base-lifecycle.test.ts` — `BaseProxy` 跃迁 / 幂等 / `error` 态 / 并发启停 /
  鉴权击穿兜底 + 归一化 `options` 是冻结只读视图。
- `server/inbound-dispatch.test.ts` — 入站派发表的形状与「三个 `server.on` 回调体内零控制流」。

## 相关路径

- `src/core/AGENTS.md` — core 的层不变量与文件地图（**本目录不复制那四条**）。
- `src/core/events/{types.ts,hub.ts,scope.ts}` — `AppEventMap` / `EventHub` / `EventScope`。
- `src/core/forward/base.ts` + `src/core/forward/channel/` — 四个入站通道与它们共用的基类。
- `src/core/server/{http.ts,admission.ts}` — 三个 `server.on` 回调、派发表、`createRequestScope`
  在 `src/**` 里**唯一**的那个调用点。
- `src/core/quota-meter.ts` / `src/datasource/quota/` — 计量落点与它消费的 `UsageAccount` 端口。
- `tests/helpers/source-scan.ts` — 源码级断言的公共文本面**与 `REPO_ROOT` / `TESTS_DIR` /
  `SRC_DIR` 三个路径常量**（层数只许出现在那一处，见不变量 ①）。
- `tests/helpers/{config,access,net}.ts` — `testConfig` / `openAccessControl` / `getFreePort`。
- `tests/integration/runtime/{request-terminal-events,scope-ids}.test.ts` — 这两层的端到端那一半
  （真 `ProxyRuntime` 下的终态唯一性 / `data.kind` 契约值）。