# tests/unit/core/forward/channel/ — 入站通道轴（`src/core/forward/channel/`）的判据

本目录两档只答一件事：**入站通道那一侧的源码级边界**——通道自己不许碰什么（选连接器、
协议判据、传输对端），以及那些负向断言为什么不是空跑。机制与层不变量归
`src/core/forward/channel/AGENTS.md`；`forward/` 根的目录成员清单与两轴依赖方向在
`../layout.test.ts`，`dial.ts` 与连接器层那一侧在 `../upstream/`。

## 不变量放哪（⚠️ 判据是「这段不变量**有几档共用**」）

⚠️ **共用两档以上的不变量住在这份文件里**；**只服务一个档的就地住在那个档的文件头里**
（`packages/tui/AGENTS.md` 的原话）。判据是「有几档共用」，不是「目录里有没有 `AGENTS.md`」。

| 段 | 几档共用 | 住处 |
|---|---|---|
| 按入站协议拆出 `channel/`（决策 ①） | 2（本目录两档都建立在「两轴单向」之上；机器判据在 `../layout.test.ts`） | 本文件 |
| 前置接线收口（决策 ②） | 2 | 本文件 |
| 控制流只看 `connector` 的声明式数据 / 事件一个都不许多发（决策 ③） | 2 | 本文件 |
| 「选连接器」全仓只有一处（判据是有效路由） | 1（`base-wiring`） | `base-wiring.test.ts` 文件头 |
| 锚点必须是「今天仍存在的形状」 | 2 | 本文件 |
| `codeOnly` 的口径（只去注释、留字符串字面量） | 2（各自持有一份同形拷贝） | 本文件 |
| 整段文本 vs 逐行 | 2 | 本文件 |
| `settleDenied` 为什么只有两分支 | 1 | `base-wiring.test.ts`（用例注释） |

⚠️ `../layout.test.ts` **只有一档，故不建 `AGENTS.md`**；它那三条决策的完整来由写在这里，
并在它自己的文件头指回来。

## 文件（⚠️ 不变量 ↔ 位置对照）

- `base-wiring.test.ts` — **决策 ②③ 的牙齿**：四个通道文件零「自己拿连接器」的入口 / 零
  `new *Connector` / 对连接器层只有 type-only 引用零值导入 / 两档选法全仓各恰好一次且都在
  `connectorForRoute` 体内 / 该方法体内零配置读取 / 零 `peerTarget()` 调用 / 五个窄抽入口都在
  基类上 + 四条通道确实各经基类选连接器 + http 与 upgrade 仍经 `preDialPeerTarget`；末尾一组
  「基类文件头不许被删注释式退化」。`FORWARD_DIR` / `allSources` / `CHANNELS` /
  `CHANNEL_GRABS_CONNECTOR` / `CHANNEL_CONSTRUCTS_CONNECTOR` / `countAcrossForward` 都**只服务这一档**，
  故留在它文件里（`allSources` 与 `../layout.test.ts` 那一份同形而不同物，见该函数注释）。
- `no-protocol-branch.test.ts` — **决策 ③ 的牙齿**：四个通道文件里零
  `isSocksProto` / `socksVersionOf` / `isTlsUpstreamProto`，加上两组「护栏不是空跑」（源码非空 +
  真经 `connectorForRoute` 选上游）与两条具体判据（`upgrade.ts` 单一路径的三个恰好一次 +
  `viaSocks` 不许回来 / `socks.ts` 的日志版本号取自 `connector.kind`）。
  `CHANNEL_FILES` / `CHANNEL_PROTOCOL_CALLS` / `countLines` / `codeOnly` / `offendingLines`
  都**只服务这一档**，故留在它文件里；「读 `src/core/forward/` 原文」那一面与另外两档共用，
  走 `../upstream/_dialer-protocol-boundary.ts`。

## 决策 ①：按入站协议拆出 `channel/`，不是按上游协议

