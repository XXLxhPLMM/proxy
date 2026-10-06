# tests/integration/inbound/ — 入站 server 类（`HttpProxy` / `Socks5Proxy` / `HttpsProxy`）+ 准入关卡

本目录只答一件事：**入站那一侧**（准入关卡顺序、握手字节、mTLS 准入、keep-alive 与上游生命周期解耦），
**哪几处不许漂**。全部走真 server 类挂空闲端口、真实收发字节。
出站那一侧的判据在 `forward/`，上游协议与证书四态在 `upstream/`。

## 准入的关卡顺序（本目录两张档共用这一张图）

入站准入被收成两阶段之后，最容易出的错不是「少判一关」，而是**关卡的相对顺序悄悄变了**：
① 名单必须在鉴权**之前**（被禁来源不该消耗鉴权资源，也不该让客户端有机会带凭证）；
② 鉴权必须在目标名单**之前**（没有身份就没有「该用户的个人名单」可判）；
③ 两阶段之间若发生拒绝，**对应的 `PipeEvent` 与终态必须已经发出去**
（否则日志面与 `request.rejected` 会凭空少一条，而请求确实被拒了）。

SOCKS 与 HTTP 的**唯一结构差异**是「握手夹在第 ① 与第 ② 关之间」——这正是不能把它写成
「一函数走完三关」的原因。那两张档把这个差异**钉成可观测的顺序**：
客户端**还没看到握手应答字节**（`05 02` = 选定 USER_PASS）之前，代理**不许**发出 `auth.decided`。
那条断言是可证伪的：把鉴权提到握手之前（或者干脆把握手从流程里拿掉），它立刻变红。

观测手段：一条**专属** `EventHub`，把 `pipe` / `auth.decided` / `request.rejected` /
`access.client-denied` / `access.target-denied` 按**发生顺序**记成一条时间线。

## 两条准入结构的决策（`admission-order-{http,socks5}` 两档锁的就是这两条）

**① 准入是**两阶段**，`admitClientIp` / `authenticate` 两个方法**各自保留**，SOCKS 的握手
夹在阶段 A 与鉴权之间。** 为什么不「一函数走完三关」、也不把方法名改成端口方法名
`checkClient` / `identify`。前者是把「连接内的字节状态机」硬合并进通用流程——那条断言
（见下）是可证伪的：把握手从流程里拿掉、或把鉴权提到握手之前，它立刻红。

锁点全是**逐条 `toEqual` 的时间线**，不是「至少发生过」：
- HTTP 侧：名单拒 → `["pipe:ip-denied", "access.client-denied", "request.rejected"]` 且
  `expect(authDecided(marks), "被禁来源不得进入鉴权（连可用凭证都不许被消费）").toEqual([])`；
  鉴权拒 → `["auth.decided", "request.rejected"]`；目标名单拒 →
  `["auth.decided", "pipe:target-denied", "access.target-denied", "request.rejected"]`。
- 「鉴权没过就不许出现任何 target-denied」那条把顺序反了的**直接后果**也钉死
  （`not.toContain("pipe:target-denied")`）。
- ⚠️ 名单拒那两档**必须开着鉴权**并带**正确凭证**（最强的形态：连可用凭证都不许被消耗）。
  关鉴权时身份提供者直接放行且不发审计事件，时间线里根本没有 `auth.decided` 这条痕迹，
  「把名单判定挪到鉴权之后」就**完全看不出来**（本节与两处用例注释都记了这个已实测的假绿）。
  这是这两档最容易退化成恒绿的地方。

⚠️ **方法名这一半没有断言**：把两个方法改名成端口名不会让任何用例变红，它靠的是本节与调用点
的名字本身。理由写在这里是因为它防的正是「看成薄委托」那个误读：阶段 A 的返回值要**立刻**喂给
「发 `ip-denied` / 写协议应答 / 结算 `access` 终态」这一整串**同步**收尾，所以它**不能**被
`await`；**收包不影响同步性，但收成裸函数就一定会有人把它写成 `await`**。

**② `socks-base.ts:onConn()` 的第一件事是造 `InboundAdmission` 并过阶段 A**（拒绝走 `pipe` 的
`ip-denied`，与 http 同形；`respond` 是 `socket.destroy()`，SOCKS 侧 `rejectedStatus` 恒
`undefined`，故终态 detail 记作 `access/-`）。为什么不「先握手再判 IP」——那等于让**未授权方**
把连接内状态机跑一遍。锁点：SOCKS 侧那条「① 名单拒（开着鉴权）→ 握手之前就断流」——
`expect(got.length, "被禁来源不得收到任何握手应答字节").toBe(0)`，且
`expect(authDecided(marks), "握手都没开始，不得进入鉴权").toEqual([])`。
客户端**照常发 greeting**（`[0x05, 0x01, 0x00]`），代理一个字节都不许回；「先握手再判 IP」会让
`got.length` 变成握手应答的长度 → 红。握手后的 `authorized` 兜底是保险，主力是这条阶段 A。

另一侧的结构差异钉成可观测顺序的，是「握手应答字节先于鉴权出现」那条：客户端看到 `05 02`
（选定 USER_PASS）那一刻，`auth.decided` 仍须是 0 条 ——
`expect([...select.subarray(0, 2)]).toEqual([0x05, 0x02])` 与
`expect(authDecided(marks), "鉴权必须等握手把凭证载体准备好之后才发生").toEqual([])`。
而 `authenticate` **只覆盖「凭证判定不通过」**（reason 恒 `"proxy-auth-required"`、stage 恒
`"auth"`）：非法 SOCKS4 报文 / 非法 RFC1929 帧 / 非法 greeting 那类**不是凭证判定**的拒绝仍归
`socks-session.ts` 的状态机，所以时间线里它们**不该**出现 `auth.decided`。

