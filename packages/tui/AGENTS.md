# packages/tui/ — `@b-hole/proxy-tui`（控制面终端控制台）

独立 pnpm 包：回答「怎么在终端里驱动**别的机器上**那个控制面」。机制细节归各目录 `AGENTS.md` 与源码文件头；拆包的三条理由见根 `AGENTS.md`「两个包」一节。

⚠️ **本文件的写法**：一条 bullet = 一个不变量 + 牙齿（哪条断言钉住它）。推导一律不写——能从代码与测试名重新推出来的东西，写在这里只会腐烂。⚠️ **`⚠️` 只标真禁忌**（改了会静默出事那种），背景与「为什么」不带。

## 地图

（`src/` 内部分层与层不变量归 `src/AGENTS.md` 与各子目录的 `AGENTS.md`；这里是**包这一层**的地图）

- `src/api/` — 控制面 HTTP **契约**（本包对线上契约的全部声明，**零 IO**）：端点表（`endpoints/` 下按服务端模块分段）/ 线格式 / 逐字段判据。路径完全不动
- `src/lib/` — **零 IO 的那一半**：屏幕几何（坐标的唯一真相）/ 排版 / 列宽 / 输入串 / 失败三档词汇 / 收窄组合子 + 两个子目录（`log/` 行模型与对话模型 / `exec/` 执行层）+ `agent.ts`（对话那一圈）
- `src/theme/` — 语义 → 颜色 / 字形的唯一映射面（三张表 + `themeOf` / `toneColor` / `connectionMark` / `toastMark` / `runMarkOf` …）
- `src/services/` — **会动手的那一半**：唯一拨号点 + 本机台账（`config/`，一份 `~/.config/swain-proxy/tui.db`）+ 告警面（`warnings.ts`）+ 终端协议（`terminal/`）+ 模型那一侧的拨号点（`model.ts`）
- `src/commands/` — 命令表（`specs`）+ 值语法 + 分词 + 建议 + 补全 + 面板
- `src/components/` — 呈现层的词汇（props 契约 + 共用字形）与整屏的框（`layout/`，含**模态卡片的外壳与槽位序**）
- `src/features/` — 一块块看得见的功能：会话栏 / 会话菜单 / 历史会话弹窗 / 输入行 / 命令面板 / 结果区 / 引导屏
- `src/hooks/` — 三个订阅口：键位 / 鼠标分派 / 终端宽高（`resize`）
- `src/store/` — 跨帧状态的形状与常量（`Session` / `Bucket` / `Job` / `WindowKind` / `RunState` / `SessionRecord` / `SidebarEntry`）
- `src/cli.tsx` — 组合根：唯一的宿主采集面 + **告警过滤器** + 退出边界（含 `closeLedgerDb()`）
- `src/AppState.tsx` — 应用状态层：跨帧状态与呈现模型装配
- `src/app.tsx` — 呈现层组合出口（导出 `Layout`）：算一次几何，按区域派给各块
- `tests/` — vitest 档（`pnpm test:tui`），含两档**假 TTY 真渲染**。见下面「测试布局」一节
- `dist/` — **产物** `cli.js`（ESM）；只有 `pnpm build:tui` 会重建它

## 版本号：两个真相源，恒相等

- 屏上那个版本号来自**本子包自己那份清单**（`build.mjs` 的 `readVersion()` 经 esbuild `define` 替换成 `process.env.APP_VERSION` → `@/cli.tsx` → 状态行与 `@/components/layout/footer.tsx`）。⚠️ **它与根仓那份清单之间没有任何自动同步**，而本包 `private: true`、不发布 ⇒ 漂了外部查不到，唯一症状是「TUI 印着一个比服务端旧的版本号」。
- 牙齿：`tests/meta/version-parity.test.ts`（判据形状是「两个真相源**相等**」，不是「等于某个写死的串」——钉字面量每次抬版本都要记得回来改，漏改就是假绿）。与根仓 `tests/unit/meta/version-sync.test.ts` 同族而不同事：那一档断「生成物印的 == 生成器输入」，本档断「两个真相源本身相等」。
- ⚠️ **不许为它加「同步版本」的构建步骤或脚本**：那把一条断言换成一份自动化，而断言才是那个真相源。本仓零兼容，也不加别名。

