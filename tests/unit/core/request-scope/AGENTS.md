# tests/unit/core/request-scope/ — `RequestScope` 那一圈（分配面 + 组装面）的判据

本目录只答一件事：**逐请求数据绝不能存在共享实例上**，而这条铁律在源码上**哪几处不许漂**。
`RequestScope` 是 core 唯一的逐请求作用域载体；它被造出来的地方在 `src/core/server/admission.ts`
（唯一调用点），被消费的地方是四个入站通道的 `scope: RequestScope` 形参。
机制与层不变量归 `src/core/AGENTS.md`。

## 不变量放哪（⚠️ 判据是「这段不变量**有几档共用**」）

⚠️ **共用两档以上的不变量住在这份文件里**；只服务一个档的就地住在那个档的文件头里。
本目录两档，分布是：

| 段 | 几档共用 | 住处 |
|---|---|---|
| ⛔ **`RequestScope` 的存在理由**（纯值对象 + 一个 `emit` 闭包，绝不可扩成「请求的全部上下文袋」） | 2 | 本文件 |
| ⛔ **防删注释式退化**：那两条理由必须写在**源码文件头**上，不许被删 | 2 | 本文件 |
| 负向锚点必须落在今天仍存在的形状上 + 每条负向配一条正向面 | 2 | 本文件（细则在 `../AGENTS.md` 不变量 ①） |
| 转发器构造点「恰好 4 个」的静态计数口径 | 1 | `allocation.test.ts` 文件头 |
| 调用点唯一性的三处**不是调用点**的逐条排除 | 1 | `assembly.test.ts` 文件头 |

## ⛔ 不变量 ① 本抽象存在的唯一理由

`RequestScope` 存在的理由只有一条：**逐请求数据绝不能活在共享实例上**。

四个转发器实例是**构造期一次组装、跨请求 / 跨会话复用**的，而 `user` / `requestId` /
`connectionId` 是**逐请求**才产生的 —— 存字段就是「A 的请求被记到 B 头上」的串号雷，而且症状是
「日志里名字偶尔对不上」，极难查。正确形态是 `RequestScope` 这个**纯值对象 + 一个 `emit` 闭包**，
身份逐次经参数传入。

⚠️ **不许把它扩成「请求的全部上下文袋」**：它的存在理由只有那一条，一旦开始装别的东西，
「逐请求 vs 共享」的边界就再也说不清了。

⚠️ **同一个事实不许两个入口**（细则见 `../AGENTS.md` 不变量 ②）：`RequestScopeOptions` 不再收
`requestId` / `connectionId`（`emit` 把身份合并进发布的 `context`，所以「id 在 `context` 里、
却不算身份」是自相矛盾的形状），`createRequestScope` 在 `src/**` 里恰好一个调用点。

## ⛔ 不变量 ② 防删注释式退化：理由必须写在源码文件头上

一个**只承载一条理由**的抽象，最可能的死法不是被改错，而是被当成「多余的一层」顺手删掉。所以那
两条理由必须写在**源码文件头上**，而本目录两档各钉自己那半（判据是**读原文**，
`sourceOf(...)` 不去注释 —— 这里是**故意**不 `codeOnly` 的）：

| 源码文件头必须逐字含 | 由哪一档钉 |
|---|---|
| `src/core/request-scope.ts`：`唯一理由` + `串号` | `assembly.test.ts` |
| `src/core/forward/base.ts`：`绝不存实例字段` | `assembly.test.ts` |

⚠️ 与 `../dead-optionality.test.ts` 那条「零 `requestId` / `connectionId` 形参」是**同一条不变量的
两半**（形参不许收 + 理由不许删），两处都别单独动。

## 不变量 ③ 负向锚点 + 每条负向配一条正向面

本目录的判据全是「读源码文本」，而这类断言的死法是**恒真**（细则与自检三条见
`../AGENTS.md` 不变量 ①）。本目录用到的三个锚点，全都是**今天仍存在的形状**：

| 断言 | 锚点 | 为什么这是可检查的 |
|---|---|---|
| 逐请求身份零实例字段 | `ForwarderBase` + 四个子类上零 `user`/`requestId`/`connectionId` **实例字段**（字段声明 + `this.` 读取两种真实形态） | 字段必须先声明才读得到，两种形态合起来没有第三种写法 |
| 事件槽只经构造签名进来 | 四个通道的**构造签名逐字等于三件套**（`ctx, services, connectors`） | 「没有第四个形参」是「事件槽不可能又从构造期进来」的唯一可检查形态 |
| 调用点唯一 | `createRequestScope(ctx, …, terminal, context: …, user: …)` 四项链式调用 + `.scopeFor(` 逐处调用 | 「没有第二个注入口」的那一种 |

⚠️ 「服务层合计恰好 4 个构造点」是**上界**（多一个就意味着又有人在请求路径里 new），而
「四个通道的构造签名恰好三件套」是**逐字等值**（多一个形参立刻红，少一个也红 —— 那说明有人把某件
必填依赖挪走了）。两者的判据形状不同，故两条都在。

## 文件（⚠️ 不变量 ↔ 位置对照）

- `allocation.test.ts` — **分配面**：四个转发器实现文件里零 `new XxxForwarder`；请求路径的**每一个**
  代码块（三个 `server.on` 回调 + `handleForward` + `onConn` + 两个会话处理器）里零 `new`；四通道构造
  签名恰好三件套；四通道仍以 `scope: RequestScope` 收逐请求数据（正向面）；零逐请求身份实例字段
  （+ 同文件上的正向面：`protected readonly dialer` / `this.services`）；服务层恰好 4 个构造点
  （3 + 1），且都在构造期。
- `assembly.test.ts` — **组装面**：不变量 ② 那两条源码文件头理由不许被删；`createRequestScope` 在
  `src/**` 里恰好一个调用点且在 `core/server/admission.ts`；两条入站路径都不自己造 scope
  （只调 `.scopeFor(`）；准入层那一处入参形状只有一种（`ctx` / `terminal` / `context:` / `user`，
  零 `requestId:` / `connectionId:`）；`RequestScopeOptions` 不再重复收那两个 id；
  外加「防假绿：护栏盯的代码块真的存在」那一组。
  ⚠️ 本档是**双源档**（`forwarder-request-path-allocation` 的末段 + `inbound-dispatch` 的末两段，
  按 `appendOrder` 追加），两个来源的前导常量和 imports **并进同一个文件头**。
  ⚠️ 「恰好一个调用点」要数的是 `src/**` 全量，故路径**从 `SRC_DIR` 派生**，不手写层数 `..`。

## 相关路径

- `src/core/request-scope.ts` — `RequestScope` 值对象与工厂 `createRequestScope`（文件头承载不变量 ②
  的第一半）。**零 `??` 兜底、零第二个 id 入口。**
- `src/core/forward/base.ts` — `ForwarderBase`：四个子类共用的那条「绝不存实例字段」铁律。
- `src/core/forward/channel/` — 四个入站通道（`http` / `tunnel` / `upgrade` / `socks`），构造签名
  逐字三件套，逐请求数据经 `scope: RequestScope` 进来（**type-only 引用**）。
- `src/core/server/{http.ts,socks-base.ts}` — 两条入站路径（都只调准入层的 `scopeFor`）与
  `SocksProxyBase` 的转发器字段初始化器。
- `src/core/server/admission.ts` — `createRequestScope` 在 `src/**` 里**唯一**的那个调用点。
- `../server/AGENTS.md` — 派发表那侧（入口方法名与派发按表走）。
- `../dead-optionality.test.ts` — 同一族护栏的另一半（可选形参那一侧）。