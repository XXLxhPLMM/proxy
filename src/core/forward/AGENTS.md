# src/core/forward — 转发器总纲

**改 `core/forward/**` 任一文件前必读本文件**（两轴目录不变式 + 关键抽象取舍）。细节在三个子目录各自的 `AGENTS.md` 里。

## 路径说明

```
forward/
  base.ts              ← 横跨两轴的公共基类 ForwarderBase，**刻意留在根上**（搬进 channel/ 会让基类依赖自己的子类目录）
  channel/             ← 入站协议轴：http / tunnel / upgrade / socks + 握手读取器 socks-reader
  upstream/
    dial.ts            ← 纯传输层（建链 + 桥接）
    connector/         ← 上游对接轴：四个连接器 + registry + 端口 + barrel
```

| 子目录 | 装什么 | 读它的哪一份 |
|---|---|---|
| `channel/` | 四条入站协议通道 | [`channel/AGENTS.md`](./channel/AGENTS.md) |
| `upstream/` | `Dialer` 纯传输层 + 一个 `connector/` 子目录 | [`upstream/AGENTS.md`](./upstream/AGENTS.md) |
| `upstream/connector/` | 「怎么到达 dest」的唯一抽象 | [`upstream/connector/AGENTS.md`](./upstream/connector/AGENTS.md) |

**不属于本层**：入站建服与派发（`../server/`）、连接器端口与 `CoreServices` 形状（`../types/`）、有效模式的纯判定（`../helpers/route.ts`）、拨号后生命周期联动（`../guard.ts`）。

## 硬约定

- **依赖方向单向**：`channel/**` → `upstream/**`，反向即目录级环。`channel/**` 内部同目录相对，引 `upstream/**` 与 `base.ts` 一律 `@/` 别名。`dial.ts` **不得** import `connector/`。
- **`user` / `requestId` / `connectionId` 只能经 `RequestScope` 参数逐次传入，绝不存成转发器字段。** 四个转发器实例由服务在**构造期**一次组装、跨请求/跨会话复用，而三条身份是逐请求才产生的——存字段就是「A 的请求被记到 B 头上」的串号雷。这条口头约定由 `RequestScope` 的类型签名接管。
- **发事件只有 `scope.emit(e)` 一个入口**（零 `emit` 实例字段、零 `emitWithUser` 方法）；身份维度由 `RequestScope` 携带。`this.emitRoute(...)` 是**路由事件**的独立方法名，与 EventEmitter 无关。
- **构造函数是 `(ctx: CoreContext, services: CoreServices, connectors: ConnectorSource)` 三个都必填**，四个子类都显式写构造函数后 `super(...)`（不靠隐式继承构造），**不收 `PipeEventSink`**（事件槽由 `RequestScope` 携带）。`services` 刻意是一个包而不是三个字段，理由见 `../types/AGENTS.md`（`CoreServices` 打包成一个包，不拆成散装注入位）。
- **请求路径零实例化**：全仓**恰好 4 个构造点**（`HttpProxy` 构造函数 3 个 + `SocksProxyBase` 字段初始化器 1 个）。`server.on(...)` 回调、`handleForward`、`onConn` 与会话处理器体内**不得出现 `new XxxForwarder`**。⚠️ **`src/runtime/event-log.ts:FORWARD_ERROR_LABEL` 里的三个字符串**（`[forwardTunnel error]` 之类）**与「函数式入口同名纯属巧合，不许跟着改**——它们是日志文本契约。
- **`ForwarderBase` 共享面**：`services` / `connectors` / `dialer`（**只服务 `bridge`**）/ `config`（继承 getter）/ `preDial` / `connectorForRoute` / `preDialPeerTarget` / `denyUpstreamLoop` / `denyUpstreamLoopOf` / `settleDenied` / `settleDialFailure` / `emitRoute` / `refuse` / `refuseByCause`。

### 三个入口方法名互不相同，且与 `InboundKind` 逐字对齐

| 入站事件（`InboundKind`） | 转发器 | 入口方法 | 文件 |
|---|---|---|---|
| `"request"` | `HttpForwarder` | `handleRequest(req, res, scope)` | `channel/http.ts` |
| `"connect"` | `TunnelForwarder` | `handleConnect(req, socket, head, scope)` | `channel/tunnel.ts` |
| `"upgrade"` | `WsForwarder` | `handleUpgrade(req, socket, head, scope)` | `channel/upgrade.ts` |

SOCKS 另有两个：`SocksForwarder.serveSocks4` / `serveSocks5Connect`（它不在派发表里，见 `../server/AGENTS.md`）。**没有 `forwardHttp` / `forwardTunnel` / `forwardUpgrade` 三个函数式入口**——入站事件经派发表（`../server/http.ts:buildInboundChannels` 的 `dispatch` 闭包）直接调用转发器实例的入口方法，而实例由服务在**构造期**用三参 `constructor(ctx, services, connectors)` 一次建好、跨请求复用，**请求路径上零 `new`**。低层调用方（几处护栏测试）直接构造实例并调入口方法。

