# tests/unit/core/forward/upstream/ — 上游对接轴（`src/core/forward/upstream/**`）的判据

本目录四档答两件事：**传输层 `dial.ts` 零协议知识**（零例外，可执行形式在 `dial-boundary`），
与**连接器层四档各自的面**（`registry` 的映射与记忆化、`transport` 的两个新端口成员、
`socks-reply-text` 的两条日志文案）。`open()` 的字节面在 `./connector/`，入站通道那一侧在
`../channel/`，`forward/` 根的目录成员清单与两轴依赖方向在 `../layout.test.ts`。
机制与层不变量归 `src/core/forward/upstream/AGENTS.md` 与 `src/core/forward/upstream/connector/AGENTS.md`。

## 不变量放哪（⚠️ 判据是「这段不变量**有几档共用**」）

⚠️ **共用两档以上的不变量住在这份文件里**；**只服务一个档的就地住在那个档的文件头里**。
判据是「有几档共用」，不是「目录里有没有 `AGENTS.md`」。

| 段 | 几档共用 | 住处 |
|---|---|---|
| 决策 ①：协议实现的住处是硬不变量，零例外 | 2（`dial-boundary` 正负两侧） | 本文件 |
| 决策 ②：`readReply` 归 SOCKS 基类、两条文案逐字不可改 | 2（`dial-boundary` 的负向半 + `socks-reply-text`） | 本文件 |
| `readReply` 的可见性由编译期锁定 | 2 | 本文件 |
| `codeOnly` 的口径（只去注释、留字符串字面量） | 1（`dial-boundary` 本地持有；`../channel/` 那份同形） | `dial-boundary.test.ts` + 本文件 |
| 「选哪个连接器」在装配期定死 / 未登记协议 fail-closed | 1 | `registry.test.ts` |
| `transport()` 只拨号不做协商 | 1 | `transport.test.ts` |

## 文件（⚠️ 不变量 ↔ 位置对照）

- `dial-boundary.test.ts` — **决策 ① 的牙齿**（负向：`Dialer.prototype` 零协议方法 + 方法集合
  闭集 + `dial.ts` 去注释后零协议词汇 + 两条握手文案在 `dial.ts` 零命中含注释；正向：SOCKS4 /
  SOCKS5 握手体与 `readConnectReply` / `connectViaUpstream` / `dialViaSocks` 外壳 / `readReply`
  各自真在连接器里）。`PUBLIC_METHODS` / `OWN_METHODS` / `MOVED_OUT` / `NODE_TRANSPORT_API` /
  `PROTOCOL_WORDS` / `ownNames` / `codeOnly` / `offendingLines` **只服务这一档**，故留在它文件里。
- `socks-reply-text.test.ts` — **决策 ② 的文本面 + 行为面**：两条文案逐字住在
  `connector/socks-upstream.ts`、对端提前关闭 reject、沉默上游按 `upstreamTimeout` 兜底并销毁
  socket。`callReadReply`（借原型取 protected 的 `readReply`）**只服务这一档**。
- `registry.test.ts` — 6 种 `ProxyProtocol` → 4 个连接器类的契约表（含「未知协议**请求期**
  fail-closed」）+ 记忆化三条。⚠️ 那个 `WeakMap` 是**本档自己的脚手架**不是生产契约。
- `transport.test.ts` — 连接器端口的新成员 `transport()` / `peerTarget()`；与 `open()` 族的分工
  见该文件头（三条核心断言写在文件头，不在这里重复）。
- `_dialer-protocol-boundary.ts` — 三档共用的「读 `src/core/forward/` 原文」那一面：
  `forwardSourceOf`（`dial-boundary.test.ts` / `socks-reply-text.test.ts` /
  `../channel/no-protocol-branch.test.ts`）与 `SOCKS_REPLY_ERRORS`（前两档）。⚠️ **收件门槛是
  「两个以上档真用到」**；只被一档用到的符号留在那一档文件头。⚠️ 住在 `tests/unit/` 里面而不是
  `tests/helpers/`：后者不在零外网扫描的 `SCAN_DIRS` 里，前导搬进去等于让那道护栏对这部分代码彻底
  失效且一声不吭。

## 决策 ①：协议实现的住处是硬不变量，零例外

抽象最容易出的错是「实现没跟上抽象」：连接器只剩薄委托、真实现还躺在 `dial.ts`，于是想读
「我们怎么做 SOCKS5 上游」的人去 `socks5.ts` 找不到东西——**可发现性极差**。所以 `open()` /
`transport()` **就是**实现本体，不许再写回委托。搬迁后各家的住处（**这些不是「本该留在 `dial.ts`」，
是「归 connector 之后各自换了住处」**）：

| 职责 | 住处 |
| --- | --- |
| CONNECT 上游对接（private，**绝不向客户端写字节**，超时抛 `DialTimeoutError` 供调用方回 504） | `connector/http-connect.ts:connectViaUpstream` |
| SOCKS4/4a 握手 | `connector/socks4.ts:handshake` |
| SOCKS5 握手 + CONNECT 应答解析 | `connector/socks5.ts:handshake` / `readConnectReply` |
| 握手应答读取器 `readReply` | `connector/socks-upstream.ts`（`SocksUpstreamConnector` 基类） |

