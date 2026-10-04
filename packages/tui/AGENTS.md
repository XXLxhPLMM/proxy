# packages/tui/ — `@b-hole/proxy-tui`（控制面终端控制台）

独立 pnpm 包：回答「怎么在终端里驱动**别的机器上**那个控制面」。机制细节归各目录 `AGENTS.md` 与源码文件头；拆包的三条理由见根 `AGENTS.md`「两个包」一节。

## 地图

（`src/` 内部的分层与层不变量归 `src/AGENTS.md` 与各子目录的 `AGENTS.md`；这里是**包这一层**的地图）

- `src/api/` — 控制面 HTTP **契约**（本包对线上契约的全部声明，**零 IO**）：端点表（`endpoints/` 下按服务端模块分段，装配成一条平表）/ 线格式 / 逐字段判据。⚠️ **路径完全不动**
- `src/lib/` — **零 IO 的那一半**：屏幕几何（坐标的唯一真相）/ 排版 / 列宽 / 输入串 / 失败三档词汇 / 收窄组合子 + 两个子目录（`log/` 行模型与对话模型 / `exec/` 执行层）+ **`agent.ts`（对话那一圈**：用户一句话 → 模型挑一条 `Command` → 走现有 `exec()`）
- `src/theme/` — 语义 → 颜色的唯一映射面（三张表 + `themeOf` / `toneColor` / `connectionMark` …）
- `src/services/` — **会动手的那一半**：唯一拨号点 + 本机台账（`config/`，一份 `~/.config/swain-proxy/tui.db`）+ 告警面（`warnings.ts`）+ 终端协议（`terminal/`）+ **模型那一侧的拨号点**（`model.ts`）
- `src/commands/` — 命令表（`specs`）+ 值语法 + 分词 + 建议 + 补全 + 面板
- `src/components/` — 呈现层的词汇（props 契约 + 共用字形）与整屏的框（`layout/`）
- `src/features/` — 一块块看得见的功能：会话栏 / 输入行 / 命令面板 / 结果区 / 引导屏
- `src/hooks/` — 三个订阅口：键位 / 鼠标分派 / 终端宽高（`resize`）
- `src/store/` — 跨帧状态的形状与常量（`Session` / `Bucket` / `Job` / `WindowKind` / `SessionRecord`）
- `src/cli.tsx` — 组合根：唯一的宿主采集面 + **告警过滤器** + 退出边界（含 `closeLedgerDb()`）
- `src/AppState.tsx` — 应用状态层：跨帧状态与呈现模型装配
- `src/app.tsx` — 呈现层组合出口（导出 `Layout`）：算一次几何，按区域派给各块
- `tests/` — vitest 档（`pnpm test:tui`），含两档**假 TTY 真渲染**
- `dist/` — **产物** `cli.js`（ESM）；只有 `pnpm build:tui` 会重建它

## 模型：它能做什么、不能做什么

- ⚠️ **模型输出的是一条 `Command`，而不是一个请求。** 整条链是
  `submit` → `ask()`（`@/lib/agent.ts`）→ `askModel()`（`@/services/model.ts`）→ **模型回一行文本**
  → `commandOfReply()`（**逐字过一遍 `parseLine`**）→ 现有 `exec()`。
  而「模型能让本包打哪些地址」**恒等于**「`COMMAND_SPECS` 里有哪些命令」—— 不是一条纪律，是一个类型。
- ⚠️ **模型绝不许拿到 `ManagerClient`**。三条理由，各自独立成立：
  ① **端点契约**：控制面的 `(method, path)` 只有一个来源（`src/api/endpoints/`，根仓那道护栏从源码文本现取）。
     给模型一个 client 就是给它一条**绕过那张表**的路，于是「对面变了」这一整类事故从「一句看得见的话」
     退化成「一个静默的 404 / 一次打错的写」；
  ② **凭据**：`ManagerClient` 把它自己的 `token` 装进 `Authorization` 头，而一次模型驱动的请求意味着
     **每一轮对话都带着那个 token 出网**（进 provider 的日志、进重试、进任何一层的错误文本）；
  ③ **SSRF**：一个不受约束的 URL + 一个跟着走的凭据，是这类工具最经典的一个洞。
  ⚠️ 牙齿在 `tests/agent.test.ts` 不变量 ①（源码级：`services/model.ts` 与 `lib/agent.ts` 的**代码**里
  没有 `ManagerClient` / `ENDPOINTS`；请求体里没有 token 与地址）。
