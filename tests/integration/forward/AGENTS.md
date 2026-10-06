# tests/integration/forward/ — 转发那一圈（`core/forward/**`）的判据

本目录只答一件事：`core/forward/` 的四条通道（`http` / `tunnel` / `upgrade` / `socks`）加上
`core/forward/upstream/connector/**` 这一层，**出站那几个字节与守卫事件长什么样、哪几处不许漂**。
目录级说明见 `../AGENTS.md`。

⚠️ **本目录是 28 档 + 6 个 fixture 的清单，不是它们的并集**：一个档的头只留「这一档钉哪一段 +
指向本文件」，本文件只放**三档以上共用**的推理。判据是**共用档数**，不是「目录里有没有 AGENTS.md」——
所以 `contract/` / `connector-wiring/` 的决策在本文件（各服务 5 档，且两个目录之间互相点名），
而 `outbound-header-rewrite/` 那六条契约留在它自己那份（本目录里只有它那 4 档用到）。

## 文件（⚠️ 共享段 ↔ 位置对照）

### 平铺档（14 档 / 46 个 `it`，含 1 个 `it.skip`）

⚠️ **平铺层没有 ①②③ 编号**，而三个子目录有。判据不是「编号更好读」：子目录里**一档钉一行**
（`contract/` ①–⑤ 各对应一档），编号与那一行是同一个东西；平铺层每档钉的是**一种装配形状**
（直构 core / 起子进程 / 轮换上游协议 / 真 `HttpProxy`），彼此不是同族，硬编一个编号只会暗示
一个不存在的对应关系。故平铺层的键是**档名**。

| 档 | 装配形状 | 钉什么 / 共用段归哪 |
|---|---|---|
| `http-basic.test.ts` | 直构 `HttpProxy` | 明文 HTTP 直转发的基线 + 生命周期幂等（重复 `start()` 不改状态） |
| `http-auth.test.ts` | 真 `HttpProxy`（`startProxy`） | 鉴权**总开关优先**于类型；basic / jwt 各自的「对 → 放行 / 错 · 缺 → 407」；jwt 未注入 `verify` 时拒而不崩。装配面归 `./client-node-fixture.ts` |
| `http-request-line.test.ts` | **spawn 真 `dist/app.js` 子进程** | server 模式下客户端 absolute-form 归一为 origin-form、origin-form 原样透传（断言的是**源站收到的请求行原文**）。子进程两道隔离归 `../../helpers/child-proxy.ts`，本目录不复述 |
| `http-upstream-protocol.test.ts` | 直构 `HttpProxy` + **现读**连接器源 | `upstream=https/http/socks5` 三档轮换（一个代理实例逐档 `set`）—— 生产那份记忆化连接器源不能用，故这里现造一份**现读**实现 |
| `http-via-socks.test.ts` | 直构 `TunnelForwarder` | A/B/C/D 四档（SOCKS / chunked 重分帧 / SOCKS-over-TLS / 拨号超时 504）—— **四档的判据在本文件「`http-via-socks` 的 A/B/C/D 四档」一节** |
| `http-client-node.test.ts` | 真 `HttpProxy`（`startProxy`） | 明文 HTTP、Basic 三格（对 / 错 / 缺）、CONNECT 建隧后透传 HTTP |
| `http-client-node-upgrade.test.ts` | 真 `HttpProxy`（`startProxy`） | websocket 两档：明文 ws（**`it.skip`**，本地回声桩上 flaky，理由逐字在 `it` 上方）与 wss 经 CONNECT+TLS。装配面归 `./client-node-fixture.ts` |
| `http-chain-forward.test.ts` | **两对 spawn 子进程** | 明文串联三条：absolute-form 转发 / 客户端凭证头不透传 / 前级上游账密注入放行 |
| `http-chain-tunnel.test.ts` | **两对 spawn 子进程** | CONNECT 串联四条：建链后双向透传 / 前级显式账密建链 / 客户端账密到前级为止 / 前级只拦不代回 200 |
| `tunnel-guard.test.ts` | **直构 `TunnelForwarder` / `WsForwarder`** | 隧道守卫定时器、上游非 200 原样回透、CONNECT authority 非法回 400；ws 严格判 101。**两条决策在本文件「`tunnel-guard` 的两条决策」一节** |
| `upgrade-channel.test.ts` | 真 `HttpProxy`（`withWsProxy`） | 每请求恰好一条 `route` 的五种情形（SOCKS 上游 / http 上游 / 回落直连 / server 直连零条 / 目标命中黑名单）。**推理在本文件「`upgrade` 两档共用的两条」一节**；装配面归 `./upgrade-fixture.ts` |
| `upgrade-self-loop.test.ts` | 真 `HttpProxy`（`withWsProxy`） | 自环判定两侧都必须在**拨号之前**拒（上游零建链）。同上 |
| `instance-reuse.test.ts` | 真 `HttpProxy` + 探针子类 | 转发器「构造期组装、跨请求复用」：构造次数不随请求数增长 |
| `instance-reuse-identity.test.ts` | 真 `HttpProxy` + SOCKS5 探针子类 | 身份维度绝不串号：`user` / `requestId` / `connectionId` 逐请求，而转发器跨请求共享 |

