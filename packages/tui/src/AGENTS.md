# src/ — 组合根 + 应用状态层

`cli.tsx` 是本包**组合根**（采宿主、接管终端、管退出），`app/` 是**应用状态层**（持有全部跨帧状态）——
两处都不认识控制面数据的形状：那在 `@/api`（契约）与 `@/utils`（怎么把它发出去），变成一行字在 `@/exec`。
每个子目录自带一份 `AGENTS.md`。

| 路径 | 答什么 |
|---|---|
| `cli.tsx` | 组合根：宿主采一次（`env` / `os.homedir()` / 宽高 / `NO_COLOR` / 版本号）→ `enterFullScreen` → `mouse.start()` → `render(<App/>)` → 幂等 `finish()` |
| `index.ts` | 包入口 barrel（只转发 `App` / `main`） |
| `app/` | 应用状态层：跨帧状态、键位、鼠标分派 |
| `api/` | 控制面 HTTP **契约**：端点表（按服务端模块分段）/ 线格式 / 逐字段判据。**零 IO** |
| `utils/` | **工具面**：唯一拨号点 / 地址与路径的两处变换 / 失败三档词汇 / 收窄组合子 |
| `exec/` `log/` `cmd/` | 命令 → 行 + `Effect` / 行模型 / 命令表 |
| `view/` `ui/` `ledger/` `terminal/` | 坐标 + 组件 / 排版着色 / 台账 / 终端协议 |

## 层不变量

- ⚠️ **宿主采集只在 `cli.tsx` 一次**（`process.*` / `os.homedir()` / 宽高 / `NO_COLOR` / 版本号），全部当 props 往下传；⚠️ **宽与高同样重要**（缺了行数整个主区高度是 0），而宽高是**一次快照** —— 改宽窗口要重开一次，本层不挂 resize 监听。
- **import 期零副作用**。
- ⚠️ **退出先 `unmount()`**：只设 `process.exitCode`，且在 `waitUntilExit()` 之后才设 —— 三条到达路径共用一个幂等 `finish()`。

## 相关

`@/view/index.js` · `@/exec/index.js` · `@/ledger/index.js` · 根仓 `src/cli.ts`（组合根纪律的原文，⚠️ 那边是 cjs + `require.main`，别抄措辞） · `build.mjs`（`process.env.APP_VERSION` 那一行）
`tests/layout.test.ts` · `tests/input.test.ts` · 真终端那一半的**人工验收**见 `packages/tui/AGENTS.md`