牙齿 = `OWN_METHODS` 闭集 + `MOVED_OUT` 逐个不在 `Dialer.prototype` 上 + 正向那四条「实现真在
连接器里」。**把任一处搬回 `Dialer` 或让它退回薄委托，本目录立刻红。**

⚠️ `dial.ts` 是纯传输层**连字符串字面量里都不许有协议词汇**：`readReply` 的两条报错文案就住在
那里，它们是「传输层却知道协议名」唯一真实的泄漏形态，而 `codeOnly` **留字符串字面量**正是为了
看得见它。断言前先遮蔽 `NODE_TRANSPORT_API`（`net.connect` / `tls.connect` / `secureConnect`
是「建链」，不是协议词汇）。

## 决策 ②：`readReply` 归 SOCKS 基类、不归 `Dialer`

被否掉的是「通用读取器放传输层」——它虽是字节级原语，但两条报错文案（`socks upstream closed
before reply` / `socks reply timeout`）**必然带 SOCKS 字样且会经 channel 的 catch 进落盘日志**，
「通用读取器」与「协议文案」无法分离，留在 `Dialer` 就等于让上面那条不变量永远带一个例外；
而**只有 SOCKS 握手用它**（grep 可证），故归 SOCKS 基类。

- ⚠️ **文案逐字不可改**（改文案即改日志文本）：`expect(base.includes(\`new Error("${msg}")\`))`
  逐条锁着（`socks-reply-text`），配两条**行为面**用例（提前关闭 reject / 沉默上游按
  `upstreamTimeout` 兜底并销毁 socket）—— 只锁文本会被「换个变量拼出来」绕过，只锁行为则漏掉文案改动。
- ⚠️ **负向那半在 `dial.ts` 上**：`expect(raw.includes(msg))` 是对**原文**（含注释）判的，
  因为它们是「整个搬走了」，不是「搬走了又留个注释提及」。
- **可见性由编译期锁定**：`connector/socks4.ts` / `socks5.ts` 经 `this.readReply(...)` 调它
  （基类的 `protected`），`pnpm typecheck` 会在它被改回 `private`、或从基类挪走时变红。

## 文本口径

- **`codeOnly` 只去注释、留代码与字符串字面量**：注释里出现协议名是**在描述这条不变量本身**
  （文件头不得不点名自己禁止什么），把注释也纳入断言就自我否定、只能靠删文档来过。
  ⚠️ `dial-boundary.test.ts` **刻意持有一份本地实现**（与 `../../../../helpers/source-scan.ts`
  那份逐字同形）：护栏的**文本面**与被它判的行为面锁在同一个档里。已知边界：`dial.ts` 与
  `connector/` 下的源码无含引号的正则字面量；将来引入时切分会失准，而那时失败输出会直接把原文
  贴出来，人眼一看就知道。
- **判据形状天然跨行时必须整段文本匹配**：`MOVED_OUT` 那几条走 `toContain`（方法名列表），
  `PROTOCOL_WORDS` 走 `offendingLines`（**按行**判定，故先把 Node 传输 API 整段替换掉再逐行查）。

## 路径纪律

⚠️ **`src/core/forward/` 的路径面只经 `_dialer-protocol-boundary.ts:forwardSourceOf`**，
它从 `../../../../helpers/source-scan.ts` 的 `SRC_DIR` 派生 —— **层数只许出现在 helper 那一处**。
本目录四档都不许手写 `__dirname` + `..` 算术：少一个 `..` 抛 `ENOENT`（自己暴露），
**多一个 `..` 让源码扫描枚举到空集而恒绿** —— 而这两条负向断言的判据面正是那些源码。

## 相关路径

- `src/core/forward/upstream/dial.ts` — 传输层 `Dialer`（方法闭集 + 零协议词汇）。
- `src/core/forward/upstream/connector/{registry,direct,http-connect,socks-upstream,socks4,socks5,types,index}.ts`
  — 映射表与四个连接器。
- `src/core/forward/base.ts` — `connectorForRoute`（唯一「选哪个连接器」处，判据见 `../channel/AGENTS.md`）。
- `src/core/guard.ts` — `awaitStatusLine` / `socksUpstreamGuard`（超时与拨号后生命周期联动）。
- `../../../../helpers/source-scan.ts` — `SRC_DIR` 与 `codeOnly` / `offendingLines` / `codeOf` 的权威一份。
- `../../../../helpers/{config,net}.ts` — `set` / `snapshotConfig` / `restoreConfig` / `testContext`
  与 `getFreePort` / `listen`。
- `../../../../helpers/public-hosts/unit-core-forward.ts` — 本目录**两条**豁免：
  `dial-boundary.test.ts` 的 `sub.name` 与 `connector/open-dial-failure.test.ts` 的 `c.name`
  （两条都是**非 host 文本**，因 TLD 表收录 `name` 被命中；`hosts` 与 `reason` 逐字不许动）。
- `../layout.test.ts` — 两轴成员清单与依赖方向（`forward/` 根只有一档，故无目录 `AGENTS.md`）。
