# AGENTS.md — `@b-hole/proxy-tui`（控制面终端控制台）

独立 pnpm 包（`private: true`、`type: module`、`bin: proxy-tui → dist/cli.js`）：回答「怎么在终端里驱动
**别的机器上**那个控制面」。机制细节归各目录 `AGENTS.md` 与源码文件头；`src/` 内的分层地图见
`src/AGENTS.md` 那张表。本文件只记**包这一层**的不变量。

⚠️ **写法**：一条 bullet = 一个不变量 + 牙齿（哪条断言钉住它）。推导不写——能从代码与测试名重新推出来的
写在这里只会腐烂。⚠️ **`⚠️` 只标真禁忌**，背景与「为什么」不带。

## Commands（在本目录跑；根仓经 `--filter @b-hole/proxy-tui` 点名）

```
pnpm build         # node build.mjs：src/cli.tsx → dist/cli.js（每次先清空 dist/）
pnpm dev           # build --dev && node dist/cli.js（dev = 不压缩 + sourcemap）
pnpm start         # node dist/cli.js（要真 TTY，下见）
pnpm lint          # eslint ./src ./tests --ext .ts,.tsx
pnpm typecheck     # tsc --noEmit（bundler 解析，@/* → src/*）
pnpm test          # vitest run（include tests/**/*.test.ts，forks，不 shuffle）
pnpm exec vitest run <fragment>  # 单测按片段过滤，如 mouse-protocol / version-parity
```

- 顺序 `lint → typecheck → test → build`。根仓同名三条会串行带上本包；⚠️ **单测不要写
  `pnpm test <filter>`**（根仓脚本链把参数只喂给链条最后一条，根包全量跑、子包因无匹配而红）。
- ⚠️ **动了 `src/` 必须重建本包**：根 `pnpm build` 只建根包，碰不到 `dist/cli.js` ⇒ 只改子包时
  「四条全绿」是假信号。自查：`dist/cli.js` 的时间戳比 `src/` 里最新的文件新。**别为此加单测**
  （test 跑在 build 之前）。
- `build.mjs` 纪律：`format: "esm"` 硬要求（下节）；`banner` 的 shebang 不许掉（掉了就是
  `Bad interpreter`）；⚠️ `process.env.APP_VERSION` 必须**逐字**写（`{...process.env}["APP_VERSION"]`
  会绕过 esbuild `define`，产物里是 undefined）；`ESBUILD_WORKER_THREADS=0` + watch 常驻进程只
  `fs.watch src/` 再起一次性子进程构建（Windows + Node22 加载 esbuild 原生模块偶发无输出崩溃，
  退出码 `3221226505` 即使产物已写出也按成功处理）。
- 手工跑要**真终端**：不接受任何 argv（带参即 exit 1，加端点只能界面里敲 `target add`）；
  `stdin.isTTY !== true` 直接拒，不进 Ink。

## 不可破的事实

- **产物必须是 ESM**：`ink/build/reconciler.js` 有一句顶层 `await`，esbuild 的 `cjs` 输出格式表达不了 ——
  卡的是**输出格式**，不是「Ink 不能 bundle」（`tsc` 那侧零障碍）。这也是本包与根包
  （`type: commonjs` 装不下）分开的**技术**理由。入口判据是 `import.meta.url` 与 `process.argv[1]`
  的 `file:` URL 逐字相等（ESM 没有 `require.main`；不相等就落空成「什么也不做、退出码 0」）。
- **端点契约是手抄的弱耦合**（对面可能跑着旧版本服务端）：`(method, path)` 集合归根仓
  `tests/unit/manager-tui-contract.test.ts` 从**两侧源码现列**再比，逐字段形状在 `src/api/` 的
  zod schema。⚠️ **加端点必须同时改 `src/api/` 下与服务端同名的那个模块文件**（护栏只比集合，
  不看你怎么分文件）。⚠️ **`src/api/` 的文件位置与文件名是本包唯一不许动的一块**：那道护栏与
  `tests/wire/` 都从源码文本现取/现编译，两侧路径一漂，护栏要么找不到文件要么恒空。
  `@/api/` 只许引 `@/lib/` 的**叶子**（`errors` / `http`），禁引 `@/lib/index.js`（成环）。
