# tests/integration/runtime/ — `createProxyRuntime` / `ProxyServer` 生命周期与作用域

本目录只答一件事：真 runtime 那一圈（**三个注入位 + 请求作用域标识 + 请求终态 + 停机排空**），
**哪几处不许漂**。机制与层不变量归 `src/runtime/AGENTS.md`、`src/core/server/AGENTS.md`
与 `src/core/events/AGENTS.md`；脚手架归 `tests/helpers/AGENTS.md`。

## 文件（⚠️ 不变量 ↔ 位置对照）

- `custom-services-wiring.test.ts` — **三个注入位**（`identity` / `access` / `connectors` 都能被替身整体接管）。
- `scope-ids.test.ts` — **请求作用域标识** `requestId` / `connectionId`，外加下面那两条关联事实。
- `stop-drain.test.ts` — **`HttpProxy.stop()` 的排空预算**（活着的 CONNECT 隧道 + 两个对照组）。
- `request-terminal-events.test.ts` — **请求终态三件套**的 7 条终态枚举（本目录唯一没有独立机制段
  的一档：它钉的是「一个请求恰好一条终态」这一条事实的枚举完整性）。

## 三个注入位：「显式注入优先」在行为面真的成立（`custom-services-wiring.test.ts`）

身份可插值化之后，core 与四条入站通道只认**端口**，永不自己造实现：默认的文件驱动
实现只在唯一组装根 `createProxyRuntime → buildDefaultServices` 解析一次。该档锁那条
「显式注入优先」的承诺**在行为面真的成立**——不是查字段（那是 unit 档的活），而是
起一个真 runtime、走真请求、观察真事件与真字节。

三条各占一个正交的面，缺一条就有一类替换没被证明：

1. **`access` 替身**：自定义实现拒掉一个目标 → 403 + `access.target-denied` 事件带
   **替身自己的 reason**。这条同时钉住两件事：替身真的被调（不是被默认实现遮蔽），
   以及**自由文本 reason 能穿过桥接层**——`AccessDecision.reason` 已从名单的
   `whitelist|blacklist` 闭合集放宽为 `string`，代价由消费方承担（`runtime/bridge.ts`
   的收窄逻辑只认闭合集，表外值**静默不发布**事件）。所以该档用一个**在闭合集之外**
   的 reason（`"quota-exceeded"`）并断言它**确实被发布**——若哪天有人把收窄改严、
   或把 reason 收回闭合集，这条立刻红。
2. **`identity` 替身**：`kind: "apikey"`、`isOwnCredential` 只认 `ApiKey <secret>`
   这一种**自定义 scheme**（内置四模式谁都不认它，故「判据由插件给出」这件事是可证的）。
   断言两件相反方向的事同时成立：替身认的那个 `Authorization` **被剥掉**（不出站），
   而客户端给目标站的 `Authorization: Bearer …` **不被误剥**。后者是该档最要紧的一条——
   `isOwnCredential` 是必填无缺省的端口成员，判据由**插件自己**给出；若 core 仍在
   从 config 猜「哪个 Authorization 是本代理的」，自定义凭证形态必然失配，
   后果不是「剥多了」而是**代理自己的凭证被原样转发给目标站**（凭据泄漏）。

   ⚠️ 凭证走**标准 `Authorization` 头 + 自定义 scheme**，不是自定义头名——这是端口的
   既定契约（`IdentityProvider.isOwnCredential` 的 JSDoc：「非 `authorization` 一律
   `false`」，`proxy-` 前缀由 `isProxyHeaderName` 那条独立宽规则管）。故凭证形态的
   可插值性体现在 **scheme 与值的形状**上，那才是该档要验的面。
3. **`connectors` 替身**：`upstream()` 返回一个只认固定目标的连接器，`direct()` 恒抛错。
   断言 client 模式的请求**真的走了替身**（替身侧桩收到字节、配置里的上游桩零字节），
   证明「上游接入」整条链可换，而不只是字段透传。

全部用真代理 + 真源站 + 真事件总线，不用 mock。

## 请求作用域标识与两条关联事实的归属（`scope-ids.test.ts`）

该档保护的三条不变量：
 - 同一请求的 mid-flight 事件（auth.decided / route.selected / 终态）共享同一个 requestId
 - 不同请求的 requestId 互不相同
 - keep-alive 同一连接的多请求共享 connectionId，但 requestId 各异

