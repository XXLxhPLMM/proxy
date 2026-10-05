# tests/integration/quota/

本目录只答一件事：**每用户流量配额**从「建链后流动的真实字节」到「落盘账本跨进程存活」这条链路
在真装配里有没有真的接上。共享的被测装配是 `services.traffic`（`UsageAccount` 端口）+ 账本驱动
（`QUOTA_USAGE_DRIVER`）+ 配额判定（层不变量归 `src/runtime/AGENTS.md` 与 `src/core/quota-meter.ts`）。

数据层（窗口/时刻/阈值/驱动注册表）与判定层（累计与撞顶的语义）都在 `tests/unit/datasource/quota/`，
`hasConfiguredQuota` 的正反两格随 `quota-inert` 告警住在 `./inert-and-assembly.test.ts` ——
**前两层不在本目录**，本目录只钉「接线有没有接上」。

## 两组六档

| 组 | 档 | 钉什么 |
|---|---|---|
| 计量侧 | `metering` | usage 的 up/down = 真实流动字节；建链协议字节与 HTTP 头**不**计入 |
| | `exhaustion` | 撞顶 = 硬切，三条路径各**恰好一条** `usage.quota-exceeded` |
| | `inert-and-assembly` | 唯一合计上限 / 未耗尽零发布 / `quota-inert` 正反两格 / 两条落盘行 / 身份隔离 / 热加载 / 三个注入位 |
| 账本侧 | `ledger-restart-recovery` | 停机落盘 → 再起恢复，且恢复量立刻参与判定；多 runtime 共用同一个库 |
| | `ledger-unconditional-and-injection` | 「在判定 ⇒ 一定在记账」；`services.usageSource` 是真注入位 |
| | `ledger-write-error` | 一条 `usage.write-error` 事件 + 一条 CLI `[usage-write-error]` error 行 + 停机落盘落点 + 恢复窗口口径 |

## 计量落点：六条路径，只有一条判据

「计量真的落在**建链后流动的真实字节**上」这件事有六条不同的落点，**只测一条等于没测**：

1. CONNECT 隧道载荷（裸 socket `data` 事件）
2. CONNECT 请求头之后的**首包**（`head`：Node 解析器摘走，**不再触发 `data`** → 必须经 `bridgeWithBuffered` 的 `meter.charge("up", …)` 补记）
3. Upgrade 首批载荷（`head`：落点不同，是 `upgrade.ts:upgradeOver` 自己的 `upstream.write(head)`，**不经** `bridgeWithBuffered`）
4. SOCKS5 载荷（握手往返不得计入）
5. HTTP 请求体 + 响应体（**两侧各少算一个 HTTP 头** —— Node 的 `IncomingMessage` 流只覆盖消息体，状态行/请求行与头都是 Node 直接写进 socket 的；这个**已知不对称**的量化在 `src/core/quota-meter.ts`）
6. 零体请求（`usage` 恒零 / 只有响应体计入 `down`）

⚠️ **「分两次写」覆盖不到 `head` 那两条**：等 200 再发载荷走的是普通 `data` 事件。所以 fixture 里
`tunnelPipelinedHead` / `upgradeWithHead` 刻意把头与载荷拼在**同一次写**里。
⚠️ **`head` 路径与 `data` 路径在「耗尽」场景下观察结果完全一样**（都拒、都断链、都不写上游），
而 TCP 分段不确定 —— 所以耗尽⑤额外加了一条**源码级**断言钉「判定就在 `head` 那一行」。

## 耗尽 = **硬切**（不是拒新请求）

为什么不「用尽后只拒新请求、已有连接放着」——一条长连接隧道能永远不触发耗尽判定，配额就成了摆设。

- HTTP：**未发头回 507**（**不是 403**——配额耗尽不是权限问题，403 会诱导客户端换凭证 / 换身份重试，
  而重试对「用完了」毫无意义）、已发头 `destroy()`。
- 隧道 / SOCKS / WebSocket：应答早已发出，改不了 → 双端 `destroy()`。
- ⚠️ **不要**为了「让状态行一定送到」改成 `setImmediate` 延迟 destroy——那会在延迟窗口里漏掉本该被拒的字节。
- **「恰好一次」**由各自的 `fired` 闭锁保证（HTTP 两个方向**共用同一个闭锁**，否则 `up` 撞顶恰好与
  `down` 首个 chunk 落在同一轮事件循环时会发两条）。
- ⚠️ **「记账」与「放行」是两件事**：硬切只否掉放行，被拒的字节**照样计入已用量**（累计值不截断）。
  运维看到 `[quota-exceeded]` 那一行的 `usage=` 是**已记账**的量，不是「放过去了多少」。