- ⚠️ **模型看得见的面只有两档**（`messagesOf` 只取 `user` / `assistant`）：`tool-result` 是**本包与控制面
  之间的私事**（账号名、配额、地址），而 `error` **刻意不给**——把失败原文喂回模型等于让它模仿一句假事实。
  ⚠️ 这是**已知取舍**：控制面的数据会进 provider 的那台机器。这是「让模型替你操作控制面」的固有代价，
  而本包能做的是**不让凭据跟着走**（`apiKey` 只往 provider 去，`token` 一步都不出 `@/services/manager-client.ts`）。
- ⚠️ **工具说明从 `COMMAND_SPECS` 现算**（`toolDigest()`），**不许另抄一份**：模型照着那份错的挑命令，
  而命令表加一条它就得跟着走。牙齿：`tests/agent.test.ts` 不变量 ②。
- ⚠️ **provider 没配好时那句话仍然留在屏上**，后面跟一句「还没配 provider · 怎么配」（`ask()` 的
  `no-provider` 那一档）。⚠️ **不许崩、不许静默** —— 而那一档**一个请求都不发**。
- ⚠️ **模型那一句必须对得上屏面事实**：`/batch` 是**唯一一个零行却异步产出 N 份行**的命令，而那一格
  **先于**副作用落桶 ⇒ 那句话按 `effects` 分流、指向**下面**（⚠️ **不许转述对面返回的数据**）。
  牙齿：`tests/input.test.ts`「模型挑 `/batch`」那一档 —— 走**真 `ask()`** + 假 fetch，断屏上顺序。

## `/batch`：一条命令 → N 个控制面

- **N 从哪儿来**：**显式列出**（`/batch prod,stage /users`，按**台账顺序**展开）或 **`all`**（台账里的全部）。
  ⚠️ **刻意不做「记住上次选择」**：那会让**同一条命令在不同时刻打到不同机器上**，
  而这是一个**驱动别人机器**的终端 —— 「上次打过哪儿」不该成为「这次打哪儿」的默认值。
- **串行**，不并发（三条取舍就在 `src/lib/exec/AGENTS.md` 那一节，⚠️ 不在任何文件头上）。
- ⚠️ **N = 0 时说一句「台账里没有这些控制面」**，不是静默空跑。

## 呈现层：零外部组件库

⚠️ **呈现层的词汇全部在 `src/components/` 与 `src/features/`**，依赖面只有 `ink` / `react` /
`string-width`。判据是**依赖面**（`tests/input.test.ts`「呈现层」那一档读的是 `package.json`），
不是「某个 import」—— 装了而没引与引了而没装是两种事，而只有前者能在引入之前就红。

逐个组件的否决理由（**每条一行**，它们各自独立成立，而合起来才是「一个都不换」）：

- `Spinner` — `setInterval(80ms)` **无条件**、没有 `isActive`：本包布局恒等于 `rows` 高 ⇒ 每一次定时器
  回调都是一整帧 fullscreen（实测「50 条移动报告写 0 字节」那一档变成 **1224 字节** ⇒ 一动鼠标就卡）。
- `TextInput` — 光标的颜色**硬写 chalk**，绕过 `@/theme`（无色终端与色档在那儿会分叉）；
  而 `useTextInput` **不接管 `Esc`**，与「改名框就是输入行、框开着时 `Esc` 取消」直接冲突。
- `Select` — 要能当菜单用就得**自带几何**，而本包的菜单坐标只有 `Geometry.menu` / `menuRows` 一份真相。
- `Badge` / `StatusMessage` — 另一套主题（它那个 `ThemeProvider` 与 `@/theme` 的三张表不是同一张）。
- `Modal` / `Dialog` / `Overlay` / `Table` / `KeyValue` / `Tabs` / `Toast` — 那个库**根本没有**。

⚠️ **不引入换来了什么**（两条可判定的后果，缺了任一条「不引入」就只是一句偏好）：
① 全包 `src/` **一处 `setInterval` 都没有**（唯一的定时器是消息那一记 8 秒的 `setTimeout`）；
② **全包只有一处 `useInput`**（`hooks/useHotkeys.ts`）⇒ 改名框的 `Esc` 归**自己的**输入行管，
而换个自带输入的组件就会长出第二个收键者（抢键，屏上零报错）。

## 注释体量那道护栏的已知缺口

⚠️ `tests/comment-budget.test.ts` **只管体量不管对错**：一行注释只要不超过 6 / 3 / 12 行就绿，
而**内容腐烂**（点名一个已删掉的符号、指向一个不存在的章节、把三块说成两块）它一条都逮不到。
故文档与注释的**真实性**靠人读：改动一处事实时，同一次提交里把引用它的那几处一起改掉。

## 不可破的事实