- **本机状态在一个 SQLite 库里**：路径**固定**为 `~/.config/swain-proxy/tui.db`（**任何环境变量覆盖
  都不接**，签名上就没有 env 形参；零兼容不读旧 JSON 形态），schema 与失败语义见
  `src/services/config/AGENTS.md`。`0700` 目录 + `0600` 库（先占位空文件再开库，否则 umask 给 0644）+
  打码出口只有 `redactTarget` / `redactProviderView` —— ⚠️ token 与 `apiKey` 绝不进日志、错误文案、
  快照。⚠️ **读面「坏内容即拒」，绝不降级成空台账**（库不存在才 = 空台账且不建库；打不开/列不对/
  校验不过抛 `LedgerError unreadable`）——降级是最坏的一种体贴：重新加一遍就会拿那份空台账覆盖掉
  存着凭据的那一份。`LedgerError` 与传输层 `TuiError` 三档**不混用**。
- **两个拨号点，不许合并**：`@/api`（控制面，`send.ts` 里唯一那条 `axios.request`，地址与 token 是
  `ManagerTarget` 三格普通数据做**函数参数**，没有「客户端对象」这一层；台账→三格的唯一转换是
  `config/connect.ts:targetOf`）与 `@/services/model/`（provider，走 `globalThis.fetch`，openai /
  anthropic / gemini 三家的系统提示位置、凭据头、推理预算、清单 id 形状各不相同）。
- `packages: "external"` 是**选择**不是要求（免得产物拖上只在 DEV 下干活的 peer
  `react-devtools-core`）；改回 bundle 是正当演进，但要当选择来改。
- ⚠️ **`exitOnCtrlC: false` 一个字不许改成 `true`**（Ink 的「退出」与 `use-input` 的「跳过监听器」
  两道门都挂在它上面，改 true 等于给「忙就拒绝」那道守卫开一条后门）；退出只经 `/exit` 与 `/quit`
  （同一个 `Command` 变体 ⇒ 加别名恒等于改 1 处），**退出码 0**，收尾只有 `cli.tsx` 那个幂等
  `finish` 一条路径（顺序 `unmount → mouse.stop → 撤告警过滤器 → closeLedgerDb`，每步各兜各的、
  最后才设 exit code）。⚠️ **忙的时候不退出**（队列非空 / 有命令在飞 / 模型在跑）且屏上**那句话
  是必需的**（「还有命令在跑，跑完再退」）：静默不响应与「没生效」在屏上完全一样。⚠️ 那扇门**必须在
  `/help` 上找得到**，且 `summary` 自己要说清它是唯一退出方式。
- ⚠️ **`kittyKeyboard: { mode: "auto" }` 不许删、不许换 `enabled`**：`Ctrl+Enter` / `Ctrl+↑↓` /
  `Shift+←→` 唯一的活路是 kitty 报文 —— 不带它，非 kitty 终端上 **`Ctrl+M` 与 `Enter` 是同一个字节**
  （Ink 两边都解成 `{return}`）⇒ 那三族在真终端上**全是死的**，而症状是「假 TTY 那档也绿、真终端按不动」。
  代价是一次 `CSI ? u` 探测 + **一次性** 200ms 超时；不选 `enabled` 是因为「省下的 200ms 不值得拿
  『假定这个终端发那种报文』去换」。
- ⚠️ **鼠标 SGR 本包自己挂 `data` 解析**（Ink 的 `parseKeypress` 不认 `ESC[<b;x;yM`，而 `useInput`
  砍掉 ESC 后会把报文当可打印文本喂进输入行 ⇒ 移动一次鼠标长出几十行）。⚠️ **右键/中键可用性归终端管**
  （Windows Terminal 等右键弹自己的菜单、根本不转发），故每个鼠标动作都有**纯键盘第二路**
  （移出 = `Ctrl+X`、新开会话 = `/new`、改名 = `Ctrl+R`）。