## 前置接线收在基类（窄抽的五个方法）

`channel/*.ts` 里不出现「选连接器」与「补判 preDial」这两件事：

| 基类方法 | 收的是什么 | 调用点 |
|---|---|---|
| `connectorForRoute(route)` | 按有效路由选连接器（三元式，两行） | 四条通道各一处 |
| `preDialPeerTarget(req, connector, targets, deny, scope)` | 传输对端 ≠ 有效拨号地址时补判一次 `preDial` | `http` / `upgrade` |
| `settleDenied(status, scope)` | 守卫拒绝的终态映射（403 → `target-denied`/access，其余 → 自环 `fail`） | 四条通道的 `deny` 闭包 |
| `settleDialFailure(respond, err, scope)` | 拨号失败的「协议应答 + `fail(stage:"dial")`」 | 四条通道的 catch |
| `denyUpstreamLoopOf(connector, respond, scope)` | 上游自环预检的接线半边 | `tunnel` / `socks` |

**刻意留在各通道的**：四种应答形态、`upstream-error` 的文案与**是否带 `err`**（tunnel 靠守卫已发过、socks 那条不带）、`isSocksTunnel(connector)`（现只服务 upgrade 的 `"via socks "` 失败日志尾巴，报文形态归 `connector.targetForm`）。`settleDenied` 只有两个分支不是遗漏——`guardPreDial` 只有 403 与 502 两个调用点，400 那条拒绝走各协议自己的解析失败路径，不经 `deny` 闭包，故任何「顺手也判 400」的分支都是**不可达**的。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

> 已被测试断言锁住的决策不在这里——它们的「结论 + 否掉了什么 + 为什么」写在**那条断言自己所在的测试文件的头注释**里（判据：`tests/unit/forward-directory-layout.test.ts` 的 `@description`）。本清单只留**没有任何测试会红**的纯设计取舍。

1. **不建「协议应答层」** — 否掉「把 4 个调用点的应答统一成一层」— **4 个调用点、4 种载体形态**：`ServerResponse`（`channel/http.ts:failEarly`）、裸 socket 写预拼状态行再 `end`（`base.ts:refuse`）、裸 socket 写 8 字节二进制 + **延时销毁**（立即 destroy 会让应答来不及发出）、「原样透传上游 Buffer 后**不**断链」。要统一需要覆盖的离散参数位远超调用点数，而 **4 个调用点里只有 1 个用到完整组合**，其余三个都要为一层抽象传一堆标志位——**典型假抽象**。
   - **判定标准（写进文档以免下一个人重新推导）：抽象要等出现第二个同样形状的用例才做；一个用例撑不起抽象。**
   - **与前置接线收口不矛盾，区别在粒度**：收口那条收的是**逐字同形的骨架**（守卫接线、终态映射、拨号失败收尾），本条收的是**形态不同的应答本体**。窄抽时 `settleDialFailure` / `settleDenied` 都只收骨架、把 `respond` 作为闭包传进来——那正是本条要求的样子。
   - **何时可重新考虑**：某个载体形态出现**第 2 个**调用点，且两者逐字同形（不是「语义相近」）时，**只抽那一种载体**，不要建统一层。
2. **不建 `forward/pump.ts`** — 判据：它要收的「回灌余量 + 计量 + 桥接」**已经是唯一一份**（`base.ts:bridgeWithBuffered` + 两个 meter 工厂 + `Dialer.bridge`，三个调用点全走它，零重复）。**唯一剩下的两条旁路都套不上 `Duplex` 管道**：① `http.ts` 是 `upRes.pipe(res)`（`ServerResponse` 形态）；② upgrade 首批载荷走**本通道自己的** `upstream.write(head)`，补记口仍在 meter 上。**何时可重新考虑**：出现第三条**不经 `bridgeWithBuffered` 的裸 socket 补记**。
3. **核心工具都在 `@/core/helpers/index.js`（9 个文件、纯函数为主），不放 `forward/helpers/`** — 否掉「转发器自建共享工具目录」— 那会让「转发前判定」与「转发中接线」两处共用的原语没有归属；`forward/` 因此没有 `helpers/` 子目录，`channel/` 与 `upstream/` 之外也没有第二个出口。⚠️ **`helpers/` 的三个策略型类型（`RoutePolicy` / `RouteInput` / `DialPlan`）刻意不进 barrel**——它们只在 `helpers/route.ts` 与 `base.ts` 之间流动，调用方按结构传字面量即可，进 barrel 只会多一个「它是公开契约吗」的错觉。
4. **`ForwarderBase` 持有 `dialer`，且它只服务 `bridge` 一个成员** — 否掉「顺手把拨号收回来」— `bridge` 的调用点只有 `bridgeWithBuffered` 与 `WsForwarder.relay` 两处，搬走换不来解耦。**若将来要动这个字段，唯一的理由只能是「`bridge` 搬走」。**
