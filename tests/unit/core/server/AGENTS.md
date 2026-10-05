# tests/unit/core/server/ — 入站服务层（`src/core/server/`）的判据

本目录只答一件事：**入站那一侧**（`BaseProxy` 生命周期状态机 + 「哪种入站事件走哪个转发器的哪个
方法」这张派发表），**哪几处不许漂**。出站与上游那一侧的判据在
`tests/unit/core/request-scope/`（分配面与组装面），机制与层不变量归 `src/core/AGENTS.md` 与
`src/core/server/AGENTS.md`。

## 不变量放哪（⚠️ 判据是「这段不变量**有几档共用**」）

⚠️ **共用两档以上的不变量住在这份文件里**；只服务一个档的就地住在那个档的文件头里。
本目录两档，分布是：

| 段 | 几档共用 | 住处 |
|---|---|---|
| **接线不许藏在闭包的分支里**（状态要落在显式的状态 / 表上） | 2 | 本文件 |
| **替身只实现它该有的成员，收到别的成员即派发写错** | 2 | 本文件 |
| 幂等启停 / 在途 stop 串行等待 / 鉴权击穿兜底 | 1 | `base-lifecycle.test.ts` 文件头 |
| 入口方法名必须按名字逐项断言 | 1 | `inbound-dispatch.test.ts` 文件头 |
| 归一化 `options` 是冻结的只读视图 | 1 | `base-lifecycle.test.ts` 文件头 |

## 两条不变量

① ⚠️ **接线不许藏在闭包的分支里。** 被否掉的形态在两档里各有一种，而代价不是难看，是**改不动**：
   生命周期这一侧，散在分支里的状态记账意味着「幂等 start/stop」与「只在真实跃迁处发事件」都得靠
   到处 `if` 补，于是同一状态在两处被判过；派发表那一侧，「哪种事件走哪个转发器的哪个方法」散在
   三条闭包里时，加第 4 种入站事件**没有「往表里加一项」这个动作可做**，只能把一份前置接线复制一遍，
   而复制出来的那份永远不会和原件同步演化。
   锁点：生命周期那侧是「`idle → running → stopped` 且每次跃迁恰好一条 `lifecycle.changed`」+
   「相同状态不重复发」；派发表那侧是「恰好三项 + 三项的 `dispatch` 是**三个不同函数** +
   三个 `server.on` 回调体内**零控制流**」（判据刻意比「零 `if (kind …)`」更宽 —— 任何一种控制流
   都不许出现，因为那都是「把这一层又变回隐式」）。

② ⚠️ **替身只实现它该有的成员，收到别的成员即派发写错。** `probeForwarders()` 里三个转发器桩
   **只**各有自己那一项的入口方法名，所以「派发到别的实现」会立刻现形（多一个成员就说明表写错了）；
   `DummyProxy` / `SlowStartProxy` 同理**显式**注入 `access: openAccessControl()` 与 `testContext`，
   不吃生产全局状态（core 侧已无 `access` 缺省，漏注入要在编译期红）。
   ⚠️ 反向的防假绿同样在这条纪律里：替身**不是**空跑（`proto[name]` 读的是三个**真实**转发器类的
   prototype，`buildInboundChannels` 真的产出三项真函数），否则上面几条全在「什么都没跑」的形状上恒绿。

## 文件（⚠️ 不变量 ↔ 位置对照）

- `base-lifecycle.test.ts` — **不变量 ①（生命周期那半）+ ②**：跃迁与 `lifecycle.changed`、
  幂等 start/stop、`doStart` 抛错进 `error` 态、`authorize` 异常兜底 `false`、`onStarted` 可覆盖、
  `start` 在途时 `stop` **串行等待**并最终停在 `stopped`（无残留监听）、存在 idle keep-alive 连接时
  `stop()` 仍能在 3s 内 resolve；外加配置访问器归一化（显式注入原样进入 core、`testConfig`、
  冻结只读视图）。⚠️ 并发启停那两条必须**真 listen**（`SlowStartProxy` 挂在 gate 上，端口取自
  `tests/helpers/net.ts:getFreePort`）—— 不真 listen 就证明不了「无残留监听」。
- `inbound-dispatch.test.ts` — **不变量 ①（派发表那半）+ ②**：恰好三项且顺序稳定、入口方法名互不相同
  且与 `InboundKind` 逐字对齐、三个真实转发器上确实各带着自己那一项的方法名、`forwardKind` 三项互不相同
  且等于公共事件面 `data.kind` 的契约值、`dispatch` 三个不同函数、`rejectTarget` 指向各自载体、
  派发真的按表走（参数逐字）、表是在服务构造期建的；外加三个回调体内零控制流 / 零 `Forwarder` 引用。
  ⚠️ `forwardKind`（`ProxyForwardKind`）只服务事件载荷的 `data.kind`，**不承担「归哪个转发器」**；
  它的消费面在 `tests/integration/runtime/scope-ids.test.ts` 与 `tests/unit/runtime/bridge/*.test.ts`。
  **SOCKS 不进这张表**（它不是 `server.on` 事件，而是连接内的握手状态机）。
- `../AGENTS.md` — 跨子目录共用的那两条（源码级负向断言锚点纪律 / 端口级必填）。

## 相关路径

- `src/core/server/base.ts` — `BaseProxy` 生命周期状态机与 `ContextualBase` 的接线。
- `src/core/server/http.ts` — 三个 `server.on` 回调 + `buildInboundChannels` 派发表（**服务构造期**建）。
- `src/core/server/admission.ts` — 两阶段准入与 `createRequestScope` 在 `src/**` 里**唯一**的那个调用点
  （组装面的判据在 `../request-scope/assembly.test.ts`）。
- `src/core/server/{socks-base.ts,socks-session.ts}` — SOCKS 那一侧（共享同一份准入与 scope 组装，
  但**不进**派发表；它的关卡顺序判据在 `tests/integration/inbound/`）。
- `tests/helpers/{net,config,access}.ts` — `getFreePort` / `testConfig` / `openAccessControl`。