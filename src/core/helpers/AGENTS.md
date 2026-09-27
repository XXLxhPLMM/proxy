# src/core/helpers — 转发层共享工具

**跨目录只引 `@/core/helpers/index.js`；层内相对引用，禁止自引 barrel。**

## 路径说明

| 文件 | 只负责 | 依赖 |
|---|---|---|
| `credentials.ts` | **纯**凭证原语：索引编译 + 单槽记忆、Basic 令牌解析、内置 HS256 验签、`buildProxyAuthValue` | 叶子 |
| `target.ts` | **纯**目标地址解析：host 白名单、authority 拆分/拼装（IPv6 方括号，剥壳走 `@/utils/host-text.js`）、目标三元组 | 叶子 |
| `self-loop.ts` | 自环判定 `isSelfLoopAddr`（零 config、零 IO）；私有 `canonicalHost` 复用 `@/config/files/rules` 的归一实现 | 叶子 |
| `headers.ts` | 出站头剥离判据与净化。**零 `@/config/index.js` 导入** | type-only `types/identity.js` |
| `route.ts` | `resolveRoute` / `resolveForwardTargets` —— **有效模式唯一入口**。**对策略层只 type-only** | `target` |
| `upstream.ts` | 上游协议映射（`isSocksProto` / `socksVersionOf` / `isTlsUpstreamProto`）+ 上游 Basic 凭证头 | `credentials` |
| `wire.ts` | 线缆字节：出站 CONNECT 报文 / 裸 socket 状态行应答 / 写完延时销毁 | `target` |
| `predial.ts` | 拨号前守卫：自环（薄委托 `./self-loop.js`，**这一条仍读 config**）+ 目标名单（`AccessControl` 端口，**全局 + 该用户个人名单两层**）+ 拒绝收尾回调 | `self-loop`（`AccessControl` 只 type-only） |
| `index.ts` | 层出口 | — |

依赖无环：`credentials` / `target` / `self-loop` / `headers` 是叶子 → `wire → target`；`upstream → credentials`；`route` 与 `predial` 对策略层只 type-only。⚠️ **`RoutePolicy` / `RouteInput` / `DialPlan` 三个类型刻意不进 barrel**——它们只在 `route.ts` 与 `../forward/base.ts` 之间流动，调用方按结构传字面量即可，进 barrel 只会多一个「它是公开契约吗」的错觉。

**不属于本层**：上游连接器的声明式数据（`../forward/upstream/connector/types.ts`）、入站头的**展示**掩码（`../server/http.ts:maskSensitiveHeaders`）、入站握手字节流（`../forward/channel/socks-reader.ts`）。

## 硬约定

- **凭证判据一律转交插件**：`isProxyHeaderName` 是**纯**名称规则（零依赖，`error-boundary.ts` 在没有任何配置的上下文里也要用它，**签名一字不许动**）；`isStrippableOutboundHeader` / `stripProxyHeaders` / `sanitizeHeaders` 的凭证判据**对每个出站头名 × 每个值一律转交 `IdentityProvider.isOwnCredential`**（库层**无**头名门禁）。目标的 `Authorization: Bearer <token>` 出站**保留**。
- **`resolveRoute` 是同步纯函数，绝不许加 `async` / `await`**，它纯函数不打日志。路由事实经 `../forward/base.ts:emitRoute` 发 `route` 事件（**过 preDial 每请求恰一条、拒绝路径与 server 模式短路零条**），`[route]` info 行（字段 `target`/`route`/`reason`）由 `src/runtime/event-log.ts` 落盘、与事件 1:1。
- **目标主机必过 `isValidTargetHost`**（字符白名单 + 255B，防 CONNECT / SOCKS 报文注入与长度域截断）。
- **`PreDialOptions.access` 必填、无 `?`、无缺省档**；`config` 形参**保留**（`isSelfLoop` 还要读 `host`/`port`）——「哪些依赖是必需的」按**用得上**判，不按「同一类」打包。

## `resolveRoute` 与 `resolveForwardTargets`

- `policy.mode === "server"` → **第一行就返回** `{mode:"server", route:"direct"}`，**不查名单、不带 `reason`**。⚠️ **「不带 `reason`」是承重契约**：`emitRoute` 的跳过条件正是 `mode === "server" && !reason`，凭空多一个 `reason` 会让 server 模式凭空多发一条 `route` 事件、多落一行 `[route]` 日志。
- client 模式 → `policy.access.checkRoute({ host })` 说直连 → `{mode:"server", route:"direct", reason}`（**必带 reason**，这份回落有信息量、正是 `emitRoute` 要发出来的那条），命中即按 server 语义处理：拨号目标 / path 形态 / 凭证 / Host / secure 全自然回落；否则 `{mode:"client", route:"upstream"}`。
- `resolveForwardTargets(url, hostHeader, policy, dial: {upstream})` 成对给出 `{dial, dest, route}`（dial 按有效模式选）。四个转发器后续分支一律用 `route.mode`。
- `guardPreDial` 语义：**自环看 `dial`、名单看 `dest`**（**名单永不判上游**）。名单是两层：`PreDialOptions.user`（由 `../forward/base.ts:preDial` 逐次注入，`preDial` 是**全仓唯一**读 `scope.user` 的地方）经 `opts.access.checkTarget({ host, user })` 出两层结论，事件多带一个 `source`。自环判定的唯一实现是 `self-loop.ts:isSelfLoopAddr`，`isSelfLoop(h, p, config)` 只做一层薄委托。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

