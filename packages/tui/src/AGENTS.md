# src/ — 组合根 + 状态层 + 呈现层

`cli.tsx` 是**组合根**（采宿主、接管终端、管退出），`AppState.tsx` 是**应用状态层**（持有全部跨帧状态），
`app.tsx` 是**呈现层组合出口**（导出 `Layout`）。两处都不认识控制面数据的形状：那在 `@/api`（契约）与 `@/services`（怎么发出去），变成一行字在 `@/lib/exec`。每个子目录自带一份 `AGENTS.md`。

| 路径 | 答什么 |
|---|---|
| `cli.tsx` | 组合根：宿主采一次 → **装告警过滤器**（必须在加载 `node:sqlite` 之前）→ `enterFullScreen` → `mouse.start()` → `render(<App/>)` → 幂等 `finish()`（含 `closeLedgerDb()`） |
| `index.ts` | 包入口 barrel（只转发 `App` / `main`） |
| `AppState.tsx` | 应用状态层：跨帧状态、台账/探活/执行/面板/窗口的回调、呈现模型装配、渲染 |
| `app.tsx` | 呈现层组合出口 `Layout`：把这些块组装成整屏 |
| `api/` | 控制面 HTTP **契约**：端点表 / 线格式 / 逐字段判据。**零 IO** |
| `lib/` | 零 IO 的那一半：几何 / 排版 / 列宽 / 对话模型 + 行模型 / 输入串 / 失败词汇 / 收窄组合子 / 执行层 / `agent.ts` |
| `theme/` | 语义 → 颜色的唯一映射面（三张表 + 那些函数） |
| `services/` | 会动手的那一半：唯一**控制面**拨号点 + **模型 provider 拨号点** + 本机台账（一份 SQLite 库，含 provider 三样）+ 告警面 + 终端协议 |
| `commands/` | 命令表 + 值语法 + 分词 + 建议 + 补全 + 面板 |
| `components/` | 呈现层的词汇（props 契约 + 共用字形）与整屏的框（`layout/`） |
| `features/` | 一块块看得见的功能：会话栏 / 输入行 / 结果区 / 命令面板 / 引导屏 |
| `hooks/` | 三个订阅口：键位 / 鼠标 / 终端宽高 |
| `store/` | 跨帧状态的形状与常量（外加落盘那个会话的形状 `SessionRecord`） |

⚠️ **本文件的写法**：一条 bullet = 一个不变量 + 牙齿。推导不写（能从代码与测试名重新推出来的，写在这里只会腐烂）；`⚠️` 只标真禁忌。

## 层不变量

