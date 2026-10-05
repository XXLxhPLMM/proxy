# tests/integration/upstream/ — 「走上游」这一圈（`upstreamProtocol` 六档 + 证书四态）

本目录只答一件事：**入站协议 × 上游协议 × 证书有无** 这一圈里，哪几处不许漂。
机制归 `src/core/forward/upstream/connector/` 与 `src/core/server/` 的文件头；
这里住的是**本目录多档共用**的那些不变量（矩阵那十档占大头）。

## 矩阵覆盖目标（全本地桩，不依赖外网）

- 上游 6 种协议：`http` / `https` / `socks4` / `socks5` / `sockss4` / `sockss5`
- 证书四态：配 CA（通过）/ 无 CA（自签上游必须失败）/ CA 文件缺失（回退系统库→失败）/ insecure（跳过校验）
- 入站 6 种：`http` / `https` / `socks4` / `socks5` / `sockss4` / `sockss5`（6 × 6 = 36 档全网格）
- 三类转发路径：absolute-form（http 入站）、CONNECT 隧道（隧道/upgrade 路径）、SOCKS 隧道（socks/sockss 入站）

「协议/请求形态」不只断言状态码：**F)~J) 一律走 `helpers/upstream-stub.ts` 的可观测桩**，
除「目标收到了响应」外，还断言上游确实收到了本角色的协议报文（CONNECT 行 / absolute-form 行 /
SOCKS4 CONNECT / SOCKS5 greeting）与正确的目标三元组；TLS 上游另断言握手确实完成（协议/cipher/SNI）。

## 分组索引（⚠️ 文件名就是契约，写错会静默少判一档）

`matrix-g-sockss4` 与 `matrix-h-sockss5` 差一个字符。

| 档 | 钉哪一格 |
|---|---|
| `matrix-a-http.test.ts` | `A) http 入站（absolute-form 串联）` |
| `matrix-b-connect-tunnel.test.ts` | `B) CONNECT 隧道（隧道转发路径）` |
| `matrix-c-https.test.ts` | `C) https 入站（TLS 下游 × 各上游）` |
| `matrix-d-socks5.test.ts` | `D) socks5 入站（SOCKS 隧道 × 各上游）` |
| `matrix-e-socks4.test.ts` | `E) socks4 入站` |
| `matrix-f-gap-fill.test.ts` | `F) 补档：既有入站缺失的上游组合`（A)~E) 未覆盖的格子） |
| `matrix-g-sockss4.test.ts` | `G) sockss4 入站（TLS 承载 SOCKS4）× 六上游` |
| `matrix-h-sockss5.test.ts` | `H) sockss5 入站（TLS 承载 SOCKS5）× 六上游` |
| `matrix-i-tls-byte-level.test.ts` | `I) 真实 TLS 上游通路（字节级）` |
| `matrix-j-cert-states.test.ts` | `J) 上游证书四态（配 CA / 无 CA / CA 文件缺失 / insecure）` |

## 连接器源必须现读（`matrix-fixture.ts` 的 `liveConnectors()`）

生产默认实现 `createConnectorSource(ctx)` 把「走上游」**记忆**在一份 source 上，
正确性挂在「`UPSTREAM_PROTOCOL` 是 startup 相位、accessor 对它读冻结值」这条不变式上——
真实 runtime 里一份 source 终身只对应一份协议。

⚠️ 本矩阵的前提是它不成立的：十档全部共用 `matrix-fixture.ts` 的 `beforeAll` 里那 **6 个入站代理实例**，
却逐用例 `set("upstreamProtocol", …)` 轮换 6 种上游。沿用记忆化那份会让**第一条走上游的用例把协议粘死**，
后续全部测到第一条的连接器 —— 症状是「第一条绿、其余全红」。

故每次问都现造一份。`ConnectorSource` 是**端口**，「记忆化」只是默认实现的一个选择而非契约；
fixture 实现的是同一端口的另一个合法选择（现读档），与「每请求 `connectorFor(protocol, config)`」
逐字同形 —— 也就是这几十条断言观察的语义。

## 为什么 fixture 住本目录而不是 `tests/helpers/`

`tests/helpers/external-network-scan.ts` 的 `SCAN_DIRS = ["unit","integration","library"]`
**不含** `helpers/`，而 `walk()` 收目录下**全部** `.ts`（`.test.ts` 与否一视同仁）。
把含建链位或公网 host 字面量的东西搬进 `helpers/` = 那部分覆盖**从零外网扫描里静默消失**，
而 `tests/unit/meta/no-external-network.test.ts` 的两条下界断言（`sites.length > 30`、
`refs.length >= 50`）照样绿。故 `matrix-fixture.ts` 里那个
`headers: { Host: "example.com" }`（`httpViaProxy`）必须在本目录里申报。