## 模型：它能做什么、不能做什么

- **模型输出的是一条 `Command`，不是一个请求。** 链：`submit` → `ask()`（`@/lib/agent.ts`）→ `askModel()`（`@/services/model.ts`）→ 模型回一行文本 → `commandOfReply()`（逐字过 `parseLine`）→ 现有 `exec()`。⚠️ **「模型能打哪些地址」恒等于「`COMMAND_SPECS` 里有那些命令」—— 这不是一个纪律，是一个类型。**
- ⚠️ **模型绝不许拿到 `ManagerClient`**，三条各自独立成立的理由：**端点契约**（`(method, path)` 只有一个来源，给它 client 就是给它一条绕过那张表的路，「对面变了」从一句看得见的话退化成静默 404）；**凭据**（`token` 装进 `Authorization` 头，而每轮对话都带着它出网——进 provider 日志、进重试、进任何一层错误文本）；**SSRF**（不受约束的 URL + 跟着走的凭据）。牙齿：`tests/agent/model-view.test.ts` 不变量 ①（源码级：那两个文件的代码里没有 `ManagerClient` / `ENDPOINTS`，请求体里没有 token 与地址）。
- **模型看得见的面只有两档**（`messagesOf` 只取 `user` / `assistant`）：`tool-result` 是本包与控制面之间的私事；`error` 刻意不给（喂回失败原文等于让它模仿一句假事实）。⚠️ **已知取舍**：控制面数据会进 provider 的机器；本包能做的是**不让凭据跟着走**（`apiKey` 只往 provider 去，`token` 一步都不出 `@/services/manager-client.ts`）。
- **工具说明从 `COMMAND_SPECS` 现算**（`toolDigest()`），不许另抄一份。牙齿：`tests/agent/model-view.test.ts` 不变量 ②。
- **provider 没配好时那句话仍留在屏上**，后面跟一句「还没配 provider · 怎么配」（`ask()` 的 `no-provider` 档）。不许崩、不许静默，而那一档**一个请求都不发**。
- ⚠️ **模型那一句必须对得上屏面事实**：`/batch` 是唯一一个零行却异步产出 N 份行的命令，而那一格**先于**副作用落桶 ⇒ 那句话按 `effects` 分流、指向下面，**不许转述对面返回的数据**。牙齿：`tests/input/chat-batch.test.ts`（走真 `ask()` + 假 fetch，断屏上顺序）。

## 退出：只经命令

- ⚠️ **`/exit` 与 `/quit` 是唯一的退出命令**，`render(…, { exitOnCtrlC: false })` 是这个决定的一半：`Ctrl+C` **刻意什么都不做**（两层都没有分支，也没有「吞掉」它）——它是**误伤键**。两个名字**一个 `Command` 变体**（`kind: "exit"`）⇒ 加一个别名恒等于改 1 处。
- ⚠️ **那扇门必须在 `/help` 上找得到**（只有隐藏后门能出去是陷阱），且 `summary` 自己要**说清它是唯一退出方式**。
- **忙的时候不退出**（队列非空 / 有命令在飞 / 模型在跑）：那些东西落地时都要往台账上写，而退出**先** `closeLedgerDb()` ⇒ 变成一个组件已 `unmount` 之后才抛、没人接的异常。屏上那句话（`还有命令在跑，跑完再退`）是**必需**的——静默不响应与「没生效」在屏上完全一样。⚠️ **拒绝不会把人卡死**：队列串行且有限，每一次在飞的操作都有上界（`DEFAULT_TIMEOUT_MS` / `TIMEOUT_BOUNDS` / `MODEL_TIMEOUT_MS`）⇒ 最坏是等到那个超时。
- **退出码 0**；收尾只有**一条路径**（`@/cli.tsx` 那个幂等 `finish`），不许出现第二条（症状是「退了一次、终端还停在全屏里」）。牙齿：`tests/input/exit.test.ts` 与 `exit-route.test.ts`（后者走注入点断「退出码真的是 0」与 `finish` 幂等——真 TTY 之外读不到 `process.exitCode`）。