- ⚠️ **宿主采集只在 `cli.tsx` 一次**（`process.*` / `os.homedir()` / 宽高 / `NO_COLOR` / 版本号），全部当 props 往下传。⚠️ **宽与高同样重要**（缺了行数整个主区高度是 0）。⚠️ **版本号逐字读 `process.env.APP_VERSION`**——`build.mjs` 的 esbuild `define` 替换的正是那段文本，写成解构或 `process.env` 展开就绕过替换。判据：`tests/meta/version-parity.test.ts`。
- ⚠️ **宽高是「初值 + 全包唯一那一个 `resize` 订阅」**：`cli.tsx` 采的那份只是**初值**（`FALLBACK_COLUMNS` / `FALLBACK_ROWS` 因此一直有意义），此后由 `@/hooks/useTerminalSize.ts` 跟踪。⚠️ 少订阅那一次的症状**不是**「不重绘」——Ink 自己会重排它手里那**上一帧**（窄化时先 `clearTerminal` 再填回去）⇒ 屏上停着一帧旧布局，永不修复。
- **import 期零副作用**。
- ⚠️ **退出只经命令**（`/exit` 与 `/quit`，两个名字**一个 `Command` 变体**（`kind: "exit"`）），而 `exitOnCtrlC: false` 是这个决定的一半：`Ctrl+C` **刻意什么都不做**。⚠️ **那扇门必须在 `/help` 上找得到**（只有隐藏后门能出去是陷阱）。退出路径**唯一**：命令 → `exec` 的 `request-exit` → `applyEffect` → props 那个 `exit` → `cli.tsx` 那个幂等 `finish(0, null)`。⚠️ **忙的时候拒绝**（队列非空 / 有 exec 在飞 / 模型在跑），而拒绝**不会把人卡死**（队列串行且有限，每次在飞的操作都有上界）。牙齿：`tests/input/exit.test.ts` 与 `exit-route.test.ts`（后者走注入点断「退出码真的是 0」与 `finish` 幂等——真 TTY 之外读不到 `process.exitCode`）。
- ⚠️ **退出先 `unmount()`**：只设 `process.exitCode`，且在 `waitUntilExit()` 之后才设。⚠️ **幂等不靠 `finish` 自己记标志**，而是它调的那几件东西**各自**带守卫（`chainRestores` 的 `done` / `closeLedgerDb` 的「先清引用」/ `installSqliteWarningFilter` 的 `released`）⇒ 第二次调用是空操作。`cli.tsx` 把那几件**全部注入**（`exitBoundary(steps)`）——`process.exitCode` 与终端字节在真 TTY 之外读不到，而注入之后「两次调用的可观察后果」能被逐字断言。
- ⚠️ **一个会话都没有是合法状态**（`activeId: null` 是一个真答案而不是「忘了设」），而几何层那一列给 `null` 时主区**占满整屏宽**（`sidebar === null` ⇒ 拖宽手柄压根不画）。⚠️ **输入消息 / 敲命令 / `/new` 时自动新建一个，且必须先于那一次操作**——输入行住在会话上，没有会话时那些字无处可去（症状是「敲了一串字再按回车什么都没发生」）。⚠️ **「至少留一个会话」那道闸不存在**（零兼容）：留着它的话删掉最后一个会话就被一条看不见的守卫否掉，而屏上零解释。
- ⚠️ **命令排队、一条一条跑**：`AppState.tsx:pump` 在 `finally` 里回调自己就是串行化的全部实现。
- **提交一行先分流**：`@/` 开头 → 命令（排队）；**不以 `/` 开头 → 一句聊天消息**（走模型，**不走 `pump`**——那一圈自己要往返好几轮，而 `pump` 一次只跑一条）。两档都**先清输入行**。
- **不带输出行的那一次不许留下「一格空对话」**：桶里有内容而屏上零行 ⇒ 引导屏被顶掉（判据是 `result.rows.length > 0`）。
- ⚠️ **侧边栏那一列的每个动作都有键盘第二路**（右键在很多终端里压根到不了，见包根那份手验清单）：移出 = `Ctrl+X` / 菜单 / 那枚 `✕`；新开会话 = `/new` / 菜单；改名 = `Ctrl+R` / `/rename` / 菜单。⚠️ **这三个动作一律是「从侧边栏移出」而不是「删除」**（只动 `sidebar_sessions`，`sessions` 与 `messages` 一个字都不动）。⚠️ **永久删除只存在于历史会话弹窗的 `Ctrl+D`**（级联三张表），而「移出」在那一档另有第二条路：点那一行 = **激活它**（不是删）。⚠️ **可见性不是命令能改的东西**——它归 `sidebar_sessions` 那张表答（清单里有没有那一行；理由见 `@/hooks/AGENTS.md`）。
- ⚠️ **改名框只住在历史会话弹窗里**（`AppState.tsx` 的 `rename` + 弹窗末尾那个 `input` 槽位），且 ⚠️ **输入区恒用 `PROMPT`、不画插入符**（`Composer` 恒是真输入行：留在屏上的光标块等于说「焦点还在输入框」）。**四个入口一个实现**（`/rename` / `Ctrl+R` / 菜单那项 / 弹窗里 `Ctrl+R` 都走 `openRename`）；⚠️ 而框里那串字**不写进会话的 `input`**——取消之后输入区那一行必须还是取消之前那一串。

### ⚠️ 跨目录只引 barrel（`@/`），已知例外逐条列得出

同目录与子目录内部用相对路径，**禁止自我引用 barrel**。例外只有下面这几类，每一类都因为走 barrel 会成运行期环。判据：`@/<dir>/index.js` 转发 `<dir>/` 下的实现，而那些实现反过来要引那个 barrel。**本清单靠 `grep -rnoE '"@/[A-Za-z0-9_/.-]+\.js"' src/` 与 `grep -rnoE '"\.\./[A-Za-z0-9_/.-]+\.js"' src/` 复核，新添一条必须同时添进这里**，否则这条不变量就退化成一句「基本都这样」。**表里没有的那几条必须全是 `@/<dir>/index.js` 那个形状**（它们**就是** barrel）——逐条对得上才算复核过：