### 平铺层的三个 fixture

⚠️ **一个 fixture 归两档或三档，且都不导出 hook**（登记点必须与桩池同处一档才读得出来）——
`upgrade-fixture.ts` 因此导出 `prepareEach` / `cleanupEach` 供使用档在自己的 `describe` 里注册，
`instance-reuse-fixture.ts` 只收「哨兵配置」那一段（两档的 `beforeAll` / `afterEach` 各起不同的桩）。

| fixture | 服务的档 |
|---|---|
| `client-node-fixture.ts` | `http-auth` / `http-client-node` / `http-client-node-upgrade`（真 `HttpProxy` 的起停与基础配置） |
| `upgrade-fixture.ts` | `upgrade-channel` / `upgrade-self-loop`（自建总线 + 文件驱动访问控制 + 手写 Upgrade 的客户端） |
| `instance-reuse-fixture.ts` | `instance-reuse` / `instance-reuse-identity` |

⚠️ **三个 fixture 刻意不住 `tests/helpers/`**：`external-network-scan.ts` 的 `SCAN_DIRS` 排除
`helpers/` 而 `walk()` 收目录下**全部** `.ts` —— 搬进去等于让这一部分覆盖从零外网扫描里**静默消失**
（`tests/unit/meta/no-external-network.test.ts` 的两条下界断言照样绿）。同一条理由适用于三个子目录的 fixture。

### 三个子目录（本文件索引，不重写它们自己的内容）

| 子目录 | 档 | 它自己的 `AGENTS.md` | 共享段住哪 |
|---|---|---|---|
| `contract/` | 5（`absolute-form` / `origin-form` / `socks-tunnel` / `upstream-credential` / `dial-failure`） | ❌ 无 | **本文件**「`contract/`：出站形态合同表 + 三条决策」 |
| `connector-wiring/` | 5（`channel-{tunnel,socks,upgrade}` / `connector-choice` / `credential-injection`） | ❌ 无 | **本文件**「`connector-wiring/`：五条决策 ①–⑤」 |
| `outbound-header-rewrite/` | 4（`absent-and-mutate` / `ordering-and-throw` / `context-dimensions` / `library-injection`） | ✅ 有，**六条契约 + 变异实测 + 覆盖缺口都在那里** | 留在它自己那份（只服务那 4 档） |

⚠️ **`contract/` 与 `connector-wiring/` 的 5 份决策住本文件而不是它们各自的目录**：两边的决策
**互相点名**（`contract/` 决策 ② 把逐字断言指到 `connector-wiring/channel-{tunnel,socks,upgrade}.test.ts`，
决策 ③ 把「超时 → 504」那一半指到平铺层的 `http-via-socks.test.ts` D 档），而两个子目录各写一份
`AGENTS.md` 就是让「另一目录的决策」没有落点。⚠️ **`outbound-header-rewrite/` 反过来**：它的六条契约
在 `forward/` 内零引用，故留在它自己那份。

## `contract/`：出站形态合同表 + 三条决策

⚠️ 这两段**随本文件住**：五个档各自逐字钉其中一行，而它们描述的是同一套装配的性质，
抄进五份就是五份会各自漂的真相。

