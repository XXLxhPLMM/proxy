# tests/unit/core/forward/upstream/connector/ — 四个连接器 `open()` 的**出站握手字节**

本目录三档只答一件事：**连接器发出去的每一段字节**（direct / http-connect / socks5 / socks4），
外加失败路径与 TLS 承载。上游握手的报文形态是**跨实现兼容**的契约（本仓连的是别人的 SOCKS /
HTTP 代理），所以全部断言都落在字节面。连接器的**形状**（`kind` / `targetForm` / 凭证 /
自环目标 / 记忆化）在 `../registry.test.ts`，`transport()` / `peerTarget()` 在 `../transport.test.ts`。

## 三档共用的字节面纪律

- **本目录锁的是连接器发出的真实字节，不是返回值形状**（返回值形状归 `../registry.test.ts`）。
  判据一律逐字节：`expect([...buf]).toEqual([...])` / `expect(buf.equals(expected)).toBe(true)`，
  假上游**只做「按报文应答」**（读到该读的就回固定字节），不做协议解析、不做真隧道。
- **`rest` 契约在直连/SOCKS 上恒空**（无字节丢失）；http-connect 的 `rest` 装的是**响应头之后
  上游已发出的字节**（server-speaks-first），`refusal` 存在时两处 `rest` 是同一缓冲。
- ⚠️ **连接器绝不许向 client 写任何字节**（成败应答与 `refusal` 的处置形态一律归 channel）：
  每个用例都建一个 `PassThrough` 哑 client 并收集它收到的字节（`makeClient().seen`），断言恒空；
  另一面是 `client.destroyed` 恒 `false`（`keepClientOnFailure`）。`transport()` 那一族用
  `client.writableLength` 判同一件事。
- **连接器不销毁 socket**：销毁归 channel（http-connect 的非 200 一档显式断言 `sock.destroyed`
  恒 `false`），而 `open-dial-failure` 的 readReply 超时那一档断言的是**必须**销毁已建链的上游
  （否则连接挂在守卫之外）—— 两者不是矛盾：一个在成功/失败应答之后，一个在**读应答超时**之后。
- **收尾零残留**：每个自己起的 server / client / sock 登记进 `OPEN_ENDS`，`afterEach` 在
  `_connector-open.ts` 里统一销毁并 `close`（`net.Server` 没有 `closeAllConnections`）。
  ⚠️ 那条钩子住在共用前导里是被 vitest 收集的（档顶静态 import 即收集期执行），已实测三档各跑一次
  且 `OPEN_ENDS` 每次都归零。

## 决策 ① / ②（只服务 `open-socks.test.ts`，故在它文件头）

**① SOCKS5 CONNECT 的 ATYP 对 IPv4 与域名一律沿用 `SOCKS5_ATYP_DOMAIN`**（刻意的简化，
**不许「修正」**）。**② SOCKS4a 域名走 `0.0.0.1` 哨兵 + 尾部域名；USERID 取
`upstreamUsername`，未配置即空。** 两条的完整来由与逐字节牙齿在 `open-socks.test.ts` 文件头。

## 相关路径

- `src/core/forward/upstream/connector/{direct,http-connect,socks-upstream,socks4,socks5}.ts` —
  四个连接器本体与两个握手协议体。
- `src/core/forward/upstream/dial.ts` — `DialTimeoutError`（失败路径那一档判的类型）与建链原语。
- `src/core/guard.ts` — `socksUpstreamGuard` 的 `upstream-timeout` 事件与 `logPrefix` 透传。
- `src/core/forward/base.ts` + `src/core/forward/channel/` — `refusal` / 销毁的处置方（本目录不碰）。
- `../../../../../helpers/{config,net}.ts` — `set` / `snapshotConfig` / `restoreConfig` /
  `testContext` 与 `getFreePort` / `listen`。
- `../../../../../helpers/public-hosts/unit-core-forward.ts` — 本目录**一条**豁免：
  `open-dial-failure.test.ts` 的 `c.name`（**非 host 文本**，因 TLD 表收录 `name` 被命中；
  `hosts` 与 `reason` 逐字不许动）。另两条豁免归 `../dial-boundary.test.ts`。