| 引用方 | 深层路径 | 成环理由 |
|---|---|---|
| `api/wire.ts` | `@/lib/decode.js` | `@/lib/index.js` 转发 `errors.js`，而 `errors.js` 与 `lib/exec/*` 反过来引 `@/api/index.js`，而 `@/api/index.js` 转发 `wire.js` |
| `lib/geometry.ts` | `@/features/output/logo.js` | `features/output/` 没有自己的 barrel（`features/index.js` 转发那 **7** 个组件），而 `@/features/index.js` → `./output/OutputView.js` → `@/lib/index.js` → `./geometry.js` ⇒ 绕一圈就回来了 |
| `services/{config/connect,config/validate,manager-client}.ts` | `@/lib/errors.js` / `@/lib/http.js` | `@/lib/index.js` 转发 `failures.js`（它引 `@/services/config/index.js`），而 `@/services/index.js` 转发 `./manager-client.js`，`config/*` 又引 `@/services/index.js` ⇒ 两个 barrel 互指 |
| `components/layout/{close-chip,footer,window,window-card}.tsx` · `window-slots.ts` | `../constants.js` / `../types.js` | `@/components/index.js` 转发 `layout/*`，而 `layout/*` 要取 `tone`（**运行期值**）⇒ 经 barrel 回去就是 barrel 自我引用 |
| `lib/log/rows.ts` | `../format.js` | `@/lib/index.js` 同时转发 `format.js` 与 `log/` ⇒ 经 barrel 引自己的兄弟文件即自我引用 |
| `lib/agent.ts` | `@/services/model.js` | `@/services/index.js` 只转发 `manager-client.js` 与 `warnings.js`（`model.ts` **不在**里面，它是第二个拨号点）；而 `model.ts` 引 `@/commands/index.js` → … → `@/lib/exec/index.js` → `@/lib/index.js` ⇒ 经 `@/services/index.js` 回去就绕回 `lib/` |
| `AppState.tsx` | `@/lib/agent.js` | `@/lib/index.js` **刻意不转发** `agent.ts`（同 `exec/` 的理由） |
| `AppState.tsx` | `@/app.js` | `@/index.js` 转发 `./AppState.js` 本身 ⇒ 状态层经它取呈现层就是 barrel 自我引用 |
| `cli.tsx` | `@/AppState.js` | `@/index.js` 转发 `./cli.js` 本身 ⇒ 组合根经它取状态层就是 barrel 自我引用 |

## 输入协议：kitty 键盘报文

- ⚠️ **那一族键位（`Ctrl+Enter` / `Ctrl+↑↓` / `Shift+←→`）唯一的活路是 `kittyKeyboard`，而那一格不许删**：不带它，非 kitty 终端上 **`Ctrl+M` 与 `Enter` 是同一个字节**（CR，Ink 的 `parseKeypress` 两者都解成 `{return}`）⇒ 那三族在真终端上**全是死的**，而症状是「键位表写着它在、假 TTY 那一档也绿，真终端上按不动」。逐条见 `@/hooks/AGENTS.md`。
- ⚠️ **`mode: "auto"` 的代价是一次 `CSI ? u` 探测 + 200ms 超时**（Ink 那边就是一个 `setTimeout(cleanup, 200)`）——**一次性**，不是每帧。⚠️ **不选 `"enabled"` 的理由是「省下的 200ms 不值得拿『假定』去换」**：它跳过探测直接发 `CSI > <flags> u`，而那族键位能不能用取决于「**这个终端到底发不发那种报文**」——那件事只能问终端本人，没有哪张本包自己维护的名单能替它答。

## 相关

`@/services/index.js` · `@/lib/index.js` · `@/lib/exec/index.js` · `@/services/config/index.js` · 根仓 `src/cli.ts`（组合根纪律的原文，那边是 cjs + `require.main`，别抄措辞） · `build.mjs`（`process.env.APP_VERSION` 那一行） · `tests/layout/` · `tests/input/screen-geometry.test.ts` · 真终端那一半的人工验收见 `packages/tui/AGENTS.md`