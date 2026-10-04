# src/services/ — 本包会动手的那一半

「怎么把 `@/api` 那份契约**变成一次真的请求**」，以及两端的环境：`manager-client.ts`（**唯一**拨号点）、
`config/`（本机台账：一份 SQLite 库里的台账与会话）、`warnings.ts`（宿主告警面）、`terminal/`（会往 stdout 写控制序列的那一半）。
`index.ts` 转发 `manager-client.ts` 与 `warnings.ts`；`config/` 与 `terminal/` 各有自己的 barrel。

⚠️ **本目录的 barrel 转发拨号点与告警面，故 `@/lib/errors.js` / `@/lib/http.js` / `@/api/index.js` 在这里是深层路径** ——
`config/` 要引拨号点，而拨号点要引 `@/lib` 的两个叶子；走 `@/lib/index.js` 会经 `lib/failures.js` 绕回
`config/` 形成运行期环。

## 层不变量

- ⚠️ **控制面拨号点只有 `manager-client.ts:ManagerClient.call` 一处**，本目录其余文件只做纯变换或纯本地 IO
  （台账那个 SQLite 库、终端的 stdout）。理由：契约与判据要能被单测逐字断言，而**替身只可能注入到拨号那一处** ——
  ⚠️ 本包**没有** fetch 注入点。
- ⚠️ **模型那一侧有**第二个**拨号点**（`model.ts:askModel`），而它**刻意不是** `ManagerClient`：
  它去的是**用户自己配的 provider**，认的是 `/chat/completions` 而**不是** `ENDPOINTS`。
  ⚠️ 两条不许合并 —— 合并了模型就能借控制面的凭据打控制面（理由见 `packages/tui/AGENTS.md`「模型」一节），
  而它也不许用 `ManagerClient`：那个 class 会把 `token` 装进请求头。
- ⚠️ **`HISTORY_LIMIT`（请求体只看最后 40 格）与桶的 `LOG_KEEP`（2000 条）是**一对耦合的数**，不是一个数：
  桶是环形缓冲、留 2000 格是为了滚动与排错，而**出网的那一份必须小**（每格都要变成请求体里的字节）。
  ⚠️ 调 `LOG_KEEP` 时**不要**顺手调它：桶里留着的那些格子模型**看不到**（`messagesOf` 只取
  `user` / `assistant` 两档，故 2000 格里真正进请求体的通常只有几十格）。
- ⚠️ **路径与形状一个都不许重打**：每个方法从 `ENDPOINTS` / `SHAPES` 取，写不出一条自己的 `(method, path)`
  （除表里那个 `:username` 模板）。重打就是第二份真相源。**每个端点一个方法**，不暴露通用 `request()`。
- ⚠️ **`call` 先读 text 再判成败**，且 **`DELETE` 也带 body**（改用查询串就得多写一条分支，而那正是「删了 A 实际
  删了 B」最容易长出来的地方）。
- ⚠️ **文案绝不转述对面的数据**（响应的 body、带凭据的地址、任何一段 token），**也绝不重打 userinfo**。
- ⚠️ **台账读不出来时**：`config/` 抛 `LedgerError` 而**绝不降级成空台账**（那会让「重新加一遍」拿空台账覆盖掉
  存着凭据的那份），而 `@/AppState.tsx` **不清内存里上一份好的** —— 两件事的方向相反，故两者是分开的。
- ⚠️ **`warnings.ts` 是本目录「零 `console` / 零 `process.*`」那个纪律的唯一例外**：stderr 是宿主的，
  而 Node 的默认告警打印器 `onWarning` 是 `'warning'` 事件的**普通监听器** —— 只加一个监听器压不住它，
  必须把它摘下来、由自己转发其余的（`ExperimentalWarning` 另有别的来源，全吞等于替别人做决定）。
  ⚠️ 它返回的撤销**幂等**，且必须**在 `node:sqlite` 被加载之前**装上（组合根 `cli.tsx` 的 `main()` 第一句就是它）。
- ⚠️ **`?1049` 归 Ink**：`terminal/` 一条都不许碰它；每条发出的序列都要有配对的撤销，收尾幂等
  （到达收尾有三条路径：`finally` / `process.once("exit")` / `waitUntilExit`）。
- ⚠️ **Ink 没有鼠标，本包自己挂 `data`**：`terminal/` 到 `useInput` 之前全是可打印字符，`isMouseReport` 必须
  与 `parseSgr` **同源**，认领在 `@/lib/input-line.js` **入状态之前**。
- ⚠️ **`config/` 零 `console`、零 `process.*`** —— `resolveConfigDir` 的 `homedir` 是注入参数正是为了这条
  （`tests/ledger.test.ts` 逐文件扫那一句）。

## 相关

`@/api/index.js`（上游契约）· `@/lib/errors.js` / `@/lib/http.js`（纯变换）· 根仓 `src/manager/http/*`（请求头与失败码的出处）
`tests/client.test.ts`（对**真 `http.Server`** 的端到端契约）· `tests/ledger.test.ts`（台账的成败语义）·
`tests/sqlite.test.ts`（驱动 / pragma / schema 版本 / 权限 / 会话落库）· `tests/warnings.test.ts`（告警过滤器）·
`tests/mouse.test.ts` · `tests/screen.test.ts`