### 出站形态那张合同表

`http.ts` 只有一条出站路径：选连接器 → `connector.transport()` → `http.request({ createConnection })`。
全部风险都在「出站那几个字节长什么样」：

| # | 行为 | 判据来源 |
|---|---|---|
| ① | `targetForm === "absolute"`（经 http/https 上游）：request-target **保留客户端原始形态**（absolute-form），**注入**上游凭证，**不改写**客户端的 Host | 连接器 `targetForm` / `upstreamAuthHeader()` |
| ② | `targetForm === "origin"`（直连）：request-target 用解析后的 `dest.path`；客户端发 absolute-form 时 Host 按 RFC 7230 §5.4 **回写**为 request-target 的权威值 | 连接器 `kind === "direct"` |
| ③ | 经 SOCKS 隧道：Host **无条件**回写为 `formatAuthority(dest.host, dest.port)`（IPv6 补方括号）+ 强制 `Connection: close` | 连接器 `kind !== "direct"` |
| ④ | 上游凭证**只**经 http/https 上游注入；SOCKS / 直连绝不带 `Proxy-Authorization` | `targetForm` + `upstreamAuthHeader()` |
| ⑤ | 拨号失败统一 502 且带 `upstream-error` 事件（不挂死）；`sanitizeHeaders` 的出站净化对三条支路一致生效 | 单一 catch |

②③ **刻意是两种判据**（直连是「absolute-form 才回写」，SOCKS 是「无条件回写」）：
前者的触发条件是「客户端 Host 与 request-target 冲突」，后者的前提是「request-target
已被本代理改写成 origin-form、客户端的 Host 不可信」。**本目录不把两者统一**。
（实测：在**可达**的请求上两种判据产出的字节逐字相同——差异只在「URL 省略缺省端口」
那种 `absoluteFormAuthority` 会丢端口的形态上。故本目录锁的是**可观测效果**，
「无条件」这个代码级属性由 `http.ts` 的注释负责说明，别因为「看起来等价」就顺手统一。）

上游凭证的注入条件**不在这一层**、而在连接器（`upstreamAuthHeader()` 对直连/SOCKS 恒返
`undefined`），各档只锁可观测效果：SOCKS/直连的源站收不到 `Proxy-Authorization`。

观测手段：源站/上游一律用**裸 `net.Server`**（`http.Server` 会把畸形 target 也塞进
`req.url`，把缺陷藏住），客户端用裸 socket 手写请求行 —— 断言的是**逐字节原文**。

### `contract/` 锁住的三条决策（结论 — 为什么）

**① Host 回写是「两种判据并存」，不是同一个东西抄了两遍。** 为什么不统一成一种——
① `targetForm === "absolute"`（对端是代理）**原样保留**客户端 Host（absolute-form 请求行的
权威值已经是「客户端要访问谁」，改写会与请求行自相矛盾）；② 直连（`kind === "direct"`）在
客户端发 absolute-form 时按 RFC 7230 §5.4 **条件回写**；③ 经 SOCKS 隧道**无条件回写**为
`formatAuthority(dest.host, dest.port)`（前提是 request-target 已被本代理改写成
origin-form、客户端的 Host 不可信）。⚠️ **本目录锁的是可观测效果**（② 的条件回写 / ③ 的
无条件回写 / ① 的不改写，各自带一条 origin/absolute/bogus-Host 的用例），**「无条件」这个
代码级属性不由本目录锁**——实测两种判据在**可达**请求上产出的字节逐字相同，差异只在
「URL 省略缺省端口」那种 `absoluteFormAuthority` 会丢端口的形态上。**所以更不能因为
「看起来等价」就顺手统一。**

**② 出站失败日志统一为 `[http] upstream error <peer.host>:<peer.port>`**（SOCKS 支路不写
`via socks` 字样）。为什么不按上游类型分文案——「经哪种上游」的信息已由守卫 route 文本
承担（`[<prefix>] error <clientAddr> -> <dest> via socks<N> <upstream>`，逐字断言在
`connector-wiring/channel-{tunnel,socks,upgrade}.test.ts`），信息量只增不减，
分两处写只会让两份文案各自漂。牙齿 = ⑤ 那条 `e.type === "upstream-error" && message.includes(\`[http]
upstream error 127.0.0.1:${dead}\`)`：前缀、文案、`<peer.host>:<peer.port>` 三段全逐字。