- **产物必须是 ESM**：`ink` 有一句顶层 `await import`，esbuild 的 `cjs` 输出表达不了 —— ⚠️ 卡的是**输出格式**，不是「Ink 不能 bundle」。⚠️ 故入口判据是 `import.meta.url` 与 `process.argv[1]` 的 `file:` URL **逐字相等**（没有 `require.main` 可用；不相等就落空成「什么也不做、退出码 0」）。
- **端点契约是手抄的弱耦合**（对面可能跑着旧版本服务端）：路径集合归根仓 `tests/unit/manager-tui-contract.test.ts` 两侧目录**现列**、从源码文本现取再比，字段形状归 `src/api/wire.ts`。⚠️ **加端点必须同时改 `src/api/endpoints/` 下与服务端同名的那个模块文件**（护栏只比集合，不看你怎么分文件）。
  ⚠️⚠️ **`src/api/` 的路径是本包唯一不许动的一块**：那道护栏与 `@/api/wire.js` 的 `WireContractAssertions` 都**从源码文本现取/现编译**，两侧路径一旦漂了，护栏要么找不到文件要么恒空。`api/wire.ts` 因此只能引 `@/lib/` 的**叶子**（今天只有 `decode`），**不许引 `@/lib/index.js`** —— 那会成环（`lib/index.js` 转发 `errors.js`，而它反过来引 `@/api/index.js`）。文件位置与文件名一律不动。
- ⚠️ **本机状态在一个 SQLite 库里**：路径**固定**为 `~/.config/swain-proxy/tui.db`（**任何环境变量覆盖都不接**，
  零兼容），schema 与错误语义见 `src/services/config/AGENTS.md`。⚠️ `meta` 表里除 `selected` 外还放着
  **模型 provider 的三样东西**（地址 / 模型名 / 凭据，带 `provider.` 前缀）—— **凭据与 `targets.token` 同级**，
  防线同一条（`0600` 库 + `0700` 目录 + `redactProvider` 是**唯一**的打码出口）。
- **`packages: "external"` 是选择不是要求**（免得产物拖上只在 `DEV` 下干活的 peer `react-devtools-core`）；改回 bundle 是正当演进，但要当选择来改。
- ⚠️ **动了本包 `src/` 必须 `pnpm build:tui`**（或 `build:all`）：根 `pnpm build` 不碰 `dist/cli.js` ⇒ 四条全绿是**假信号**；**别为此加单测**，test 在 build **之前**。

**人工验收（单测测不到的一半）**：`pnpm dev:tui` 后在真终端里手验**鼠标上报**、**退出后终端是否干净**（屏幕恢复 / 光标可见 / 鼠标能拖选粘贴）与**改窗口大小（拉宽拉窄终端）**—— Ink 自己会重排它手里那**上一帧**，而应用必须按**新的**高宽重排一帧新的；`tests/input.test.ts` 那一档只验得「resize 之后屏上那一帧按新尺寸重排了」，真终端上还得看有没有闪一帧旧布局、有没有卡住；端到端从**临时 cwd** 起控制面，⚠️ 别在仓库根起：
`cd <临时目录> && MANAGER_ENABLED=true MANAGER_PORT=18080 MANAGER_TOKEN=… AUTH_ENABLED=false PROXY_PROTOCOL=http node <repo>/dist/app.js`

⚠️ **右键那一半在很多终端里压根到不了**：Windows Terminal 与一批终端在右键时弹出**自己的**菜单，
并且**不把那次按下转发给应用** —— 那一层在终端模拟器里，本包管不着（见 `src/services/terminal/AGENTS.md`
那一节）。故「右键某一项 = 弹出那个菜单」「右键空白处 = 新开会话那一项」必须**记成一个「取决于终端」的
功能**，不许当它是到处都能用的入口；菜单里的**每个动作**因此各有第二条纯键盘的路：关掉会话 = `Ctrl+X`、
新开会话 = `/new`、改名 = `Ctrl+R` 或 `/rename`、藏起来 = `/session hide <名字>`（它根本不是鼠标动作）。
⚠️ 同一条推论适用于**手验清单**：右键那两条在 Windows Terminal 上**验不了**，别把它记成「功能坏了」——
先确认你那个终端发不发 `ESC[<2;…M`。

⚠️ **悬停那一枚「✕」在按 CJK 宽度渲染的终端里会差一列**：`✕`（U+2715）的 East Asian Width 是
**Ambiguous**，而按一列算的 `string-width` 与按两列画的终端对它给不同答案（理由与缓解见
`src/lib/geometry.ts` 的 `SESSION_CLOSE_COLUMNS`）。手验时要把侧边栏**拖到最窄**
（`SIDEBAR_MIN_WIDTH`）看一眼那一行会不会宽出一列。
