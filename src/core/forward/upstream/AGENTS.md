# src/core/forward/upstream — 纯传输层

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `dial.ts` | `Dialer`（`extends ContextualBase`、`constructor(ctx: CoreContext)`、无自有字段）—— **建链**（`dialDirect` / `dialTls` / `choose` / private `dialWith`）+ **桥接**（`bridge`） | 只回答「连上」与「把已建好的两条流接起来」。**上游协议一律不认识** |
| `connector/` | 「怎么到达 dest」的唯一抽象 | [`connector/AGENTS.md`](./connector/AGENTS.md) |

**不属于本层**：协议实现的**归属**在 `connector/<协议>.ts`；拨号后的上下游生命周期联动在 `../guard.ts`。

## 硬约定

- **上游协议的实现只住在 `connector/<协议>.ts`；本文件不得知道任何上游协议。** `dial.ts` 里零 `SOCKS4*` / `SOCKS5*` / `buildConnectRequest` / `awaitStatusLine` / `normalizeIp` 等协议常量或协议级状态机，也**不提供「按协议拨号」的入口**（`dialViaHttpUpstream` / `dialSocks` / `handshakeSocks*` / `withUpstreamDial` / `readConnectReply` / `readReply` 全部不住在这儿）。**这条不变量零例外。**
  - 防职责回流的负向断言在 `tests/unit/dialer-protocol-boundary.test.ts`：锁 `Dialer.prototype` 的方法闭集 + **去注释后的源码文本零协议词汇** + 三个连接器各自的实现归属。
- **依赖方向单向**：`connector/* → dial.ts`。`dial.ts` **不得** import `connector/`。
- **四个方法的守卫形参一律必填**（`guard: DialGuardOptions`）。`opts?` / `guard?` 那类可选形状零存在理由，理由见 `../../AGENTS.md`「拨号守卫」小节。
- **`bridge` 不是拨号**：不建连接、不读配置，只把两条已建好的流接起来。稳态双向 pipe + 仅上游出错即双关；**client 侧的 close 守卫归上层**。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

> 已被测试断言锁住的决策不在这里——它们的「结论 + 否掉了什么 + 为什么」写在**那条断言自己所在的测试文件的头注释**里（守卫形参必填那条在 `tests/unit/dead-optionality-cleared.test.ts`；协议实现归属与 `readReply` 住处那两条在 `tests/unit/dialer-protocol-boundary.test.ts`）。本清单只留**没有任何测试会红**的纯设计取舍。

1. **`bridge` 留在传输层、不搬去别处** — 否掉「bridge 是转发语义，搬进 `forward/base.ts`」— 它的调用点只有 `bridgeWithBuffered` 与 `WsForwarder.relay` 两处，搬走换不来解耦；而它需要的东西（两条已建好的流）正是传输层的产物。**这也是 `ForwarderBase` 持有 `dialer` 的唯一理由**——把这个字段收回来属于「顺手重构」，不是改进。
2. **`dialWith` 把 open 回调 / error / timeout 三源收敛成一次竞态** — 否掉「每个 `dial*` 各自处理」— 三源竞态的收敛逻辑一旦有三份，其中两份就会在「timeout 与 error 同时到达」时给出不同答案，而那种差异只在慢网络下偶发。⚠️ 没有测试会红：`tests/unit/dialer-protocol-boundary.test.ts` 的 `OWN_METHODS` 只锁「方法名的闭集」，把竞态逻辑在 `dialDirect` / `dialTls` 里各抄一份并不新增方法名。
3. **`choose` 按是否加密自动选 net / tls** — 否掉「让调用方传 `net` 或 `tls` 进来」— 那等于把「这个目标要不要 TLS」这个协议事实从连接器层搬到调用方，而连接器已经是它的唯一持有者。⚠️ 没有测试会红：改签名是编译期破坏，不是静默退化。