### 两条关联事实的归属（`scope-ids.test.ts` 锁的就是这两条）

**① `request.started` 与终态事件的 `context.target` 同源于 `getAuthority(req)`；真实目标要看
`route.selected` 的 context。** 为什么不在 started 里放解析后的 dest：absolute-form 请求下
`getAuthority` 返回的是**客户端写来的代理自身 authority**，那是「它请求了什么」的权威；
「我们解析出要去哪」是**另一个事实**，两个事实不能合成一个。
锁点：「server 模式直连 + 关闭鉴权」那条的
`expect(started?.context.target).toBe(completed?.context.target)` —— 正面证明 started 与终态
**同源同口径**，避免出现「过程说一个目标、结果说另一个目标」。而 `target` 恒为**真值但不带
真实目标端口**这件事由该条注释与 `expect(started?.context.target).toBeTruthy()` 承担；
client 模式下真实目标落在 `route.selected` 的 context（`tests/unit/runtime/bridge/deny-events.test.ts`
的 `expect(events[0].context).toEqual({ runtimeId, protocol, target: "example.com:80" })`）。

**② `request.started` 是公共事件面唯一的非终态请求级事件，走 core 直发。** 为什么不走
bridge、也不干脆不发。终态三件套是**结果**、`started` 是**过程**，缺过程的结果
不可诊断。锁点：同一条用例的
`expect(events.map((e) => e.name)).toEqual(["request.started", "request.completed"])` ——
本用例的部署刻意是 **server 模式直连 + 关闭鉴权**（故既无 `route.selected`、也无
`auth.decided`），于是这条 `toEqual` 正面证明「在这个最常见部署下，中间确实一个锚点都没有」，
所以「唯一」不是自称而是可证伪的。同一组断言还锁住过程与结果**共享** requestId /
connectionId（拼得起来），以及 `started?.data` 逐字只有 `{ kind: "http" }`（身份维度全走
context，payload 不重复承载）。事件面归属（直发不经 bridge）的判据在
`tests/unit/runtime/bridge/forward-events.test.ts`。

另两条边界一并钉在这里：`started?.context.client` 恒为 TCP 对端（本用例 `127.0.0.1`）——
展示口径（`getClientAddress`，可被 XFF 伪造）与判定口径（`getSocketAddress`）**是两个事实**，
合并等于让「能伪造的那个」直接变成「授权判据」；以及 keep-alive 同一连接的多请求共享
connectionId 而 requestId 各异。

## 停机排空：`stop()` 能否 resolve 的唯一决定因素（`stop-drain.test.ts`）

`BaseProxy.closeServer()` = `server.close(cb)` + `registry.drain(server)`。只有当**全部**
连接都真的断开时 `close` 的回调才会触发，于是「排空」这一步是 `stop()` 能否 resolve 的
唯一决定因素：

- **idle keep-alive 连接**：落在 `http.Server` 原生 `closeAllConnections()` 的覆盖范围内
  （对照组用例）。
- **已「升级」的连接**（`connect` / `upgrade` 事件发出后 socket 即脱离 Node 的连接表）：
  **原生 `closeAllConnections()` 不覆盖它们**，只能靠 `ConnRegistry` 逐条兜底销毁。
  `drain()` 走完原生路径就 `clear()` 的话，活着的 CONNECT 隧道会被留在原地，
  `close(cb)` 永不回调 → `stop()` 永久挂起。该档是这条的回归护栏。

断言口径：每条用例都给 `stop()` 一个**明确的超时预算**，超时时抛出带现场诊断的错误，
绝不把失败推给 vitest 的 15s 全局超时（那只会得到一句无信息的 "timed out"）。
端口释放用「同端口重新 bind」从行为侧断言（`ConnRegistry.conns` 是 private，不做白盒断言）。

## 相关路径

- `src/runtime/index.ts` — `createProxyRuntime`（唯一组装根）与 `ProxyRuntime` 的生命周期面。
- `src/core/server/base.ts` — `BaseProxy.closeServer()` 与 `stop()` 的超时预算。
- `src/core/events/index.ts` — `EventHub` 与公共事件面（终态三件套 + `request.started`）。
- `tests/helpers/{net,config,proxy,socks-client}.ts` — 本目录四个档用的脚手架。