**③ 拨号失败：超时 → 504、其余 → 502**（`settleDialFailure` 的映射）。为什么不是 catch 里
一刀切 502——那会吃掉超时成因，运维分不清「上游慢」与「上游拒了」。本目录锁的是**其余 →
502 且带 `upstream-error` 事件**这一半；**超时 → 504 那一半逐字锁在
`http-via-socks.test.ts` 的「D：TLS 上游握手卡死时拨号超时回 504」**
（`expect(firstLine).toContain("504")`）——把它改成 502 那条会红。SOCKS 的失败应答
**不区分**成因（协议只有一个失败码）。

## `connector-wiring/`：五条决策 ①–⑤

**① `WsForwarder` 与 `logPrefix: "upgrade"` 刻意与文件名 `upgrade.ts` 不同。** 为什么不改名叫
`websocket.ts`：类名是导出符号，改它波及调用面与既有护栏的字面量；`logPrefix`
是**落盘日志文本契约**（三档 upgrade 断言逐字比对 `[upgrade] error …`，前缀一变全红）。
**文件名的 `upgrade` 与 `InboundKind` 的 `"upgrade"` 同字，这一致性是想要的**（那条由
`tests/unit/core/forward/layout.test.ts` 的 `CHANNEL_MEMBERS` 逐字锁住目录成员）；
而「不叫 websocket」是因为 `upgrade.ts` **不实现 WebSocket 协议**（不做帧解析 / 分片重组 /
掩码 / ping-pong / close 握手），叫 websocket 会让人以为「帧的处理归这里」。

**② 守卫前缀恒为 `"upgrade"`，不得按连接器身份改成 `[socks]`。** 为什么不让前缀跟着
对端变」——三条路径的 route 文本是**锁死的契约**。本目录的形状就是它的牙齿：经 SOCKS 上游那档
的期望值逐字是 `[upgrade] error 127.0.0.1 -> target.example:8443 via socks5 …`——前缀若跟着
连接器身份走，那一档立刻对不上。「是否经 SOCKS 隧道」**现在只影响失败日志文案**
（`viaSocksTunnel` 决定 `"via socks "` 尾巴），**不参与报文形态**。

**③ upgrade 通道的 client 模式也经连接器层，与另外三条同一条路。** 为什么不走「client
模式自己拨号」。① TLS 承载由 registry 构造期定死，`upgrade.ts` 零 `isTlsUpstreamProto`
导入（逐字锁在 `tests/unit/core/forward/channel/no-protocol-branch.test.ts` 的 `CHANNEL_PROTOCOL_CALLS`）；
② 守卫 route 文本是 `"<dest> via <upstream>"` **全量形式**，与 http/tunnel 同源——
**全量形式才是契约**，由「有效 client 经 http(s) 上游」那条逐字断言锁住（改回
`transportVia` 自己拨号会让它退回只报上游地址的「短」文本）。

**④ 上游凭证的注入条件不在通道里，只由 `connector.upstreamAuthHeader()` 决定。** 为什么不在
http / upgrade 通道再按 `toProxy` 判一次——直连与 SOCKS 恒返回 `undefined`
（凭证在 SOCKS 握手里），在通道再判就是冗余的第二判据。牙齿是「**隧道中继型**」
连接器用例（**已变异测试验证**）。
- ⚠️ **危害（第三方注入自定义 `ConnectorSource` 时真实可达）**：一个「隧道中继型」连接器
  （`kind:"https"` + `targetForm:"origin"` + `upstreamAuthHeader(): undefined`——中间有一跳中继
  网关，终点仍是源站）会同时骗过两份判据的两半：`isSocksTunnel` 恒 false → 旧判据判成
  「对端是代理」→ 用 **absolute-form** request-target 打给一个**不是 HTTP 代理**的对端，并把
  `UPSTREAM_USERNAME` / `UPSTREAM_PASSWORD` 的 **Basic 凭证注入给真实目标站**。现行写法是
  `toUpstreamProxy = connector.targetForm === "absolute"`、凭证只经
  `connector.upstreamAuthHeader()`，**同一个字段说了算**。