## 版本号：两个真相源，恒相等

- 屏上那个版本号来自**本子包自己那份清单**（`build.mjs:readVersion()` 经 `define` →
  `cli.tsx` → 状态行与 `layout/footer.tsx`）。⚠️ **它与根仓那份清单之间没有任何自动同步**，而本包
  `private: true` 不发布 ⇒ 漂了外部查不到，唯一症状是「TUI 印着一个比服务端旧的版本号」。
- 牙齿：`tests/meta/version-parity.test.ts`（判据形状是「两个真相源**相等**」而不是「等于某个写死的
  串」——钉字面量每次抬版本都要记得回来改，漏改就是假绿）。⚠️ **不许为它加「同步版本」的构建步骤**：
  那把一条断言换成一份自动化，而断言才是那个真相源。

## 模型：它能做什么、不能做什么

- **模型输出的是一条 `Command`，不是一个请求。** 链：`submit` → `ask()`（`@/lib/agent.ts`）→
  `askModel()`（`@/services/model/`）→ 模型回一行文本 → `commandOfReply()`（逐字过 `parseLine`）→
  现有 `exec()`。⚠️ **「模型能打哪些地址」恒等于「`COMMAND_SPECS` 里有那些命令」—— 这不是一个纪律，
  是一个类型。**
- ⚠️ **模型那一侧绝不许认识控制面那一档**（判据是 `src/services/model/` 的源码里不出现 `ManagerTarget`），
  三条各自独立成立：**端点契约**（`(method, path)` 只有一个来源，绕过那张表就等于把「对面变了」从一句
  看得见的话退化成静默 404）；**凭据**（`token` 装进 `Authorization` 头，而每轮对话都带着它出网 ——
  进 provider 日志、进重试、进任何一层错误文本）；**SSRF**（不受约束的 URL + 跟着走的凭据）。
  牙齿：`tests/agent/model-view.test.ts` 不变量 ①（含「反向自检」：`send.ts` 确实认 `ManagerTarget`
  且确实在拨号）。
- **模型看得见的面只有两档**（`messagesOf` 只取 `user` / `assistant`）：`tool-result` 是本包与控制面
  之间的私事；`error` 刻意不给（喂回失败原文等于让它模仿一句假事实）。⚠️ **已知取舍**：控制面数据会进
  provider 的机器，本包能做的是**不让凭据跟着走**。工具说明**从 `COMMAND_SPECS` 现算**（`toolDigest()`），
  不许另抄一份（牙齿：不变量 ②）。
- **provider 没配好时那句话仍留在屏上**（`ask()` 的 `no-provider` 档），不许崩、不许静默，且那一档
  **一个请求都不发**。⚠️ **模型那一句必须对得上屏面事实**：`/batch` 是唯一一个零行却异步产出 N 份行的
  命令，那一格先于副作用落桶 ⇒ 按 `effects` 分流，**不许转述对面返回的数据**（牙齿：
  `tests/input/chat-batch.test.ts`）。

## `/batch`：一条命令 → N 个控制面

- **N 从哪儿来**：**显式列出**（`/batch prod,stage /users`，按台账顺序展开）或 `all`。
  ⚠️ **刻意不做「记住上次选择」**——那会让同一条命令在不同时刻打到不同机器上，而这是一个驱动别人机器的
  终端。**串行**不并发（取舍在 `src/lib/exec/AGENTS.md`），一台失败**不停整批**。**N = 0 时说一句**
  「台账里没有这些控制面」，不静默空跑。

## 呈现层：零外部组件库

⚠️ **呈现层的词汇全部在 `src/components/` 与 `src/features/`**，依赖面只有 `ink` / `react` /
`string-width`。判据是**依赖面**（读 `package.json` 那个文件本身），不是「某个 import」——装了而没引与
引了而没装是两种事，而只有前者能在引入之前就红（牙齿：`tests/input/mouse-protocol.test.ts`）。