- ⚠️ **耗尽不许补出假的失败事实**：漏判 `allow` 时 `relay` 会在我们自己销毁的流上继续等到
  `upstreamTimeout`，补出一条「上游响应超时」——上游是被配额掐死的，不是超时。运维看到那行会去查上游。
  所以护栏是 `pipe` 事件面上「零条 `upstream-error` / `upstream-timeout`」。

## `quota-inert` 收窄到「**真的配了非零配额**」∧ `authEnabled === false`

为什么不只看 `authEnabled`。关鉴权本身是绝大多数部署的常态，只看它会让这条 warn 在**没有配额的部署**里
也一直响，最终**淹没真正需要看的告警**；而「没配配额」时根本不存在「有东西没生效」——那正是配额必须
**能被运维解释**的前提。

- 正向：配了 `quota.bytes` + `authEnabled=false` ⇒ **恰好一条**。
- ⚠️ **负向那一格才是这条裁决的牙齿**：没配配额 + `authEnabled=false` ⇒ **零条**
  （关鉴权本身是常态，没配配额时告警就是噪音）。把判据放宽成「只看 `authEnabled`」正向那格照样过。
- ⚠️ 断言**恰好**条数（不是 `>= 1`），因为它是**启动期一次性事实**不是每请求。

## 账本：落盘无条件 + 注入位曾经是死的

1. **端到端重启恢复**（本目录的核心价值）：真代理 + 真源站 + 真字节 → 停机 → 再起，`usage()` 仍含那 N 字节，
   且恢复出来的用量**立刻参与判定**（否则反复「烧满 → Ctrl+C → 再起」就能无限白嫖）。
2. **所有 runtime 共用同一个库文件**（本目录的共享断言）：两个 runtime 实例（模拟两个进程）
   指向**同一个** `usage.db`，各自的量落在同一行上相加。旧形态是每个 slot 一本 `worker-<slot>.jsonl` ——
   那让配额判定从「账号级封禁」退化成「每进程一份封禁」，故槽位机制整体删除。
3. **落盘无条件**：没人配 `quota.bytes` 也照样建目录建表。⚠️ 判据是**真发一次请求 + 真读一次库**，
   不是 `enabled` 标志 —— 拆掉 `open()` 里那道启用门之后标志恒为 true，判据就成了摆设。
4. **`services.usageSource` 注入位曾经是死注入点**：`RuntimeServices` 上一直有那个字段，
   `buildDefaultServices(overrides: Partial<RuntimeServices>)` 的签名因此**放行**
   `services: { usageSource: 替身 }` —— 可那个函数从头到尾**没读过这个字段**，两条 return 分支分别写死
   `usageSource: undefined` 与内置那一份。于是「传了等于没传」，**且零告警、零报错、全绿**。
   这比「没有这个位」更坏：类型系统在替一个空壳背书。
5. **`usage.write-error` 事件**由 runtime 发布（`UsageSourceError` → 公共事件）；
   **CLI 落一条 `[usage-write-error]` error 行**（`runtime/event-log.ts:bindProxyEventLogs`）。
   ⚠️ 那条 CLI 断言**不造磁盘故障**（Windows CI 上不可复现），改成手工 publish 一次再验绑定。
6. **`start → stop → start`**：账本每轮重新建立/释放，`queued` 归零。
7. **`ProxyServer.stop()` 在与 `logger.flush()` 同一位置落盘**（读真实文件内容）。
8. **恢复读取的窗口口径与判定侧同一份**（同一个 `resetHour` 闭包）：若恢复按 0 点、判定按 3 点，
   同一批字节会被算进两个窗口。

## 防假绿与防恒绿的位置

- **替身必须「会记账」**：只断言 `services.usageSource === 替身` 证明的只是「赋值发生」——一份没人调用的
  替身照样通过。所以数 `record` 收到的条数（`countingAccess()` 那条纪律同源）。
- **源码级断言的锚点必须是今天仍然存在的形状**：`overrides.usageSource`（不是被删掉的符号名 ——
  点名已删符号的负向断言会恒真而不是失败）；`blockAfter` 的锚点取**返回类型那一行**
  （`export function buildDefaultServices(` 后面第一个 `{` 是**参数里**的花括号，切错块的表现是
  「零命中」而不是报错），所以先有一条正向断言证明切对了块。
- **`@ts-expect-error` 是编译期牙齿**：它一旦变成「未使用」，`pnpm typecheck` 报 TS2578。而 `.cnb.yml`
  只做 Docker build、不跑 typecheck，**本地那四条收尾是唯一关口**。