- ⚠️ **「两条判据在今天的内置实现上等价」不等于两条判据是对的**：内置连接器恰好满足
  「`kind === "direct"` ⟹ 该请求恰是 server 模式」且「SOCKS 两版的 `targetForm` 恒
  `origin`」，缺陷路径只是还没被走通。**凡靠内置实现巧合成立的判据都要当成待办**：读对端身份
  一律读 `targetForm`，不是给 `kind` 加约束。

**⑤ 接线护栏集中在本目录**：守卫 route 文本（逐字，**upgrade 三档齐全**：经 SOCKS 上游 /
有效 client 经 http(s) 上游 / 主路径回落直连）、tunnel 的 refusal 透传（逐字节）、以及
「有效路由 direct 时必须选 `connectors.direct()`」（双桩互斥判别）。
**route 文本自此是契约**——改它必须先改对应档并说明理由，否则「顺手调日志」会把排障线索
抹掉，且三条断言会同时红。

连接器层为什么统一按「信息最多的既有形态」给 route 文本（`[<prefix>] error <clientAddr> ->
<dest>` 或 `... -> <dest> via socks<N> <upstream>`）：变强的那几处（socks 直连分支、socks 的
socks 上游分支、websocket 的 socks 上游分支，以及 websocket 的**有效 client 经 http(s) 上游**
那条）的「短」是**各调点随手写出来的差异，不是契约**。

## `upgrade` 两档共用的两条（⚠️ 判据原在同一个文件里，拆档后归本文件）

⚠️ `upgrade-channel.test.ts` 与 `upgrade-self-loop.test.ts` 是同一个文件拆出来的，两条推理
**各服务其中一档却牵动另一档**，故住在这里而不是任一档的头。

**① 每请求恰好一条 `route` 事件**（`upgrade-channel.test.ts` 五档，`upgrade-self-loop` 的两条
也各断言一次）。`WsForwarder.handle` 里**没有**上游协议分支：「client + socks 上游」早分支
（目标尚未解析就自行 `resolveRoute`）不在了，全部请求走同一条路径。事件顺序与另外三条通道
一致——**这是收敛、不是 bug**。但只要 `viaSocks` 里那份 `emitRoute` 还在，同一条请求就会发
**两条** `route`（`[route]` 落盘行也跟着翻倍），所以这条「恰好一条」是最要紧的断言。
顺带钉住 `emitRoute` 仍会短路的那一档：server 模式直连**零条**；目标命中黑名单则**恰好一条
`target-denied`、零条 `route`**（补判那次 `preDial` 不得重复发）。
⚠️ 「恰好一条」的判据形状自带**防假绿**：每条用例都在 `waitUntil` 之后**再多等一拍**
（重复发是同步的，但事件分发在同一轮里），否则「一条都没发」会同时满足 `length > 0` 与
`toHaveLength(1)` 之外的那些形状。

**② `preDialPeerTarget` 不可删、不可短路**（`upgrade-self-loop.test.ts` 两条）。
「只跑第一次 `preDial`」为什么不行：第一次 `preDial` 判的 `dial` 在 client 模式下是
**上游**，而 SOCKS 隧道实际落到**真实目标**。只跑一次的话「客户端请求代理自己的监听地址」
就没人判，客户端能让本代理经 SOCKS 隧道连回自己。**这是一个真实的自环漏洞。**
保住它的是 `handle` 里「`peerTarget(dest) !== targets.dial` 才补判一次 preDial」那条
（与 `http.handle` 同源）。

牙齿就是「自环判定」那两条：**短路掉补判，第一条立刻红**
（客户端拿到 101/200 而不是 502、`loop-detected` 零条而不是恰好一条、上游桩有建链而不是
零建链）。**已变异测试验证。**

顺带被这组钉住的还有「补判那次判的是同一个 `dest`，第一次拒了就 return」——所以
`target-denied` 与 `route` 都不会多发一条。
⚠️ 上游那一侧（`denyUpstreamLoop`）必须**在拨号之前**拒，故牙齿是「上游零建链」而不是「回了 502」——
502 与拨号失败同形，只断言状态码的话两档会互相冒充。

