# src/ — 组合根 + 状态层 + 呈现层

`cli.tsx` 是本包**组合根**（采宿主、接管终端、管退出），`AppState.tsx` 是**应用状态层**（持有全部跨帧状态），
`app.tsx` 是**呈现层组合出口**（导出 `Layout`：算一次几何，按区域派给各块）。两处都不认识控制面数据的形状：那在 `@/api`（契约）与
`@/services`（怎么把它发出去），变成一行字在 `@/lib/exec`。
每个子目录自带一份 `AGENTS.md`。

| 路径 | 答什么 |
|---|---|
| `cli.tsx` | 组合根：宿主采一次（`homedir` / 宽高**初值** / `NO_COLOR` / 版本号）→ **装告警过滤器**（必须在加载 `node:sqlite` 之前）→ `enterFullScreen` → `mouse.start()` → `render(<App/>)` → 幂等 `finish()`（含 `closeLedgerDb()`） |
| `index.ts` | 包入口 barrel（只转发 `App` / `main`） |
| `AppState.tsx` | 应用状态层：跨帧状态、台账/探活/执行/面板/窗口的回调、呈现模型装配、渲染 |
| `app.tsx` | 呈现层组合出口 `Layout`：把这些块组装成整屏 |
| `api/` | 控制面 HTTP **契约**：端点表（按服务端模块分段）/ 线格式 / 逐字段判据。**零 IO** |
| `lib/` | 零 IO 的那一半：几何 / 排版 / 列宽 / **对话模型 + 行模型** / 输入串 / 失败词汇 / 收窄组合子 / 执行层 / **对话那一圈**（`agent.ts`） |
| `theme/` | 语义 → 颜色的唯一映射面（三张表 + 那些函数） |
| `services/` | 会动手的那一半：唯一**控制面**拨号点 + **模型 provider 拨号点** + 本机台账（一份 SQLite 库，含 provider 三样）+ 告警面 + 终端协议 |
| `commands/` | 命令表 + 值语法 + 分词 + 建议 + 补全 + 面板 |
| `components/` | 呈现层的词汇（props 契约 + 共用字形）与整屏的框（`layout/`） |
| `features/` | 一块块看得见的功能：会话栏 / 输入行 / 结果区 / 命令面板 / 引导屏 |
| `hooks/` | 三个订阅口：键位 / 鼠标 / 终端宽高 |
| `store/` | 跨帧状态的形状与常量（外加落盘那个会话的形状 `SessionRecord`） |

## 层不变量

- ⚠️ **宿主采集只在 `cli.tsx` 一次**（`process.*` / `os.homedir()` / 宽高 / `NO_COLOR` / 版本号），全部当 props 往下传；⚠️ **宽与高同样重要**（缺了行数整个主区高度是 0）。
- ⚠️ **宽高是「初值 + 全包唯一那一个 `resize` 订阅」**：`cli.tsx` 采的那一份只是**初值**（`FALLBACK_COLUMNS` /
  `FALLBACK_ROWS` 因此一直有意义），此后由 `@/hooks/useTerminalSize.ts` 跟踪；它读的是 Ink 从上下文递出来的那条流，
  **不在挂载时重采一次宿主**。⚠️ 少订阅那一次的症状**不是**「不重绘」（Ink 自己会重排它手里那**上一帧**，窄化时
  先 `clearTerminal` 再把那一帧填回去 ⇒ 屏上停着一帧旧布局，永不修复）。