被否掉的是「按上游协议分组」，它的判据是「`channel/` 的存在前提是『每个转发器按一种上游协议
分支』，而该前提已被 `connector/` 层消灭」。**那个判据本身没错，但它把两件事混成了一件**：
①「按上游协议分支」确实已被连接器层消灭（零控制流级协议判据，那半边由本目录的
`no-protocol-branch.test.ts` 与 `../upstream/dial-boundary.test.ts` 逐字锁住）；
② **「按入站协议分组」是另一件正交的事**，它的收益不是
抽象而是**依赖方向可断言** —— 这正是 `../layout.test.ts` 那几组 `dirsOf()` / `importsOf()` 断言
存在的理由。

- **实测「抽不动的代码」仍逐条成立**（`codeOnly` 口径：四条通道合计 936 → 窄抽后 857 行）：
  SOCKS 侧「握手 + 目标解析」**112 行形态独立**（只有 SOCKS 入站走客户端原始字节，不过 HTTP
  解析器）、`http.ts` 全程操作 `ServerResponse` 且**零次**调 `bridgeWithBuffered`、`upgrade` 必须
  **先等 101** 才有隧道（还有非 101 的独立分流）、`refusal` 处置刻意分成**两种**（`tunnel`
  「原样透传不断链」让 `Proxy-Authenticate` 送达客户端 vs `socks`「回 SOCKS 失败应答」因为回
  HTTP 报文会污染协议）。**这些仍然不可约：目录分组不等于抽象，拆目录后协议代码一行没少变。**

## 决策 ②：前置接线收口

被否掉的是「不建『前置接线方法族』」，理由是**实测收益太小**（净 -32 行、3.4%），以为不值得。
**那个度量衡是错的**：判据应该是**「改一处好过改四处」**而不是「减几行」——本仓已吃过一次同型亏，
每用户流量配额的绕过之所以要逐处修补，正是因为「计量落点」这个同一逻辑有四份拷贝。

- ⚠️ **为什么净收益只有 3.4%**（想「补完剩下的重复」前先读这段）：本仓的「重复」与教科书不一样
  ——**大部分重复是注释，不是代码**。每份接线都带着一大段解释「为什么这样做」的注释，窄抽时那些
  注释**跟着各自的语义留在了通道**；`codeOnly` 口径虽然去掉了注释，却同时**去掉了大部分收益**。
  **剩下的「重复」已经不值得抽**：应答形态 4 种、`upstream-error` 载荷 3 种、`isSocksTunnel` 各一个
  调用点——那正是「不建协议应答层」记的假抽象。**结论：前置接线已收干净，这层没有下一次同型收益了。**
- **那五个基类方法各自抽的是「真正逐字同形的那部分骨架」**；四种应答形态与三份 `upstream-error`
  载荷刻意留在通道。`base-wiring.test.ts` 的四组负向断言 + 三组正向断言就是这条决策的可执行形式：
  **把接线抄回任一条通道，本档立刻红**；把基类那几个方法删掉，同样红。

## 决策 ③：控制流只看连接器的声明式数据，事件一个都不许多发

两半合成一条：

- 「`SocksForwarder` 三条上游支路的判别用连接器的声明式数据」——被否掉的是「按 `upstreamProtocol`
  重推协议」：`kind === "direct"` → 直连分支、`targetForm === "absolute"` → http(s) 上游分支
  （唯一可能有 `refusal` 的形态）、其余 → SOCKS 上游分支。牙齿是 `CHANNEL_PROTOCOL_CALLS` 在四个
  channel 文件里逐行零命中（**已变异测试验证**：放回任一句立刻红）。
- 「**绝不允许多发一条 `route` / `target-denied`**」——补判那次（`preDialPeerTarget`）判的是同一个
  `dest`，第一次拒了就 return，故不会重复发。牙齿是 `countLines` 那三组：`this.emitRoute(` 恰好 1、
  `this.preDial(` 恰好 1、`this.preDialPeerTarget(` 恰好 1（外加私有方法 `viaSocks` 不许回来，它内部
  那份 `resolveRoute`/`preDial`/`emitRoute` 是重复的第二份）。行为面的对应断言在
  `tests/integration/forward/upgrade-channel.test.ts`（每请求恰一条 `route`；目标命中黑名单时恰好
  一条 `target-denied`、零条 `route`）。