> 已被测试断言锁住的决策不在这里——它们的「结论 + 否掉了什么 + 为什么」写在**那条断言自己所在的测试文件的头注释**里（`headers.ts` 零配置那条在 `tests/unit/identity-credential-seam.test.ts`；authority 拼装 / 剥壳那条在 `tests/unit/proxy-helpers.test.ts`）。本清单只留**没有任何测试会红**的纯设计取舍。

1. **`route.ts` 与 `predial.ts` 对判定层只 type-only 引 `@/core/types/proxy.js`** — 否掉「运行期 import `@/core/access-control.js`」— 那是**反向耦合**：判定层一改就牵动工具层。⚠️ **「层不得反向依赖策略层」与「同目录兄弟依赖」（`route → target`）是两条不同的纪律**，别把后者误用成前者——把 `parseTargetParts` 提成调用方注入的 `parsed` 形参就是这种误用：那个前提「收策略就得调解析器」是假的，后果是唯一入口被拆散到四处调用点。⚠️ **没有测试会红**：把一个 type-only 引用改成运行期 import，`codeOnly` 扫描（`tests/helpers/source-scan.ts`）并不看 `import type` 与 `import` 的差别，全仓无断言守这条依赖方向。
2. **`policy` 刻意不含整个 `ConfigAccessor`** — 否掉「把 config 收进 `resolveRoute`」— 那等于让这个纯函数「什么都能读」；只给 `access` + `mode` 两事实之后，本文件对配置的依赖**恰好只剩 `mode` 这一个键**（热路径上零 IO、零查询）。`mode` 由 `../forward/base.ts:routePolicy` 现读 `proxyMode` 给出。⚠️ **没有测试会红**：`tests/unit/config-access.test.ts` 那条是拿一个**局部变量**（不是字面量）当 policy 传进去的，给它加个 `config` 字段既不触发 excess-property 检查、也不改变任何断言结果。
3. **`dial` 刻意与 `policy` 分成两个形参** — 否掉「把上游地址塞进 policy」— server 模式下这组地址根本不存在，塞进 policy 等于逼每一个 server 模式部署编一个用不到的假上游。⚠️ **没有测试会红**：合并两个形参是纯签名变化，既有断言照旧成立。
4. **入站头的展示掩码与出站头剥离是两套方向相反的判据，不许「顺手统一」** — 否掉「把 `maskSensitiveHeaders` 也放进 `headers.ts`」— `headers.ts` 的全部导出都是**出站**判定（`proxy-` 前缀无条件剥、其余问插件），而日志掩码是**入站展示**判定：同一个 `Authorization: Bearer` **出站要保留、日志里必须掩码**。混在一处迟早被统一掉而放大泄漏面。掩码的归属判据见 `tests/unit/core-event-bridge.test.ts` 第 ④ 条头注释与 `tests/unit/identity-credential-seam.test.ts`。⚠️ **没有测试会红**：`headers.ts` 的断言只检查它**自己**零配置依赖，把掩码函数搬进来不会触发其中任何一条。
5. **自环判定的归一实现与 ACL 名单共用一份**（`self-loop.ts` 的 `canonicalHost` 经 `@/config/files/rules/index.js` 取 `normalizeHost` / `normalizeIp` / `ipToString`）— 否掉「自环自己写一份 IP 归一」— 两份归一会漂，而漂的表现是「名单里 `::1` 拒了、路径上 `0:0:0:0:0:0:0:1` 放行」。⚠️ **没有测试会红**：`tests/unit/self-loop.test.ts` 全部是**行为**断言（`isSelfLoopAddr` 对各种形态返回 true/false），在 `self-loop.ts` 里另写一份**正确**的归一，全部用例照样绿——「共用一份」只有源码扫描能锁，而本仓没写那条扫描。
6. **`self-loop.ts` 的 `isSelfLoopAddr` 零 config 零 IO，`isSelfLoop` 是它的薄委托** — 否掉「两个函数合一」— 那个 `config` 形参只有 `isSelfLoop` 需要（读 `host` / `port`）；合成一个就等于给纯函数塞一个用不上的依赖，且 `access-control` 侧要复用归一时只能连带拖上 config。⚠️ **没有测试会红**：`tests/unit/proxy-helpers.test.ts` 里 `isSelfLoop(h, p, config)` 那几条只验行为，合并两个函数它们照样过。
7. **凭证索引用「编译 + 单槽记忆」（`indexMemo` / `credentialIndexesFor`）** — 否掉「每次判凭证重编译一遍索引」— 出站头剥离在热路径上每个头值都问一次；记忆化的失效判据是**源对象身份**，与 ACL 编译缓存同一手法。身份层与本层因此**保证出站头剥离与鉴权用同一判据**。⚠️ **没有测试会红**：`tests/unit/auth-users.test.ts` 与 `user-quota.test.ts` 拿 `credentialIndexesFor` 各调一次再比**内容**逐项相同——记忆化摘掉之后每次重建，产出仍然相同，那几条照样过。要有牙齿必须断言 `credentialIndexesFor(同一数组) === credentialIndexesFor(同一数组)`。
8. **`credentials.ts` 零 config 零 IO，`identity/` 只做薄委托** — 否掉「让身份层自己比对账号表」— 索引编译与记忆只有一份，薄委托才能保证「出站头剥离与鉴权用同一判据」，结果再带回 `username` 供逐连接日志。⚠️ **没有测试会红**：`tests/unit/identity-credential-seam.test.ts` 锁的是 `FileAccountIdentity.isOwnCredential` 与 `identify` **同源**（`jwtSecret` 只读一份）与 `isEnabled` 单一定义，**没有**一条断言说「身份层不许自己编译索引」——把索引编译搬进 `file-account.ts` 仍然全绿。