## `/batch`：一条命令 → N 个控制面

- **N 从哪儿来**：**显式列出**（`/batch prod,stage /users`，按台账顺序展开）或 `all`。⚠️ **刻意不做「记住上次选择」**：那会让同一条命令在不同时刻打到不同机器上，而这是一个驱动别人机器的终端。**串行**，不并发（取舍在 `src/lib/exec/AGENTS.md`）。**N = 0 时说一句「台账里没有这些控制面」**，不静默空跑。

## 呈现层：零外部组件库

⚠️ **呈现层的词汇全部在 `src/components/` 与 `src/features/`**，依赖面只有 `ink` / `react` / `string-width`。判据是**依赖面**（读 `package.json` 那个文件本身），不是「某个 import」——装了而没引与引了而没装是两种事，而只有前者能在引入之前就红。牙齿：`tests/input/mouse-protocol.test.ts`「呈现层」那一档。

逐个组件的否决理由（**每条一行**，各自独立成立，合起来才是「一个都不换」）：

- `Spinner` — `setInterval(80ms)` **无条件**、没有 `isActive`；本包布局恒等于 `rows` 高 ⇒ 每次定时器回调都是一整帧 fullscreen（实测「50 条移动报告写 0 字节」那一档变成 1224 字节 ⇒ 一动鼠标就卡）。
- `TextInput` — 光标颜色**硬写 chalk**，绕过 `@/theme`（无色终端与色档会在那儿分叉），而本包的「当前行 + 插入符」是**自己一份算式**（`@/lib/input-line.ts` 的 `insertAt` / `deleteAt` / `caretLeft` / `caretRight`，下标恒为 UTF-16 code unit，与几何层那份必须逐字一致）⇒ 换成它就是**两份**插入符算术。
- `Select` — 要能当菜单用就得**自带几何**，而本包的菜单坐标只有 `Geometry.menu` / `menuRows` 一份真相。
- `Badge` / `StatusMessage` — 另一套主题（它的 `ThemeProvider` 与 `@/theme` 三张表不是同一张）。
- `Modal` / `Dialog` / `Overlay` / `Table` / `KeyValue` / `Tabs` / `Toast` — 那个库**根本没有**。

⚠️ **不引入换来了什么**（两条可判定的后果，缺一「不引入」就只是偏好）：① 全包 `src/` **一处 `setInterval` 都没有**（唯一的定时器是消息那一记 8 秒的 `setTimeout`）；② **全包只有一处 `useInput`**（`hooks/useHotkeys.ts`）⇒ 换个自带输入的组件就会长出第二个收键者（抢键，屏上零报错）。

## 测试布局

- **一个主题一个文件夹**（`tests/exec/`），**文件夹内按子主题分档**（`tests/exec/tables.test.ts`）—— 不许把两个主题塞进同一个 `tests/foo/`。**档间共用的一起东西**（临时目录回收、构造器、`__dirname` 推出的路径）归 `tests/foo/_*.ts`（不带 `.test.ts` 的不会被 vitest 收集，故不会变成空跑的空档）。走出 `tests/` 的相对路径从**档自己那一层**算起（`tests/foo/` 里的 `src` 是 `../../src`）。
- **主题级不变量（多档共用的牙齿与判据纪律）归 `tests/foo/AGENTS.md`，单档文件头只留「这一档管哪一段 + 指向 `AGENTS.md`」**（否则拆一次档就把同一段抄成 N 份，腐烂的那份永远没人读）。**建不建那份的门槛是「≥5 个测试档，或存在两档以上共用的 harness」**——判据是「值不值得多一跳」，不是「目录里有没有」。