逐个组件的否决理由（各自独立成立，合起来才是「一个都不换」）：`Spinner`（`setInterval(80ms)`
**无条件**、没有 `isActive`，而本包布局恒等于 `rows` 高 ⇒ 每次回调都是一整帧 fullscreen，实测
「50 条移动报告写 0 字节」那一档会变成 1224 字节）· `TextInput`（光标颜色硬写 chalk 绕过 `@/theme`，
且「当前行 + 插入符」是本包自己一份算式 ⇒ 换成它就是两份）· `Select`（要当菜单用就得自带几何，
而菜单坐标只有 `Geometry.menu` 一份真相）· `Badge` / `StatusMessage`（另一套主题）·
`Modal` / `Dialog` / `Overlay` / `Table` / `Tabs` / `Toast`（那个库根本没有）。

⚠️ **「不引入」换来的两条可判定后果**（缺一它就只是偏好）：① 全包 `src/` **一处 `setInterval` 都没有**
（唯一的定时器是消息那一记 8 秒的 `setTimeout`）；② **全包只有一处 `useInput`**（`hooks/useHotkeys.ts`）
⇒ 换个自带输入的组件就会长出第二个收键者（抢键，屏上零报错）。

## 台账、启动与退出顺序之外的宿主纪律

- `cli.tsx` 是组合根：**第一句装 sqlite 告警过滤器**（`node:sqlite` 的 `ExperimentalWarning` 打在 stderr
  上会糊掉全屏首帧，而驱动是第一次真正需要时才加载的）→ 采宿主 → 拒 argv / 非 TTY → `mouse.start()` →
  `render(<App/>)` → 幂等 `finish()`。`AppState.tsx` 是唯一的状态层（全部跨帧状态与呈现模型装配），
  `app.tsx` 只组装 `Layout`；两处都不认识控制面数据的形状。
- `lib/` 零 IO；`exec/` + `agent.ts` **有意不在** `@/lib/index.js` 转发（前者依赖 `@/api`，后者引
  `exec/` + `@/services/model`，转进来就是运行期环 ⇒ 调用方走深路径）。`store/` 只有形状与常量；
  `theme/` 是语义→颜色唯一映射（`themeOf` 取表，底色只加真有用到的档）。

## 测试布局与几条判据纪律

- **一个主题一个文件夹**（`tests/exec/`），文件夹内**按子主题分档**；档间共用的一起东西归
  `tests/foo/_*.ts`（**不带 `.test.ts` 的不会被 vitest 收集**，故不会变成空跑的空档）。
  **主题级不变量归 `tests/foo/AGENTS.md`，单档文件头只留「这一档管哪一段 + 指向它」**；建那份的门槛是
  「≥5 个测试档，或存在两档以上共用的 harness」。
- `tests/client/` 是对**真 `http.Server`** 的端到端（`_double.ts` 最小控制面：鉴权先于路由、
  未登记路径 404、默认 `Authorization: Bearer <token>` 逐字比）。⚠️ **刻意不 import `@b-hole/proxy`**
  （TUI 连的是**别的机器上**那个进程，两端版本可以不同；契约互锁由根仓那道护栏从两侧源码现取负责）。
  `startDouble()` 只在用例体内调（零模块期副作用，`listen(0)`），每档自带 `beforeEach`/`afterEach` 起关，
  `close()` 允许调两次 —— ⚠️ **漏 `afterEach` 的症状是「进程不退」，不是「测试失败」**。
- `tests/ledger/` + `sqlite/` + `providers/` 是真库 + 真临时目录、零网络；每档 `afterEach` 自带
  `closeLedgerDb() → removeCreated()`；POSIX 权限档 win32 `skipIf`。
- `tests/layout/` + `input/` 是假 TTY 真 Ink：⚠️ **每一档入口自带 `vi.hoisted` 设 `FORCE_COLOR`**
  （必须在 ink / chalk 被 import 之前，否则 chalk level 定死 0、Ink 一个转义序列都不生成 ⇒ 着色判据全恒真；
  **放进被 import 的共用模块里不会被提升**，实测 13 条一起红而症状看着像「实现没上色」）。⚠️ 断言前先
  **自检探针下标**（`-1` / `null` 上的比较恒成立，「探针认错了东西」与「实现坏了」在屏上一样）；
  坐标一律从 `@/lib/geometry` **现算**，不写死屏幕行号。