**观测手段**（两档共用）：真 `HttpProxy` + 裸 socket 手写 Upgrade 请求 —— 这几项要观察转发器
入口的守卫事件与原始状态行报文，套真 server 反而会掺进 `HttpProxy` 的 ACL / 鉴权判定之外的东西。
⚠️ 自环判定读的是 accessor 的 `host` / `port`，故**必须与真实监听地址一致**：那一行在
`upgrade-fixture.ts` 的 `withWsProxy` 里（它自己取端口再构造 proxy 并 `set("port", port)`），
调用方拿不到真实端口，所以这条约束的实现**只**住在那个符号上 —— 抄一份到档里就会立刻失效。

## `http-client-node-upgrade` 的三个 helper 定时器

**为什么那档的目标源站必须是本地桩**：实测打真实公网 wss 端点时单次 TLS 握手约 4.2s，
而 `wssViaConnect` 的 CONNECT 预算只有 5s（那个 5s 定时器**从不起清除**，是全档的实际上界），
于是并行跑 75 个测试文件时**必然偶发超时**。改本地源站后握手是毫秒级，预算原样不动 ——
放宽超时是掩盖不是修复。

**三个 helper（`httpsGetViaConnect` / `wsViaHttpProxy` / `wssViaConnect`）的 `setTimeout`
一律不 `clearTimeout`** —— 本文件既有模式，三处刻意保持一致，不许只改其中一个。
正常路径不留影响：Promise 结算后再 reject 是 no-op。

⚠️ 但 `wssViaConnect` 里那个 8s 定时器**永远轮不到**：它写在 `s.once("data")` 内部、
只有 CONNECT 回了 200 才起算，而 5s 那个从 Promise 创建就起算 —— CONNECT 一旦在 5s 内成功，
8s 必然落在 5s 之后。故 TLS/Upgrade 阶段真挂时实际生效的仍是 5s 那个，报出来的文案是
`wss CONNECT timeout`，**归因写错了阶段**（CONNECT 其实已经成功）。
要修得给三个 helper 统一补 `clearTimeout` 并把预算拆成「CONNECT 5s + 其后 8s」两段，
那会改掉挂起路径的实测行为，故此处**只如实记录、不动代码**。

## `tunnel-guard` 的两条决策（结论 — 为什么）

**① `tunnel.handleConnect` 解析 authority 失败回 400、502 只留给网关侧失败。** 为什么不是
「一律 502」——客户端请求报文非法与网关侧失败是**两种事实**，与 http / upgrade 的解析失败
语义一致。牙齿 = 「CONNECT：authority 非法（:443）回 400 并断链（回归误回 502）」：
`expect(client.text()).toContain("HTTP/1.1 400 Bad Request")` 逐字，改回 502 立刻红。

**② `WsForwarder.relay` 的 `readableEnded` 分支不可删。** 为什么不能「101 之后一律
`pipe`」——`'end'` 可能早于续体挂 `pipe` 之前发出；已 EOF 则 `client.end()`，否则
`upstream.pipe(client)` 续传剩余 body（`Content-Length` 大于首包时客户端不挂等）。上游错误
/ 关闭收尾归 `guardDialing` 既有 handler，不额外 destroy。牙齿 = 下面两条非 101 用例的
`await waitUntil(() => client.closed(), 2000, "非 101 收尾")`：假上游 `end()` 之后，响应 +
`Connection: close` 会在同一轮读取里 push 出 EOF，**删掉那个分支就是挂死**，那条 2s 预算
立刻超时。顺带被同一组锁住的还有「严格取状态码、仅 101 视为升级成功」——
`302` + `Content-Length: 1010` 与 `200 OK` + `Content-Length: 101` 都不许被子串误判。

⚠️ **这两条与 `connector-wiring/` 的 ①–⑤ 不是同一件事，不许合并**：那五条讲的是**接线**
（文件 / 类名、守卫前缀、client 模式是否经连接器层、凭证注入判据、护栏归属），这两条讲的是
**两个转发器内部的收尾分支**。它们共用 `TunnelForwarder` / `WsForwarder` 这两个类，但那只是同一批
被测对象的两个切面 —— 按「同一批文件」合并会把两条互不相干的推理塞进一个编号段，
而下一个人找「401 那条为什么回 400」时会连着读五条接线决策。

