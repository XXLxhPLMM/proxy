# tests/unit/core/forward/upstream/ — 上游对接轴（`src/core/forward/upstream/**`）的判据

本目录四档答两件事：**传输层 `dial.ts` 零协议知识**（零例外，可执行形式在 `dial-boundary`），
与**连接器层四档各自的面**（`registry` 的映射与记忆化、`transport` 的两个新端口成员、
`socks-reply-text` 的两条日志文案）。`open()` 的字节面在 `./connector/`，入站通道那一侧在
`../channel/`，`forward/` 根的目录成员清单与两轴依赖方向在 `../layout.test.ts`。

## 决策 ②：`readReply` 归 SOCKS 基类、不归 `Dialer`

被否掉的是「通用读取器放传输层」——它虽是字节级原语，但两条报错文案（`socks upstream closed
before reply` / `socks reply timeout`）**必然带 SOCKS 字样且会经 channel 的 catch 进落盘日志**，
而**只有 SOCKS 握手用它**（grep 可证），故归 SOCKS 基类。

- ⚠️ **文案逐字不可改**（改文案即改日志文本）：`expect(base.includes(\`new Error("${msg}")\`))`
  逐条锁着（`socks-reply-text`），配两条**行为面**用例（提前关闭 reject / 沉默上游按
  `upstreamTimeout` 兜底并销毁 socket）—— 只锁文本会被「换个变量拼出来」绕过，只锁行为则漏掉文案改动。
- ⚠️ **负向那半在 `dial.ts` 上**：`expect(raw.includes(msg))` 是对**原文**（含注释）判的，
  因为它们是「整个搬走了」，不是「搬走了又留个注释提及」。
- **可见性由编译期锁定**：`connector/socks4.ts` / `socks5.ts` 经 `this.readReply(...)` 调它
  （基类的 `protected`），`pnpm typecheck` 会在它被改回 `private`、或从基类挪走时变红。

## 文本口径

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
