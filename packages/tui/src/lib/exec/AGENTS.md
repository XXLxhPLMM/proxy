# src/lib/exec/ — 执行层（一条命令 → 若干行 + 一组副作用）

把 `@/commands` 的一条命令变成**结果区的行** + **一组要状态层（`@/AppState.js`）做的副作用**。零 Ink、零 React、零终端、零 `fs`。

## 文件

- `run.ts` — 入口 `exec(command, deps)`、两个穷举 `switch`、`Effect` 契约、`targetWrite`、`batchTargetNames`。
- `batch.ts` — `/batch` 的扇出：一条命令 → N 个控制面，**逐台 `try`**。
- `rows.ts` — 响应体 → `LogRow[]`（`statusRows` / `configTable` / `userRows` / `usageRows` / `aclRows` / `changeRows` / `helpRows` / `providerRows` …）；`configValue` 是**全包唯一**渲染配置值的地方。
- `failures.ts` — 一次失败 → 一句话（`controlFailure` / `ledgerFailure` / `noTarget` / `toneOfCode`）。
- `echo.ts` — 回显边界：**留不留痕的判据**（`leavesTrace`，一张**逐条对齐 `Command` 联合**的 `Record`）与回显边界上唯一的凭据掩码出口（`echoOf` / `NO_PASSWORD_ARG`）。
- `index.ts` — barrel，**只转发**。

## 层不变量

- **执行层不碰状态**：只发请求、只读注入进来的东西，然后**说**发生了什么（`Effect`）；⚠️ 一旦 `setState`，判据都要起一个真界面才能验 —— 故零 React。
- ⚠️ **回显只由 `exec` 那一层加，且只给 `echo.ts:leavesTrace` 说「留痕」的那些**（纯界面动作 `/new` 与 `/managers` 一个字都不留，效果由侧边栏 / 窗口自己回答）；那张表**对齐 `Command` 那张判别联合**，故命令表加一条命令就编译期红（⚠️ 别把它改成数组 / `Set`，理由写在那张表头上）。
- ⚠️ **凭据不进任何一行**：回显行上的密码与 token 只以掩码形态出现（`echo.ts:echoOf` → `@/lib/log/rows.js:maskEcho`），**失败文案也不许带它**；判据是「这是哪一类凭据」。
- **逐字限定不许改写**：`runningMeans` / `notice` / `effective` / `sideEffect` / `note` / `TuiError.message` 原样上屏 —— 措辞是**服务端**的知识。
- **`Effect` 是穷举的**：`applyEffect`（`@/AppState.js`）的 `switch` 带 `default: throw` ⇒ 加一档副作用就让 `tsc` 变红。
- ⚠️ **`/batch` 自己一个请求都不发**：它只把「内层那一条命令 + 那一批目标」递给上层（`Effect:batch`），
  而扇出**由 `@/AppState.tsx:runBatch` 驱动**（`applyEffect` 那一支；⚠️ **不是** `@/lib/agent`——
  `ask()` 只把那条 `Effect` 递上去，它自己不扇出）—— 故本层**不读台账**（`deps.peers` 是唯一能看见台账的那一格，
  而它在 `@/AppState.js`）。⚠️ **`leavesTrace` 对它说「不留痕」**：留痕的话同一条命令会在屏上出现 N+1 次。
- ⚠️ **扇出的三条取舍就在这一条里（`batch.ts` 的文件头只留「逐台 `try`」那一半）**：① **串行**——`pump` 已经把命令串行化，
  而并发要在这条队列里再开一层并行度（「`/clear` 抹掉另一个会话刚落地半秒的结果」正是并发带来的）；
  ② 每台的 `timeoutMs` 各不相同，并发时**最慢那台决定整批**；③ **部分成功必须看得见**——
  串行下前几台的结果已经落桶，后一台挂掉只追加一句判据。
- ⚠️ **`BatchReport.ok` 的判据是「`rows` 里一个 `err` 都没有」**，**不是**「`exec` 没抛」：`exec` 把控制面的
  失败收进行里而很少抛，拿「没抛」当 `ok` 的话屏上永远是「N 台全部成功」——**一句假事实**。
  ⚠️ 而 `changed: false` 是**成功的 no-op**（服务端语义），故它**不算**失败。
- **失败三档**的语义归 `@/lib/errors.js`；转换点三处：本目录两个 + `@/lib/failures.js` 一个。

## 相关路径 / 测试

- `@/commands/index.js`（上游，回显要复现用户敲的那一串）/ `@/lib/errors.js`（`TuiCode` / `TuiError`）/ `@/services/index.js`（客户端经 `deps.client` **注入**）/ `@/api/index.js`（响应体**类型**）/ `@/lib/log/index.js`（`LogRow` 形状）/ `@/lib/index.js`（格式化与 `planColumns`）。
- `tests/exec/` — 十条语义断言**散在 6 个档**（①–⑤ `verbatim` / ⑥⑧⑨ `tables` / ⑦ `redaction` / ⑩ `no-target`）+ 「没有客户端就一个请求都不发」；负向判据都配正向对照。