## 文档写不变量，不写变更日志

- **AGENTS.md 记「今天这套代码为什么长这样」，不记「我这几轮改了什么」。** 删任何一行前问：**① 删掉它，今天的判断会变吗？② 它在讲代码，还是在讲过去某次对话？** 「实测踩过一次」「上一版写的是 X」「作废」这类变异记录与前后对照**一律不进文档**——它们是工单，读的人不接下一棒，而留着只会把一份 60 行的文档撑成 150 行并腐烂（`tests/palette/AGENTS.md` 曾有 58 行变异条目配 3 个测试档，且编号已经缺号）。
- **唯一该留的残留物是「负载在哪」**：一句话说清「改坏 X ⇒ 哪条断言会红」。⚠️ **一条 bullet 一个不变量，推导不写**——能从代码与测试名重新推出来的东西写在这里只会腐烂。⚠️ **`⚠️` 只标真禁忌**，背景与「为什么」不带（今天全包 814 个 ⚠️ / 2947 行 = 每 3.6 行一个，这个密度下标记等于没有）。

## 不可破的事实

- **产物必须是 ESM**：`ink` 有一句顶层 `await import`，esbuild 的 `cjs` 输出表达不了——卡的是**输出格式**，不是「Ink 不能 bundle」。入口判据是 `import.meta.url` 与 `process.argv[1]` 的 `file:` URL **逐字相等**（没有 `require.main` 可用；不相等就落空成「什么也不做、退出码 0」）。
- **端点契约是手抄的弱耦合**（对面可能跑着旧版本服务端）：路径集合归根仓 `tests/unit/manager-tui-contract.test.ts` 两侧目录现列、从源码文本现取再比，字段形状归 `src/api/wire.ts`。⚠️ **加端点必须同时改 `src/api/endpoints/` 下与服务端同名的那个模块文件**（护栏只比集合，不看你怎么分文件）。
  ⚠️⚠️ **`src/api/` 的路径是本包唯一不许动的一块**：那道护栏与 `@/api/wire.js` 的 `WireContractAssertions` 都从源码文本现取/现编译，两侧路径一旦漂了，护栏要么找不到文件要么恒空。`api/wire.ts` 只能引 `@/lib/` 的**叶子**（今天只有 `decode`），不许引 `@/lib/index.js`（成环）。文件位置与文件名一律不动。
- **本机状态在一个 SQLite 库里**：路径**固定**为 `~/.config/swain-proxy/tui.db`（**任何环境变量覆盖都不接**，零兼容），schema 见 `src/services/config/AGENTS.md`。`meta` 表里除 `selected` 外还放着**模型 provider 的三样**（地址 / 模型名 / 凭据，带 `provider.` 前缀）——**凭据与 `targets.token` 同级**，防线同一条（`0600` 库 + `0700` 目录 + `redactProvider` 是**唯一**的打码出口）。
- `packages: "external"` 是选择不是要求（免得产物拖上只在 DEV 下干活的 peer `react-devtools-core`）；改回 bundle 是正当演进，但要当选择来改。
- ⚠️ **动了本包 `src/` 必须 `pnpm build:tui`**（或 `build:all`）：根 `pnpm build` 不碰 `dist/cli.js` ⇒ 四条全绿是**假信号**；**别为此加单测**，test 在 build **之前**。

## 人工验收（单测测不到的一半）

`pnpm dev:tui` 后在真终端里手验这几项，其余交给单测：