## 负向源码断言的锚点纪律（本目录两档共用）

⚠️ **锚点必须是「今天仍存在的形状」**：锚在一个**已删除**的符号上时，命中会全落在注释里，
`codeOnly` 剥成空格后「零命中」恒成立、不锁任何东西（本仓最危险的一类假绿）。所以两档的锚分别是
`this.connectors.` / `createConnectorSource(` / 协议查表符号 / `new *Connector` / 连接器层的值导入
（`base-wiring`），与 `isSocksProto` / `socksVersionOf` / `isTlsUpstreamProto` / `get("proxyMode")` /
`viaSocks(` / `connector.kind === "socks4" ? 4 : 5`（`no-protocol-branch`）。

⚠️ **两档互为对方的配对面**：`no-protocol-branch` 的「护栏不是空跑」那一条靠的是**真经
`connectorForRoute` 选上游**，而「连接器由装配期造好并注入」那几条负向断言的真身住在
`base-wiring`。⚠️ **不能**因为配对就放松成「什么都行」——它仍必须指名那个入口。

## 文本口径（本目录两档共用，判据各自住档内）

- **`codeOnly` 只去注释、留代码与字符串字面量**。字符串里出现被禁词汇往往正是要盯的泄漏形态；
  而注释里点名它通常是在**描述这条不变量本身**（文件头不得不点名自己禁止什么），把注释也纳入
  断言就自我否定、只能靠删文档来过。⚠️ 两档各持一份**同形拷贝**（与
  `../../../../helpers/source-scan.ts` 那份实现一致）：这是护栏的**文本面**，与被它判的行为面锁在
  同一个档里，改一边时另一边不会跟着动。
- **判据一律整段文本 `.test(…)`，`offendingLines`（逐行）只进失败信息帮人选。** 逐行口径对
  `this\n  .connectors\n  .direct()`、`const peer = …` / `if (peer.host !== …` / `&& this.preDial(…`
  这种**天然跨行**的写法永远匹配不到 —— 那是「护栏假绿」最常见的形态。
- ⚠️ **`countLines` 传入的正则不得带 `g`**：带 `g` 时 `test` 有状态（`lastIndex` 跨行推进，
  某行未命中还会把它复位成 0），「出现两处」会被数成一处。

## 路径纪律

⚠️ **`src/core/forward/` 的路径面从 `../../../../helpers/source-scan.ts` 的 `SRC_DIR` 派生**，
本目录两档都不许手写层数算术：少一个 `..` 会解析到 `tests/src` 抛 `ENOENT`（自己暴露），
**多一个 `..` 会让源码扫描枚举到空集而恒绿** —— 而这两档的判据面正是那些源码，扫空了就全绿。
本目录不需要读 `src/` 的两档之外的文件；需要读的那一档走
`../upstream/_dialer-protocol-boundary.ts:forwardSourceOf`（方向与 `src/` 一致：channel → upstream）。

## 相关路径

- `src/core/forward/channel/{http,tunnel,upgrade,socks,socks-reader}.ts` — 被扫的四条通道与握手读取器。
- `src/core/forward/base.ts` — `connectorForRoute` / `preDialPeerTarget` / `settleDenied` /
  `settleDialFailure` / `denyUpstreamLoop` 五个窄抽入口与「身份维度绝不存实例字段」那行文件头。
- `src/core/forward/upstream/connector/` — 被禁的「自己拿连接器」四个形状各自的真身。
- `../../../../helpers/source-scan.ts` — `codeOnly` / `offendingLines` / `blockAfter` / `codeOf` /
  `sourceOf` / `SRC_DIR`。
- `../../../../helpers/external-network-scan.ts` + `../../../../helpers/public-hosts/unit-core-forward.ts`
  — 本目录**零条目**（两档都不含公网 host 字面量；那两条豁免归 `../upstream/` 的两档）。