- **热加载清零等于发了一条刷配额的路**：攻击者只要反复触发热加载就能把任意大的配额一次次重置。
  所以「已用量保留不清零」必须钉住；清零的唯一正当场景是「配额窗口过期」。
- **账本目录必须逐例隔离**：用量是**持久**的，共享一个目录会让上一条用例烧掉的额度漏进下一条，
  症状**时红时绿**（上一条 runtime 的停机落盘有没有赶上本条 start）。
- ⚠️ **fixture 一律留在本目录，不许进 `tests/helpers/`**：`external-network-scan.ts` 的 `SCAN_DIRS`
  排除 `helpers/`，而 `walk()` 收目录下**全部** `.ts` —— 把含建链位或公网 host 字面量的东西搬进 `helpers/`
  等于让那部分覆盖从零外网扫描里**静默消失**，而 `no-external-network.test.ts` 的两条下界断言照样绿。
- ⚠️ **内联 config 必须逐处给 `quotaUsageDir`**：`createProxyRuntime({ config: <内联对象> })` 压根不经
  `loadConfig`，`tests/setup-env.ts` 钉的 `QUOTA_USAGE_DIR` 对它**一点用都没有** —— 缺省是相对路径
  `cfg/usage`，`configDir` 缺省 = `process.cwd()`，于是**在仓库里**建出 `cfg/usage/`。
  `open()` 在 `start()` 里就跑，**与是否真触发计量无关**。`inert-and-assembly.test.ts` 继承了 4 处。
- 所有源站 / 上游桩一律 `127.0.0.1:<getFreePort()>`；`users.json` / `acl.json` / 账本目录一律写进
  `mkdtemp` 出来的临时目录。

## 文件

- `metering.test.ts` — 计量落点正确性（真字节，不用 mock）：CONNECT / CONNECT 首包补记 / SOCKS5 握手字节 / HTTP 双向 / 零体。
- `exhaustion.test.ts` — 耗尽行为：HTTP 未发头 507、HTTP 已发头 destroy、CONNECT / SOCKS5 / Upgrade 首包三条硬切 + `upgradeOver` 的 `head` 补记必须判 `allow`（源码级）。
- `inert-and-assembly.test.ts` — 唯一合计上限 / 未耗尽零发布 / `quota-inert` 正反两格 / 两条落盘行 / 身份不串号 / 配额热加载 / 三个注入位（**含全部 4 处内联 config**）。
- `ledger-restart-recovery.test.ts` — 端到端重启恢复 + 所有 runtime 共用同一个库。
- `ledger-unconditional-and-injection.test.ts` — 落盘无条件（真 runtime 侧）+ `services.usageSource` 是真注入位（含源码级与类型面牙齿）。
- `ledger-write-error.test.ts` — 写盘失败 → 事件 + CLI error 行 + 停机落盘落点 + 恢复窗口口径。
- `quota-fixture.ts` — 计量三档共用的装配面：自建事件总线、临时 `users.json` / `acl.json`、三个目标桩（HTTP 源站 / 裸 TCP 回显 / 裸 TCP 101）与四组 hook。
- `ledger-fixture.ts` — 账本三档共用的装配面：每例独立的临时目录群、一份自带全部钉值的 `ConfigStore`、真源站与四组 hook。
- `AGENTS.md` — 本文件。

## 相关路径

- `../../../src/core/quota-meter.ts` — 计量落点与「HTTP 头两侧各少算一个头」的量化。
- `../../../src/runtime/services.ts` — `buildDefaultServices`（两条 return 分支各读一次 `overrides.usageSource`）。
- `../../../src/runtime/index.ts` — `createProxyRuntime` 与 `RuntimeWarning` / `onWarning` 白名单。
- `../../../src/datasource/quota/` — `UsageAccount` / `UsageSource` 端口与两个内置驱动。
- `../../helpers/proxy.ts` — `withProxy` 脚手架（`access` 缺省档不是放行桩的那条裁决住在这里）。
- `../../setup-env.ts` — `QUOTA_USAGE_DIR` / `QUOTA_USAGE_DRIVER` 的钉值，**以及它只覆盖走 `loadConfig` 的用例那条警告**。
- `../../unit/datasource/quota/` — 判定层与数据层（判定 `mirror-allow` / `consume-sync`，窗口 `window-key` / `window-rollover`，账本 `jsonl-cursor` 与 `sqlite/`、`drivers/`）。
- `../../unit/config/auth-users/quota-{window,load,validate}.test.ts` — 账号表那一侧的 `quota` 组形状与读面。
- `../AGENTS.md`、`../../AGENTS.md`、`../../../AGENTS.md`。