## `http-via-socks` 的 A/B/C/D 四档

⚠️ **这四档的判据住本文件而不是那个档的头**，因为 `contract/` 决策 ③ **逐字点名了 D 档**
（「超时 → 504 那一半」）—— 一段被另一个目录的共享决策引用的判据，留在一个档的头里就是
「读者要翻遍 28 个文件才找得到」，而本文件就是那个索引。

- **A：socks5 上游 → 真实 http 源站（普通 GET）**
- **B：chunked 请求体经 socks5 上游到达源站且解析正常**（请求体重新分帧回归）
- **C：sockss5（SOCKS over TLS）上游承载同一握手逻辑**，回归「被误当 https 上游发 HTTP 请求行」缺陷
- **D：TLS 上游握手卡死 → 拨号超时回 504**（established 提前清除超时的回归）

⚠️ A/B/C 共用 `beforeAll` 建的那**一个**代理实例，而它们逐档 `set("upstreamProtocol", socks5|sockss5)`
—— 生产那份记忆化连接器源在这里用不得（它会把 A 档的 socks5 粘死，C 档拿到 socks5 连接器 → 502），
故那一档就地造了一份**现读**实现。D 档自己构造转发器，协议在构造前就定死，两种实现都对。

## 子进程（spawn 真 `dist/app.js`）那一套：⚠️ 唯一真相在 `tests/helpers/child-proxy.ts`

⚠️ **本目录任何文件都不许复述子进程隔离的推理。** 三档用子进程
（`http-request-line` / `http-chain-forward` / `http-chain-tunnel`），「为什么 cwd 必须在仓库之外」
与「为什么按需剔除继承来的 env」两条住在 `tests/helpers/child-proxy.ts` 的文件头「两道隔离，缺一不可」
一节里，那一份是超集（另含 `assertKnownKeys` 的 fail-closed 更正与 `stripEnv` 的申报口径）。
同节还管 `ensureDistBuilt`（构建保鲜，且**以 `dist/app.js` 的 mtime 是否刷新为准，不迷信 exit code**）。

⚠️ **档里只留「本档会传的 CLI 覆盖对应的 env 键」那一行**（`http-request-line.test.ts` 的
`STRIPPED_ENV`）—— 哪些键要剔只有调用点知道（它才知道自己会传哪些 CLI 覆盖），而
「不申报就是全盘继承」是一个**显式选择**而不是默认干净。

## 文件头形态（⚠️ 唯一口径）

平铺档、子目录档、fixture 一律：

```
/**
 * <这一档钉什么>：<覆盖面，逐条编号时用编号>。
 *
 * <为什么这么写>：<判据形状的理由 / 变异实测 / 已知取舍>。
 *
 * <分工与指向>：<邻档分工>；<共用装配面 → ./xxx-fixture.ts>。
 *
 * @module tests/integration/forward[/<主题目录>]
 */
```

四条硬规矩，每条都有它要防的东西：

1. **第一行必须是 `/**`，不出现裸 `import`** —— 打开文件先看到的是「这一档在测什么」，
   而不是一个 `vitest` 的 import。
2. **摘要用无 tag 的散文，`@fileoverview` / `@description` 只在 `src/**` 的文件级用**。
   ⚠️ 本仓 `src/**` 与 `packages/tui/src/**` 的多数文件都在用这两个 tag（`src/**` 里也有一小部分
   刻意用散文摘要），而 `tests/**` 的口径是散文摘要（`tests/integration/` 下的 `upstream` /
   `logging` / `quota` / `acl` 四族全部如此，`packages/tui/tests/agent/` 亦如此）。
   同一仓库两套口径不是问题，**同一目录两套才是**。
   ⚠️ fixture 里**导出符号**的 `@description` 不受这条约束 —— 那与文件级摘要不同层。
