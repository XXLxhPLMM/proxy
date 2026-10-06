# src/ — 组合根 + 状态层 + 呈现层

`cli.tsx` 是**组合根**（采宿主、接管终端、管退出），`AppState.tsx` 是**应用状态层**（持有全部跨帧状态），
`app.tsx` 是**呈现层组合出口**（导出 `Layout`）。两处都不认识控制面数据的形状：那在 `@/api`（契约）与 `@/services`（怎么发出去），变成一行字在 `@/lib/exec`。每个子目录自带一份 `AGENTS.md`。

| 路径 | 答什么 |
|---|---|
| `cli.tsx` | 组合根：宿主采一次 → **装告警过滤器**（必须在加载 `node:sqlite` 之前）→ `enterFullScreen` → `mouse.start()` → `render(<App/>)` → 幂等 `finish()`（含 `closeLedgerDb()`） |
| `index.ts` | 包入口 barrel（只转发 `App` / `main`） |
| `AppState.tsx` | 应用状态层：跨帧状态、台账/探活/执行/面板/窗口的回调、呈现模型装配、渲染 |
| `app.tsx` | 呈现层组合出口 `Layout`：把这些块组装成整屏 |
| `api/` | 控制面 HTTP **契约 + 拨号**：**一个端点一个函数**（`(method, path)`、逐字段判据、剥不剥信封同住）/ **唯一**那条 `axios.request`（`send.ts`）/ 响应体类型（`z.infer` 从 schema 推）。⚠️ 地址与 token 是**函数参数**（`ManagerTarget` 三格普通数据），没有「客户端对象」这一层 |
| `lib/` | 零 IO 的那一半：几何 / 排版 / 列宽 / 对话模型 + 行模型 / 输入串 / 失败词汇 / 执行层 / `agent.ts`（⚠️ **判据在 `@/api`**，那边用 zod） |
| `theme/` | 语义 → 颜色的唯一映射面（三张表 + 那些函数） |
| `services/` | 本机这一侧：台账（一份 SQLite 库，含 provider 三样）+ **模型 provider 拨号点** + 告警面 + 终端协议。⚠️ **控制面的拨号在 `@/api`**，本目录只递三格数据进去 |
| `commands/` | 命令表 + 值语法 + 分词 + 建议 + 补全 + 面板 |
| `components/` | 呈现层的词汇（props 契约 + 共用字形）与整屏的框（`layout/`） |
| `features/` | 一块块看得见的功能：会话栏 / 输入行 / 结果区 / 命令面板 / 引导屏 |
| `hooks/` | 三个订阅口：键位 / 鼠标 / 终端宽高 |
| `store/` | 跨帧状态的形状与常量（外加落盘那个会话的形状 `SessionRecord`） |

⚠️ **本文件的写法**：推导不写（能从代码与测试名重新推出来的，写在这里只会腐烂）；`⚠️` 只标真禁忌。

## 输入协议：kitty 键盘报文

- ⚠️ **那一族键位（`Ctrl+Enter` / `Ctrl+↑↓` / `Shift+←→`）唯一的活路是 `kittyKeyboard`，而那一格不许删**：不带它，非 kitty 终端上 **`Ctrl+M` 与 `Enter` 是同一个字节**（CR，Ink 的 `parseKeypress` 两者都解成 `{return}`）⇒ 那三族在真终端上**全是死的**，而症状是「键位表写着它在、假 TTY 那一档也绿，真终端上按不动」。逐条见 `@/hooks/AGENTS.md`。
- ⚠️ **`mode: "auto"` 的代价是一次 `CSI ? u` 探测 + 200ms 超时**（Ink 那边就是一个 `setTimeout(cleanup, 200)`）——**一次性**，不是每帧。⚠️ **不选 `"enabled"` 的理由是「省下的 200ms 不值得拿『假定』去换」**：它跳过探测直接发 `CSI > <flags> u`，而那族键位能不能用取决于「**这个终端到底发不发那种报文**」——那件事只能问终端本人，没有哪张本包自己维护的名单能替它答。

## 相关

`@/services/index.js` · `@/lib/index.js` · `@/lib/exec/index.js` · `@/services/config/index.js` · 根仓 `src/cli.ts`（组合根纪律的原文，那边是 cjs + `require.main`，别抄措辞） · `build.mjs`（`process.env.APP_VERSION` 那一行） · `tests/layout/` · `tests/input/screen-geometry.test.ts` · 真终端那一半的人工验收见 `packages/tui/AGENTS.md`