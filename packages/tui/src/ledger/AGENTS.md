# src/ledger/ — 本机台账（控制面目标的存盘与接线）

本包要连的是**多个**控制面端点，每个端点 = 一个 base URL + 一份 Bearer token。这个目录管「这份清单存在哪儿、
长什么样、怎么改、怎么变成一个能发请求的客户端」，以及**启动时读回上次选中的那个**（用户需求原话：「有状态，
下次打开能够重连」）。对外唯一出口 `@/ledger/index.js`。机制与决策的完整推导在各文件头，这里只列**不变量**。

## 文件

- `types.ts` — 数据契约 `Target` / `Ledger` / `TargetInput` / `UpsertInput` + 数值边界常量。**零判据**。
- `path.ts` — 台账落在哪儿（`resolveConfigDir` / `targetsPath`，宿主参数都是**注入**的）。
- `validate.ts` — 形状判据 + 本层唯一的失败类型 `LedgerError`（磁盘面 `validateLedger` / 输入面 `validateTargetInput`）。
- `store.ts` — 读 / 原子写 / 打码形态（`readLedger` / `writeLedger` / `redactTarget` / `REDACTED_TOKEN` / `TargetView`）。
- `edit.ts` — **纯函数**编辑面：`slugify` / `idFor` / `upsertTarget` / `removeTarget` / `setSelected` / `selectedTarget`。
- `connect.ts` — 台账 → 客户端的**唯一**转换点：`clientFor` / `probeTarget` / `ProbeResult`。
- `index.ts` — 目录 barrel（只转发）。
- `AGENTS.md` — 本文件。

## 层不变量

- **读面「坏内容即拒」，绝不降级成空台账**。文件**不存在** ⇒ 空台账（首次启动，且**不**因此创建那个文件）；文件**存在但 parse / 校验失败** ⇒ 抛 `LedgerError`。⚠️ 降级成空台账是最坏的一种「体贴」：界面上「重新加一遍」就会拿那份空台账覆盖掉那份好的，而丢的是控制面管理员凭据。牙齿：`tests/ledger.test.ts` 断言的是**抛错后原文件逐字未变**。
- **`LedgerError` 与 `TuiError` 是两件事，不许混用**：后者的三档是**传输层**的失败词汇，一份本机文件形状不对与「连不上那个控制面」的排查方向完全相反。故 `LedgerError` 只有 `unreadable` / `invalid-target` 两档，**文案随便改、`code` 不许增殖**。同理 ⚠️ **token 绝不进日志、不进错误文案、不进快照**。
- **`selected` 指向不存在的 id 是报错，不是静默置 null**；`setSelected` / `upsertTarget` 指向不存在的 id 一律抛（否则那份文件会**再也读不出来**，连里面其余几条好端点一起赔进去）。删一个不存在的 `id` 则是**成功的 no-op**。
- **落盘的字节恒是校验过的形态**，且 ⚠️ **先 `chmod` 再 `rename`**（反过来会留一个「文件已是 0644 且 token 已在里面」的窗口）。原子性的真实边界（Windows 先 `rmSync` 再 `rename` 的极短窗口、并发写互相覆盖）见 `store.ts` 文件头。
- **`token` 明文落盘是结论不是疏忽**：没有可加密它的密钥，OS keychain 要原生依赖；防线是 `0600` 文件 + `0700` 目录 + 位置约定。⚠️ **打码只有一份出口**（`redactTarget`），且**绝不**返回半截明文、**空串保持空串**。
- **`baseUrl` 的判据只有一份**（`@/api` 的 `normalizeBaseUrl`），三处各过一次、绝不重打；**`token` 的字符集判据在本层不存在**（服务端比的是 SHA-256 摘要），本层只判「非空」与「端部空白 trim」。
- **`id` 是稳定身份、`name` 是可变显示名**：`id` 只由 `idFor` 的 slug-递增避让产生（**不是**随机后缀），且 `slugify` **幂等**是契约。⚠️ **`edit.ts` 的每个函数都是纯函数**（不改入参）。
- **探活不 re-throw**（`TuiError` 三档原样交给界面；非 `TuiError` 的异常照旧往上抛）。⚠️ **零 `console`、零 `process.*`** —— `resolveConfigDir` 的 `env` 与 `homedir` 都是注入参数正是为了这条。
- ⚠️ **Windows 与 POSIX 走同一条配置目录规则**（`XDG_CONFIG_HOME` → `~/.config` → `proxy-tui`），**不接 `APPDATA`**（接了会让台账分裂成 WSL 与 Windows 两份）；相对 `XDG_CONFIG_HOME` 一律忽略。

## 相关路径

- `@/api/index.js` — 本层唯一的下游依赖（`normalizeBaseUrl` / `ManagerClient` / `TuiError` / `StatusBody`）。
- 服务端侧的三条事实：鉴权 `src/manager/http/auth.ts`、端点表 `src/manager/routes/index.ts`、读面「坏内容即拒」的同源纪律 `src/ops/AGENTS.md`。
- `src/utils/json-file/write.ts` — 原子写的**真实边界**，本目录的 `writeLedger` 是它的同构实现。
- 消费方 — `src/cli.tsx`（组合根：注入 `process.env` / `os.homedir()`，决定何时写盘）。

## 相关测试

- `packages/tui/tests/ledger.test.ts` — 真文件 + 真临时目录、零网络。覆盖缺失 ⇒ 空台账且不造文件、坏内容 ⇒ 抛且原文件未变、write→read 往返、`0600`/`0700`（win32 `skipIf`）、先 chmod 再 rename、无 `.tmp` 残留、slugify 幂等 / `idFor` 递增 / 编辑面不改入参、路径注入（XDG 命中 / 回落 / 相对值忽略 / Windows 不接 APPDATA）、打码逐窗口、probe 四档，以及**层边界源码级**那组（零 console / 零 `process.*` / 内部不自我引用 barrel / barrel 只 export，全部带判据自检）。