## 入站 keep-alive 与上游生命周期解耦（`keepalive-decoupled.test.ts` 那一档）

回归点：出站 socket 由 `UpstreamConnector.transport()` 建立，而 `transport()` 内部的拨号守卫
（`guardDialing`，**为隧道设计**）带着 `upstream.on("close") → client.destroy()`
这条**上下游存活联动**，**不得**套到 **http 普通请求路径**上。套上去的后果是：

```
客户端在同一条入站 keep-alive 连接上连发请求
  → 源站响应后关掉自己的连接
  → 守卫的 upstream close 触发 client.destroy()，打死**入站**连接
  → 客户端每个请求都被迫重连（实测 reusedSocket 恒 false、入站 TCP 连接数 = 请求数）
```

不可接受的理由：入站 server 支持 keep-alive 是**与上游连不连得上完全无关**的客户端侧
属性。让上游的存活决定客户端连接的命，是把「隧道语义」漏进了「请求语义」。

### 本档锁住的两条决策（结论 — 为什么）

**① `clientLifetime: "independent"` 只服务 http 请求路径**（端口在
`forward/upstream/connector/types.ts`）。为什么三条隧道路径不用 independent——
守卫的 `upstream.on("close") → client.destroy()` 是**隧道语义**：CONNECT / upgrade / SOCKS
里 `ctx.client` 与管道确实是同一资源的两端（`bridge()` 双向 pipe），解耦会让「上游已死、
客户端还在等字节」变成挂死。而在请求路径上，源站关掉自己的连接**不该**打死入站
keep-alive（实测会出现客户端 `reusedSocket` 恒 false、第 2 个请求吃 ECONNRESET）——
**入站连接的存活是客户端侧属性，与上游连不连得上无关**。
牙齿分两面：正面是本档 ①（`expect(second.reused).toBe(true)` /
`expect(second.socket).toBe(first.socket)`）；反面是本档末尾那条 CONNECT 隧道用例
（`await collector.waitClose(2000)` + `expect(sock.destroyed).toBe(true)`）——把隧道也改成
`independent` 会让客户端那一端挂死，那条立刻红。形状面另有
`tests/unit/core/guard/client-lifetime.test.ts` 的 `linked` / `independent` 两组替身用例。
- 附带事实：`"independent"` 形态下守卫的**客户端侧**监听随上游 socket 的 `close` 摘除。
  不摘的话入站是长连接、每请求挂一对 → 20 个请求累积 22 个 `close` 监听。挂
  `upstream.close` 可靠：出站恒带 `Connection: close`，Node 在响应收尾时必定销毁
  `createConnection` 提供的 socket（源站遵守或不遵守都一样）。牙齿是本档 ② 与
  `guard/client-lifetime.test.ts` 的「上游关闭后摘除客户端侧监听」那两条。

**② ⚠️ 面向运维的已知特性：本代理不复用上游连接，每个转发请求新建一条上游连接。** 实测
同一源站连发 N 个请求 → 源站侧 N 条 TCP 连接，且源站看到的 `Connection` 恒为 `close`
（即使源站本身支持 keep-alive）。**成因与取舍**：`Connection: close` 由 `sanitizeHeaders`
无条件强制，而出站传输层由连接器/守卫掌管（每请求新建 socket + 拨号守卫 + 每 socket 空闲
超时），**池化与这套传输层管理不兼容**（池里的 socket 无法逐个绑定请求作用域的守卫与超时，
且流量计量还要在这些 socket 上包一层）。**这是自觉的性能取舍，不是缺陷**——入站
keep-alive 不受影响（本档 ① 就是入站那一侧仍然可用的证据）。**不要**以「复用连接省
资源」为名去掉 `Connection: close` 或引入 agent 池。牙齿 = 本档 ① 里的
`expect(origin.conns()).toBe(2)`（2 个请求 = 2 条源站连接；引入连接池它会变成 1）。

反向护栏（本档末尾的第二个 describe）：**隧道路径的联动必须原样保留**——
CONNECT 隧道里客户端与管道确实是同一资源的两端，目标一关客户端那一端就得跟着断，
不许被「顺手统一」成请求路径那套解耦。

### 观测口径

全部走行为侧（客户端 `reusedSocket`、两端 socket 身份、入站连接数、监听数、
pipe 事件），不做白盒断言；唯一的内部触达是 `ProbeProxy` 子类读 protected 的
`server` —— 那是**只读观测钩子**，不改任何行为（与「断言 `ConnRegistry.conns` 是
private、只从行为侧断言」不冲突：这里不断言任何内部状态，只挂观测回调）。

### 本节的相关路径

- `src/core/forward/upstream/connector/types.ts` — `clientLifetime: "independent"` 那个端口。
- `tests/unit/core/guard/client-lifetime.test.ts` — `linked` / `independent` 两组替身用例（形状面）。

## 相关路径

- `src/core/server/{http,socks5,socks4,socks-base}.ts` — 入站 server 类与 `InboundAdmission` 的
  阶段 A / 鉴权两段。
- `src/core/server/socks-session.ts` — 非法 SOCKS 报文的拒绝为什么**不**发 `auth.decided`。
- `tests/helpers/{net,config,proxy,certs,access,socks-client}.ts` — 本目录五个档用的脚手架。

⚠️ **只服务一档的相关路径也归那个档的文件头**（`src/utils/tls/` 归 `tls-client-auth`）——
理由同上：路径的**影响面**与那段推理一样是一档。