- **import 期零副作用**。
- ⚠️ **退出先 `unmount()`**：只设 `process.exitCode`，且在 `waitUntilExit()` 之后才设 —— 三条到达路径共用一个幂等 `finish()`。
- ⚠️ **跨目录只引 barrel**（`@/` 指向本包 `src/`）；同目录与子目录内部用相对路径，且**禁止自我引用 barrel**。
  ⚠️ **已知的例外只有下面这几类，每一类都因为走 barrel 会成运行期环**（判据：`@/<dir>/index.js` 转发
  `<dir>/` 下的实现，而那些实现反过来要引那个 barrel ⇒ 自我引用；本清单靠
  `grep -rnoE '"@/[A-Za-z0-9_/.-]+\.js"' src/` 与 `grep -rnoE '"\.\./[A-Za-z0-9_/.-]+\.js"' src/`
  复核，**新添一条必须同时添进这里**，否则这条不变量就退化成一句「基本都这样」。
  ⚠️ **表里没有的那几条必须全是 `@/<dir>/index.js` 那个形状**（它们**就是** barrel）—— 逐条对得上才算复核过）：
  | 引用方 | 深层路径 | 成环理由 |
  |---|---|---|
  | `api/wire.ts` | `@/lib/decode.js` | `@/lib/index.js` 转发 `errors.js`，而 `errors.js` 与 `lib/exec/*` 反过来引 `@/api/index.js`，而 `@/api/index.js` 转发 `wire.js` |
  | `lib/geometry.ts` | `@/features/output/logo.js` | `features/output/` 没有自己的 barrel（`features/index.js` 转发那 **6** 个组件：`chat/` 两块 / `output/` 两块 / `sessions/` 两块），而 `@/features/index.js` → `./output/OutputView.js` → `@/lib/index.js` → `./geometry.js` ⇒ 绕一圈就回来了 |
  | `services/{config/connect,config/validate,manager-client}.ts` | `@/lib/errors.js` / `@/lib/http.js` | `@/lib/index.js` 转发 `failures.js`，而它引 `@/services/config/index.js`；`@/services/index.js` 转发 `./manager-client.js`，`@/services/config/*` 又引 `@/services/index.js` ⇒ 两个 barrel 互指，任何一侧经 barrel 取对方都成环 |
  | `components/layout/{close-chip,footer,window}.tsx` | `../constants.js` / `../types.js` | `@/components/index.js` 转发 `layout/*`，而 `layout/*` 要取 `tone`（运行期值）⇒ 经 barrel 回去就是 barrel 自我引用 |
  | `lib/log/rows.ts` | `../format.js` | `@/lib/index.js` 同时转发 `format.js` 与 `log/`，于是经 barrel 引自己的兄弟文件即自我引用 barrel |
  | `lib/agent.ts` | `@/services/model.js` | `@/services/index.js` 只转发 `manager-client.js` 与 `warnings.js`（`model.ts` **不在**里面，因为它是第二个拨号点）；而 `model.ts` 引 `@/commands/index.js` → … → `@/lib/exec/index.js` → `@/lib/index.js` ⇒ 经 `@/services/index.js` 回去就是绕回 `lib/` |
  | `AppState.tsx` | `@/lib/agent.js` | `@/lib/index.js` **刻意不转发** `agent.ts`（同 `exec/` 的理由：它引 `@/lib/exec/index.js` → `@/api/index.js` 与 `@/lib/index.js`，转发进来就是运行期环） |
  | `AppState.tsx` | `@/app.js` | `@/index.js` 转发 `./AppState.js` 本身 ⇒ 状态层经它取呈现层就是 barrel 自我引用 |
  | `cli.tsx` | `@/AppState.js` | `@/index.js` 转发 `./cli.js` 本身 ⇒ 组合根经它取状态层就是 barrel 自我引用 |
- ⚠️ **命令排队、一条一条跑**：`AppState.tsx:pump` 在 `finally` 里回调自己就是串行化的全部实现。
- ⚠️ **提交一行先分流**：`@/` 开头 → 命令（排队）；⚠️ **不以 `/` 开头 → 一句聊天消息**（走模型，
  **不走 `pump`** —— 那一圈自己要往返好几轮，而 `pump` 一次只跑一条）。两档都**先清输入行**。
- ⚠️ **不带输出行的那一次不许留下「一格空对话」**：桶里有内容而屏上零行 ⇒ 引导屏被顶掉，
  而 `/new` / `/managers` 那些纯界面动作正是这一档（判据是 `result.rows.length > 0`）。
- ⚠️ **侧边栏那一列的每个动作都有键盘第二路**（右键在很多终端里压根到不了，见 `packages/tui/AGENTS.md`）：
  关掉会话 = `Ctrl+X` / 菜单里的「删除会话」/ 那枚 `✕`；新开会话 = `/new` / 菜单里的「新建会话」；
  改名 = `Ctrl+R` / `/rename` / 菜单里的「重命名」；藏起来 = `/session hide <名字>`（它根本不是鼠标动作）——
  理由见 `@/components/AGENTS.md` 与 `@/hooks/AGENTS.md`。
- ⚠️ **改名框就是输入行**（`AppState.tsx` 的 `rename` 状态 + 输入区那一行提示 + 提示符换成 `✎`），
  故「能从键盘走完」是白得的；而框里那串字**不写进会话的 `input`** —— 取消之后那一行必须还是取消之前那一串。

## 相关

`@/services/index.js` · `@/lib/index.js` · `@/lib/exec/index.js` · `@/services/config/index.js` · 根仓 `src/cli.ts`（组合根纪律的原文，⚠️ 那边是 cjs + `require.main`，别抄措辞） · `build.mjs`（`process.env.APP_VERSION` 那一行）
`tests/layout/` · `tests/input/screen-geometry.test.ts`（含「改窗口大小」那一档假 TTY 真渲染） · 真终端那一半的**人工验收**见 `packages/tui/AGENTS.md`