3. **`@module` 的值是主题目录**（`tests/integration/forward`、`.../contract`、`.../connector-wiring`、
   `.../outbound-header-rewrite`），不带扩展名。⚠️ 它报的是**主题身份**而不是文件身份 ——
   「这几档属于同一主题」这件事已经由目录与本文件表达了，再让 `@module` 逐文件重复一遍
   只是多一层壳。⚠️ `tests/integration/{inbound,runtime}/` 报的是档名（那一半不在本目录的
   授权范围内，不动它们）。
4. **必须点名「共享的归哪」**：至少一条指针 —— 共用装配面 → `./<fixture>.ts`、邻档 → 邻档文件名。判据是**共用档数**，不是「顺手提一句」。

## 防假绿的位置

- **`tunnel-guard` 的 ② 是「挂死型」牙齿**：删掉 `readableEnded` 分支不会让断言拿到错误值，
  而是让两条非 101 用例在 2s 预算上**超时** —— 它绿不了，但也**慢**。同理 `waitUntil` 超时会抛，
  故这一组必须与「正常路径」同批跑，否则「全部超时」会被误读成「环境坏了」。
- **`upgrade-*` 两档的「恰好一条」自带一拍静默**：`waitUntil` 之后 `sleep(120)`。
  去掉那一拍，「零条」与「重复发在同一轮里 push」两种形态的判据会同时落空。
- **⚠️ `http-client-node-upgrade` 的 `it.skip` 是有意保留的**，不是待办：明文 ws 经 http 代理的
  Upgrade 通道在**本地**回声桩上 flaky（101 之后透传与桩的分段时序耦合），且**与外网零耦合**。
  覆盖由同档的 wss 经 CONNECT+TLS 那条承担 —— 但它覆盖的是 **CONNECT+TLS 承载，不是明文
  Upgrade 路径本身**（这个记账必须留着，否则下一个人会以为「两档都绿 = 明文路径验过了」）。
  桩与断言全部保留（仍由 `describe` 级的 `beforeAll` 建起 / `afterAll` 收尾），只是不参与运行。
- **⚠️ 三处「直构 core」的档共用同一份警告**：`testServices()` 里 `access` **必须**是真名单判定
  （接上放行档等于把目标名单 / 上游路由名单判定静默废掉），而 `identity` 取显式 inert 档是安全的
  （这些档不走鉴权，直构转发器更是拿不到准入层）。抄错这两个的形态是**静默的**：判据照样跑，
  只是被测的那条护栏已经不存在了。
- **⚠️ `http-upstream-protocol` / `http-via-socks` 的「现读连接器源」是判据的前提而不是实现细节**：
  沿用生产那份记忆化源，第一条走上游的用例就把协议粘死、后两条全 502 —— 症状是「后两条红了」，
  与「协议取值没生效」在现象上分不开，故那个前提必须写在档里。

## 相关路径

- `src/core/forward/channel/{http,tunnel,upgrade,socks}.ts` — 四条通道；`upgrade.ts` 的
  `preDialPeerTarget` 与 `relay` 的 `readableEnded` 是上面两条决策的牙齿所在。
- `src/core/forward/upstream/connector/**` — `targetForm` / `upstreamAuthHeader()` /
  `settleDialFailure`（`contract/` 五行表的「判据来源」列逐字指向这里）。
- `src/core/helpers/{self-loop,predial,route}.ts` — 自环判定、拨号前置守卫、路由事件。
- `src/core/helpers/headers.ts` — `sanitizeHeaders` 与 `applyOutboundRewrite`
  （出站净化的 ⑤ 与 `outbound-header-rewrite/` 那六条契约都在这条链上）。
- `../../helpers/child-proxy.ts` — spawn 子进程那一套（两道隔离 + 构建保鲜）。
- `../../helpers/public-hosts/integration-forward-{flat,contract,ohr}.ts` — 本目录零外网白名单
  三片（`flat` 那 3 条分别在 `tunnel-guard` / `http-via-socks` / `http-upstream-protocol`，
  都是**伪 req 的入参文本**，真实连接打的是本机空闲端口）。
- `../../unit/meta/no-external-network.test.ts` — 零外网扫描的行为面断言。
- `../../AGENTS.md` — `tests/integration/` 的目录级说明。