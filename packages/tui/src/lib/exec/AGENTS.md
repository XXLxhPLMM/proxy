# src/lib/exec/ — 执行层（一条命令 → 若干行 + 一组副作用）

把 `@/commands` 的一条命令变成**结果区的行** + **一组要状态层（`@/AppState.js`）做的副作用**。零 Ink、零 React、零终端、零 `fs`。

## 文件

- `run.ts` — 入口 `exec(command, deps)`、两个穷举 `switch`、`Effect` 契约、`ExecDeps`、`batchTargetNames`。
- `batch.ts` — `/batch` 的扇出：一条命令 → N 个控制面，**逐台 `try`**。
- `rows.ts` — 响应体 → `LogRow[]`（`statusRows` / `configTable` / `configOne` / `userRows` / `usageRows` / `aclRows` / `changeRows` / `helpRows` …）；`configValue` 是**全包唯一**渲染配置值的地方。
- `failures.ts` — 一次失败 → 一句话（`controlFailure` / `noTarget` / `toneOfCode`）。
- `echo.ts` — 回显边界的**留不留痕判据**（`leavesTrace`，一张**逐条对齐 `Command` 联合**的 `Record`）。
- `index.ts` — barrel，**只转发**。

## 相关路径 / 测试

- `@/commands/index.js`（上游，回显要复现用户敲的那一串）/ `@/lib/errors.js`（`TuiCode` / `TuiError`）/ `@/services/index.js`（客户端经 `deps.client` **注入**）/ `@/api/index.js`（响应体**类型**）/ `@/lib/log/index.js`（`LogRow` 形状）/ `@/lib/index.js`（格式化与 `planColumns`）。
- `tests/exec/` — 五档（①–⑤ `verbatim` / ⑥⑧⑨ `tables` / 失败三档 `failures` / ⑩ `no-target` / 纯界面动作与回显 `local-commands`）+ 「没有客户端就一个请求都不发」+「`/accounts` 一个请求都不发」；负向判据都配正向对照。