## 零外网白名单

`tests/helpers/public-hosts/integration-upstream.ts` 是本目录那一片。纪律三条见
`tests/helpers/AGENTS.md` 的「`public-hosts/`」一节：`reason` 答「为什么它不建链」、
**零公网字面量的档不建条目**、同一 `(file, host)` 对不许出现两次。

现有 4 条（16 个文件里的 4 个）：`matrix-fixture.ts` / `matrix-a-http.test.ts` /
`matrix-c-https.test.ts` / `matrix-i-tls-byte-level.test.ts`，host 都是 `example.com`。
其余 **12 个文件零字面量，一个条目都不建**（`matrix-f-gap-fill.test.ts` 里那处 `example.com`
在注释里，`codeOnly` 会剥掉）。

## 非法 `upstreamProtocol` 的 fail-closed 安全属性（`fail-closed.test.ts`）

非法 `upstreamProtocol` 的兜底形态**只有 fail-closed 抛错一种**：
`forward/upstream/connector/registry.ts:resolveUpstream`（经 `ConnectorSource.upstream()`
暴露）在请求期抛。

**理由是「静默降级直连 = 流量旁路」**：对一个代理服务，「上游协议配错 → 全部静默直连」意味着
流量绕过上游直出，外部表现是「服务还在跑、请求还成功、但根本没走你配的链路」——
比直接报错糟糕得多：报错至少让运维知道配置错了。

**非法值在库路径上真的可达**：CLI 路径的 `upstreamProtocol` 确实经 `FIELDS.parseEnum`
fail-fast，但**库路径不经**——`createProxyRuntime({ config })` 走 `new ConfigStore(...)`，
而 `ConfigStore` **零校验**（不跑 FIELDS 的解析/范围/交叉校验），非法值能被直接注入。
`fail-closed.test.ts` 就从库路径注入 `"ftp"`，把「可达」这件事变成可执行的事实。

**不要以「增强健壮性 / 保持连通」为名把静默兜底加回来。** 想要健壮，正确的位置是
**配置校验层**（`loadConfig` / 纯内存 runtime 的构造期校验），让它启动就报错，
而不是让请求期偷偷换一个上游形态。

### 它与「入站协议构造期抛」是**两个**出口，不是一个决策的两半

`ConfigStore` **零校验**是这件事的前提，于是非法枚举在库路径上有两个落点，各留各的：
① **入站 `proxyProtocol` 由 `runtime.ts:protocolFor(config)` 在构造期抛**（覆盖只改变**用哪个
值**、不改变**是否校验**）——那半边的判据在 `tests/unit/runtime/assembly.test.ts`（那条 describe），
包括「`protocolFor(config)` 必须排在 `assembly?.protocol` 判定之前」这条源码级次序断言；
② **上游 `upstreamProtocol` 由 `fail-closed.test.ts` 在请求期抛**（fail-closed，即那档）。

为什么不让 `ConfigStore` 跑 FIELDS 校验：它是纯存储，跑校验就得引入解析 / 范围 /
交叉校验那整套，让「存」与「验」耦在一起。而**两个出口都要留着**，因为它们覆盖的是**不同
的值**（一个决定建哪种服，一个决定怎么到达 dest），漏掉任一个就是一条静默旁路。

⚠️ **别把「① 已经启动就报」误读成「② 也可以前移」**——前移会让 `forward.error` 这条安全
事实从事件流里消失：静默降级直连 = 流量旁路，报错至少让运维知道配置错了。
反过来也别把 ② 挪到别处「顺手统一」——`fail-closed.test.ts` 每一条用例都从库路径注入非法值
并断言「源站零字节、客户端拿不到 200、表现为 `forward.error`」，改判据位置或恢复兜底任一条都立刻红。

### 本档锁住的两条决策（结论 — 为什么）

**① 未知 `upstreamProtocol` 的兜底形态只有抛错一种。** 为什么不「降级 direct 保连通」——
对一个代理服务，「上游协议配错 → 全部静默直连」意味着流量**绕过上游直连出**，外部表现是
「服务还在跑、请求还成功、但根本没走你配的链路」。这比直接报错糟糕得多。牙齿 = 「库路径
注入非法协议」那条的后两行：`expect(origin.received()).toBe(0)` 与
`expect(status).not.toBe(200)`——**静默直连的外部表现恰恰就是源站收到字节、客户端拿到
200**，那两行就是「不许降级」的可执行形式。（成因那一侧另有一行
`String((e as Error)?.message ?? "").includes("unsupported upstream protocol")`。）

