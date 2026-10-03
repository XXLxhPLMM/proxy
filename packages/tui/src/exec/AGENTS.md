# src/exec/ — 执行层（一条命令 → 若干行 + 一组副作用）

把 `@/cmd` 的一条命令变成**结果区的行** + **一组要 `app/` 做的副作用**。零 Ink、零 React、零终端、零 `fs`。

## 文件

- `run.ts` — 入口 `exec(command, deps)`、两个穷举 `switch`、`Effect` 契约、`targetWrite`。
- `rows.ts` — 响应体 → `LogRow[]`（`statusRows` / `configTable` / `userRows` / `usageRows` / `aclRows` / `changeRows` / `helpRows` …）；`configValue` 是**全包唯一**渲染配置值的地方。
- `failures.ts` — 一次失败 → 一句话（`controlFailure` / `ledgerFailure` / `noTarget` / `toneOfCode`）。
- `echo.ts` — 回显边界上唯一的凭据掩码出口（`echoOf` / `NO_PASSWORD_ARG`）。
- `index.ts` — barrel，**只转发**。

## 层不变量

- **执行层不碰状态**：只发请求、只读注入进来的东西，然后**说**发生了什么（`Effect`）；⚠️ 一旦 `setState`，判据都要起一个真界面才能验 —— 故零 React。
- ⚠️ **凭据不进任何一行**：回显行上的密码与 token 只以掩码形态出现（`echo.ts:echoOf` → `@/log/rows.js:maskEcho`），**失败文案也不许带它**；判据是「这是哪一类凭据」。
- **逐字限定不许改写**：`runningMeans` / `notice` / `effective` / `sideEffect` / `note` / `TuiError.message` 原样上屏 —— 措辞是**服务端**的知识。
- **`Effect` 是穷举的**：`applyEffect`（`@/app/app.tsx`）的 `switch` 带 `default: throw` ⇒ 加一档副作用就让 `tsc` 变红。
- **失败三档**的语义归 `@/utils/error.js`；转换点三处：本目录两个 + `@/app/failures.js` 一个。

## 相关路径 / 测试

- `@/cmd/index.js`（上游，回显要复现用户敲的那一串）/ `@/utils/index.js`（客户端经 `deps.client` **注入**；`TuiCode` / `TuiError` 从这里取）/ `@/api/index.js`（响应体**类型**）/ `@/log/index.js`（`LogRow` 形状）/ `@/ui/index.js`（格式化与 `planColumns`）。
- `tests/exec.test.ts` — 十条语义断言 + 「没有客户端就一个请求都不发」；负向判据都配正向对照。