- 风格：`no-console: error`（仅 `build.mjs` / `tests/**` 豁免）、双引号、分号。

## 人工验收（单测测不到的那一半）

`pnpm dev:tui` 后在真终端里手验，其余交给单测：

- **鼠标上报**；⚠️ **右键那两条在很多终端里压根到不了**——先确认你那个终端发不发 `ESC[<2;…M`，
  别把「验不了」记成「功能坏了」。
- **先按一次 `Ctrl+C`，看它确实什么都不发生**（屏上零变化、进程还在）；再敲 `/exit`，看终端是否干净
  （屏幕恢复 / 光标可见 / 鼠标能拖选粘贴）。⚠️ **`Ctrl+C` 压根不是退出路径**，故这一项必须手敲。
- **`/exit` 与 `/quit` 敲完确实回到 shell**（而 `/help` 上找得到那扇门）。
- **改窗口大小（拉宽拉窄）**：Ink 会重排它手里那**上一帧**，应用必须按新的高宽重排一帧新的。
  单测只验得「resize 后屏上那一帧按新尺寸重排了」，真终端还要看有没有**闪一帧旧布局**。
- **弹窗遮罩压暗整屏**：盯**侧边栏那一列**（自带底色，最易被挖空）与**输入框上下框那两行**（不继承祖先
  底色），屏最底下不许横着两条亮线。`/managers` 与 `/sessions` 各看一遍。
- **改名框的插入符**：① 光标块落在**正确的列**上；② **输入区那一行的光标块真的不见了**（留在屏上的
  光标块等于说「焦点还在输入框」）。
- **侧边栏竖着滚动的手感**：清单长过屏时滚轮往下翻，**加粗那一项不跟着滚走**（选中与滚动位置解耦）。
- **侧边栏拖到最窄**（`SIDEBAR_MIN_WIDTH`），盯那一行绿点与悬停的 `✕`：三枚字形（`✕` / `⠋` / `●`）的
  East Asian Width 是 **Ambiguous**，按一列算的 `string-width` 与按两列画的终端答案不同（缓解见
  `src/lib/geometry.ts` 的 `SESSION_CLOSE_COLUMNS` / `SESSION_MARK_COLUMNS`）。
- **按天数分组的跨月边界**：`dayGroupLabel`（`@/lib/format.ts`）按**本地日历日**，故「上个月」不等于
  「30 天前」——只差一个钟点却跨午夜归「昨天」。
- **「从侧边栏移出」不会被误读成「删除」**：菜单文案读起来是「移出」，按下去后那个会话还在 `/sessions`
  弹窗里；**永久删除**在弹窗里走 `Ctrl+D`，点弹窗那一行是**激活它**。

端到端起控制面**从临时 cwd**，别在仓库根起（根的 `.env.development` 含开发者的真实账号表、socks4
与仓库内日志目录，详见根 `AGENTS.md`「Service startup」）：
`cd <临时目录> && MANAGER_ENABLED=true MANAGER_PORT=18080 MANAGER_TOKEN=… AUTH_ENABLED=false PROXY_PROTOCOL=http node <repo>/dist/app.js`

## 文档写不变量，不写变更日志

- **AGENTS.md 记「今天这套代码为什么长这样」，不记「我这几轮改了什么」。** 删任何一行前问：**① 删掉它，
  今天的判断会变吗？② 它在讲代码，还是在讲过去某次对话？** 「实测踩过一次」「上一版写的是 X」这类变异
  记录与前后对照**一律不进文档**——它们是工单，读的人不接下一棒。
- **唯一该留的残留物是「负载在哪」**：一句话说清「改坏 X ⇒ 哪条断言会红」。

## 相关

根仓 `AGENTS.md`（收尾顺序、服务归用户、import 规约、写护栏的假绿）· `src/AGENTS.md`（层不变量与那张
地图表）· 各子目录 `AGENTS.md` · `build.mjs`（版本号那一行）