- **鼠标上报**。
- **先按一次 `Ctrl+C`，看它确实什么都不发生**（屏上零变化、进程还在）；再敲 `/exit` 退出、看终端是否干净（屏幕恢复 / 光标可见 / 鼠标能拖选粘贴）。⚠️ **`Ctrl+C` 压根不是退出路径**，真要退只能敲命令，故这一项必须手敲。
- **`/exit` 与 `/quit` 敲完确实回到 shell**（而 `/help` 上找得到那扇门）。
- **改窗口大小（拉宽拉窄）**：Ink 会重排它手里那**上一帧**，而应用必须按新的高宽重排一帧新的。`tests/input/screen-geometry.test.ts` 只验得「resize 之后屏上那一帧按新尺寸重排了」，真终端还要看有没有闪一帧旧布局、有没有卡住。
- **弹窗遮罩压暗整屏**：盯**侧边栏那一列**（自带底色，最易被挖空）与**输入框上下框那两行**（不继承祖先底色），两块都要明显变暗，屏最底下不许横着两条亮线。`/managers` 与 `/sessions` 各看一遍（同一张遮罩、两种卡片宽度）。
- **改名框的插入符**：① 光标块落在**正确的列上**（框里那一格 `✎ <名字>`，不是错位到框外）；② **输入区那一行的光标块真的不见了**（`Composer` 恒是真输入行，留在屏上的光标块等于说「焦点还在输入框」）。
- **侧边栏竖着滚动的手感**：清单长过屏时滚轮往下翻，**加粗那一项不跟着滚走**（选中与滚动位置解耦；判据在 `tests/input/sidebar-menu.test.ts`，而手感只有手动能判）。
- **「从侧边栏移出」不会被误读成「删除」**：① 菜单文案读起来是「移出」；② 按下去后那个会话还在 `/sessions` 弹窗里。
- **侧边栏拖到最窄**（`SIDEBAR_MIN_WIDTH`），盯住**那一行绿点**与悬停时的 `✕`：三枚字形（`✕` / `⠋` / `●`）的 East Asian Width 是 **Ambiguous**，按一列算的 `string-width` 与按两列画的终端答案不同（缓解见 `src/lib/geometry.ts` 的 `SESSION_CLOSE_COLUMNS` 预 2 列 / `SESSION_MARK_COLUMNS` 预 3 列且奇数）。
- **按天数分组的跨月边界**：`dayGroupLabel`（`@/lib/format.ts`）按**本地日历日**，故「上个月」不等于「30 天前」，只差一个钟点却跨午夜归「昨天」。看的是**墙钟**下 `/sessions` 的标题行该是「今天 / 昨天 / N 天前」而不是一个具体日期。

端到端起控制面**从临时 cwd**，别在仓库根起（根的 `.env.development` 含开发者的真实账号表、socks4 与仓库内日志目录）：
`cd <临时目录> && MANAGER_ENABLED=true MANAGER_PORT=18080 MANAGER_TOKEN=… AUTH_ENABLED=false PROXY_PROTOCOL=http node <repo>/dist/app.js`

⚠️ **右键那两条（弹出菜单 / 空白处新开会话）在很多终端里压根到不了**——Windows Terminal 与一批终端在右键时弹自己的菜单且**不把按下转发给应用**。故它们是「取决于终端」的功能，菜单里**每个动作另有纯键盘的第二路**（移出 = `Ctrl+X`、新开会话 = `/new`、改名 = `Ctrl+R` 或 `/rename`）。⚠️ **那个动作不是删除**（只动 `sidebar_sessions`），**永久删除**在弹窗里走 `Ctrl+D`，弹窗里点那一行是**激活它**。⚠️ 手验时**别把右键验不了记成「功能坏了」**——先确认你那个终端发不发 `ESC[<2;…M`。

## 相关

根仓 `AGENTS.md`（全局注释纪律与 import 规约）· `src/AGENTS.md`（层不变量）· 各子目录 `AGENTS.md` · `build.mjs`（版本号那一行）