**② fail-closed 的抛点固定在请求期**（裁决：**不**前移到装配期）。理由三条各自成立：
① 前移会让那档断言的 `forward.error` 事实**消失**、变成启动期异常——**那是换掉一个安全
属性，不是加固它**（一条都没发出去的代理比一条 `forward.error` 更难定位是哪个请求撞上了
完整配置）。**这条的牙齿就是 `await startRuntime({ … upstreamProtocol: "ftp" })` 那一行
本身**：`startRuntime` 走 `createProxyRuntime({ config })`，抛点一旦前移到那里，那条用例会在
拿到任何断言之前就 reject。② `proxyMode: "server"` 下有效路由恒 direct、`upstream()` 一次都
不会被调，装配期就为它抛等于让「上游字段填错」打挂一个压根不上游的服务。③
`createConnectorSource` 拿不到 `configDir`、也不该知道「这是一个 runtime 的装配根」。

## 防假绿的位置

- **fail-closed 那档的「不许降级」钉在源站零字节上**：`expect(origin.received()).toBe(0)`
  与 `expect(status).not.toBe(200)` 一起才是「静默直连不成立」的可执行形式 —— 单钉状态码的话
  「先拒再照发」那种接线照样全绿。⚠️ 上游端口刻意指向一个**死端口**：即便有人加回「降级 direct」，
  它也只会拨那个死端口，于是「静默直连」不可能表现为成功，断言落在源站那一侧而不是连通性上。
- **`SIX_UPSTREAMS` 与它依赖的规格表住在 fixture，不住在任何一档**：它定义在「`E)` 那一段的行号范围里」，
  按「切 describe 块」的直觉切分极容易把它留在 `matrix-e-socks4.test.ts`，
  于是 `matrix-g` 与 `matrix-h` import 一个不存在的导出 → **运行期 `undefined`**，
  而 `it.each(undefined)` 报出来的错与真实病因毫无关系。
  ⚠️ 故 `SIX_UPSTREAMS` 的唯一出口是 `grep -rn "SIX_UPSTREAMS" tests/integration/upstream/`：
  必须**只在 `matrix-fixture.ts` 里定义一次**，别处只有引用。
- **端口句柄是 `export let` 而不是 `const`**：`it.each` 的表在**收集期**求值，早于 `beforeAll`，
  所以端口必须走 `() => httpUpPort` 这种闭包 —— 表格里存的是闭包而不是当时的值。
  抄表时把 `() => …` 改成裸值，全部上游档会静默拨到 `0`。
- **`stub()` 与 `expectUpstreamSaw()` 也在 fixture**：F)~J) 全部走可观测桩，
  而 A)~E) 走前导段里那批自建桩 —— 两套桩**故意不同**（前者能断言上游收到的字节，后者不能）。
- **「自签被拒」的判据是「零应用层会话」而不是「没有 200」**：
  `expect(s.connections()).toBe(1)` + `expect(s.sessions()).toHaveLength(0)`
  证明「失败点在 TLS 校验」而不是「压根没建链」。只断言 502 的话，
  「没建链」与「建链后被拒」会一起通过。

## 相关路径

- `matrix-fixture.ts` — 十档共用的桩 / 端口 / `applyUpstream` / `SIX_UPSTREAMS` /
  模块级 `beforeAll`·`afterEach`·`afterAll`（`.ts` 非 `.test.ts`，vitest 不收集）。
- `full-matrix-fixture.ts` — `full-matrix-{http,socks}` 两档共用的目标源站、curl harness、
  裸 SOCKS 客户端（server 模式鉴权真值表，零公网字面量）。
- `fail-closed.test.ts` — 非法 `upstreamProtocol` 的 fail-closed 安全属性（另半个出口在
  `tests/unit/runtime/assembly.test.ts` 那条 describe；**两条决策与两个出口的分工在本文件**
  「非法 `upstreamProtocol` 的 fail-closed 安全属性」一节）。
- `socks-upstream-handshake.test.ts` — `Socks5Connector` 上游握手（分段余量交接 / 用户密码认证）。
- `../../helpers/upstream-stub.ts` — 可观测上游桩（角色 + 承载 + 协议报文取证）。
- `../../helpers/certs.ts` — 仓内测试 PKI。
- `../../helpers/net.ts` — `getFreePort()`（⚠️ listen(0) 再 close，有 TOCTOU 窗口）。
- `../../helpers/config.ts` — `set` / `testContext` / 配置快照。
- `../inbound/tls-client-auth.test.ts` — **入站**侧 mTLS 的档；矩阵一律固定跳过入站证书校验。