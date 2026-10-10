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
pnpm lint          # eslint ./src --ext .ts,.tsx（快速阶段：tests/ 已删）
pnpm typecheck     # tsc --noEmit（bundler 解析，@/* → src/*）
pnpm test          # vitest run --passWithNoTests（快速阶段：空跑恒绿，不新建 tests/）
```

- 顺序 `lint → typecheck → test → build`（快速阶段 `test` 为空跑，验证靠 `lint/typecheck/build` + 真终端手验）。根仓同名三条会串行带上本包。
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

## 快速验证阶段（`tests/` 已删，不新建）

- `tests/` 整个删除（git 可恢复），本阶段**不新建**任何测试；`pnpm test` 为 `--passWithNoTests` 空跑。
- 验证只有三条：`pnpm lint` → `pnpm typecheck` → `pnpm build`，另加真终端手验（末节）。下文所有指到
  `tests/` 的「牙齿」在本阶段统一暂停，恢复测试时再逐条接回。
- 本阶段正在做的事：呈现层引入 `@inkjs/ui`（`Welcome` 已换 `StatusMessage` + flex，不读几何层）。
  自定义几何已删（`src/lib/geometry.ts`、`useMouse`、`services/terminal/mouse.ts` 均已删除）；输入只走键盘。

## 不可破的事实

- **产物必须是 ESM**：`ink/build/reconciler.js` 有一句顶层 `await`，esbuild 的 `cjs` 输出格式表达不了 ——
  卡的是**输出格式**，不是「Ink 不能 bundle」（`tsc` 那侧零障碍）。这也是本包与根包
  （`type: commonjs` 装不下）分开的**技术**理由。入口判据是 `import.meta.url` 与 `process.argv[1]`
  的 `file:` URL 逐字相等（ESM 没有 `require.main`；不相等就落空成「什么也不做、退出码 0」）。
- **端点契约是手抄的弱耦合**（对面可能跑着旧版本服务端）：`(method, path)` 集合归根仓
  `tests/unit/manager-tui-contract.test.ts` 从**两侧源码递归现列**再比，逐字段形状在 `src/api/` 各模块的
  zod schema（`schema.ts`）。⚠️ **加端点必须同时改 `src/api/` 下与服务端同名的那个模块目录**
  （`client.ts` 里加一个端点函数；护栏只比集合，不看你怎么分文件）。⚠️ **`src/api/` 下的模块划分是本包
  唯一不许动的一块**：那道护栏（递归枚举）与 `tests/wire/`（经 barrel 现编译 schema）都认这套位置，
  两侧路径一漂，护栏要么找不到文件要么恒空。
  `@/api/` 只许引 `@/lib/` 的**叶子**（`request/errors` / `request/http` / `request/transport`），禁引 `@/lib/index.js`（成环）。
- **本机状态在一个 SQLite 库里**：路径**固定**为 `~/.config/swain-proxy/tui.db`（**任何环境变量覆盖
  都不接**，签名上就没有 env 形参；零兼容不读旧 JSON 形态），schema 与失败语义见
  `src/services/config/AGENTS.md`。`0700` 目录 + `0600` 库（先占位空文件再开库，否则 umask 给 0644）+
  打码出口只有 `redactTarget` / `redactProviderView` —— ⚠️ token 与 `apiKey` 绝不进日志、错误文案、
  快照。⚠️ **读面「坏内容即拒」，绝不降级成空台账**（库不存在才 = 空台账且不建库；打不开/列不对/
  校验不过抛 `LedgerError unreadable`）——降级是最坏的一种体贴：重新加一遍就会拿那份空台账覆盖掉
  存着凭据的那一份。`LedgerError` 与传输层 `TuiError` 三档**不混用**。
- **两个拨号点，不许合并**：`@/api`（控制面，`transport/send.ts` 里唯一那条 `axios.request`，地址与 token 是
  `ManagerTarget` 三格普通数据做**函数参数**（形状住 `@/lib/request/transport.js`），没有「客户端对象」这一层；台账→三格的唯一转换是
  `config/connect.ts:targetOf`）与 `@/services/model/`（provider，走 `globalThis.fetch`，openai /
  anthropic / gemini 三家的系统提示位置、凭据头、推理预算、清单 id 形状各不相同）。
- `packages: "external"` 是**选择**不是要求（免得产物拖上只在 DEV 下干活的 peer
  `react-devtools-core`）；改回 bundle 是正当演进，但要当选择来改。
- ⚠️ **`exitOnCtrlC: false` 一个字不许改成 `true`**（Ink 的「退出」与 `use-input` 的「跳过监听器」
  两道门都挂在它上面，改 true 等于给「忙就拒绝」那道守卫开一条后门）；退出只经 `/exit` 与 `/quit`
  （同一个 `Command` 变体 ⇒ 加别名恒等于改 1 处），**退出码 0**，收尾只有 `cli.tsx` 那个幂等
  `finish` 一条路径（顺序 `unmount → 撤告警过滤器 → closeLedgerDb`，每步各兜各的、
  最后才设 exit code）。⚠️ **忙的时候不退出**（队列非空 / 有命令在飞 / 模型在跑）且屏上**那句话
  是必需的**（「还有命令在跑，跑完再退」）：静默不响应与「没生效」在屏上完全一样。⚠️ 那扇门**必须在
  `/help` 上找得到**，且 `summary` 自己要说清它是唯一退出方式。
- ⚠️ **`kittyKeyboard: { mode: "auto" }` 不许删、不许换 `enabled`**：`Ctrl+Enter` / `Ctrl+↑↓` /
  `Shift+←→` 唯一的活路是 kitty 报文 —— 不带它，非 kitty 终端上 **`Ctrl+M` 与 `Enter` 是同一个字节**
  （Ink 两边都解成 `{return}`）⇒ 那三族在真终端上**全是死的**，而症状是「假 TTY 那档也绿、真终端按不动」。
  代价是一次 `CSI ? u` 探测 + **一次性** 200ms 超时；不选 `enabled` 是因为「省下的 200ms 不值得拿
  『假定这个终端发那种报文』去换」。
- **无鼠标**：不开启 `1000/1003/1006` 上报、不解析 SGR、不做命中测试。侧边栏切换/移出、滚动、改名
  一律走键盘（移出 = `Ctrl+X`、新开会话 = `/new`、改名 = `Ctrl+R`、切会话 = `Ctrl+↑↓`）。

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
  牙齿：`tests/agent/model-view.test.ts` 不变量 ①（含「反向自检」：`transport/send.ts` 确实认 `ManagerTarget`
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

## 呈现层：允许 `@inkjs/ui`，纯 flex

- 呈现层可用 `@inkjs/ui`（`dependencies` 有 `^2.0.0`）：`Welcome` 已用 `StatusMessage`（info/warning）+
  flex 居中。⚠️ 库组件颜色不跟 `props.color`（无色档下仍上色），这是快速阶段接受的取舍。
  自定义几何已删（`src/lib/geometry.ts` 不存在）；布局只用 Ink flex + `overflow="hidden"` 裁剪。
- 当前仍成立的两条：① 全包 `src/` **一处 `setInterval` 都没有**（唯一的定时器是消息那一记 8 秒的
  `setTimeout`）；② `src/` 只有 `hooks/useHotkeys.ts` 一处 `useInput`（用上库的 `TextInput`/`Select`
  时第二条即失效，届时删本条）。

## 台账、启动与退出顺序之外的宿主纪律

- `cli.tsx` 是组合根：**第一句装 sqlite 告警过滤器**（`node:sqlite` 的 `ExperimentalWarning` 打在 stderr
  上会糊掉全屏首帧，而驱动是第一次真正需要时才加载的）→ 采宿主 → 拒 argv / 非 TTY →
  `render(<App/>)` → 幂等 `finish()`。`AppState.tsx` 是唯一的状态层（全部跨帧状态与呈现模型装配），
  `app.tsx` 只组装 `Layout`；两处都不认识控制面数据的形状。
- `lib/` 零 IO；`exec/` + `agent.ts` **有意不在** `@/lib/index.js` 转发（前者依赖 `@/api`，后者引
  `exec/` + `@/services/model`，转进来就是运行期环 ⇒ 调用方走深路径）。`store/` 只有形状与常量；
  `theme/` 是语义→颜色唯一映射（`themeOf` 取表，底色只加真有用到的档）。

## 测试：快速阶段暂停（`tests/` 不存在，不新建）

- 本节原判据（主题文件夹、真 `http.Server` 端到端、真库零网络、假 TTY 真 Ink、`no-console`）随目录一起暂停，恢复时接回。快速阶段见顶上「快速验证阶段」。

## 人工验收（单测测不到的那一半）

`pnpm dev:tui` 后在真终端里手验（快速阶段**全部**靠手验，无单测）：

- **先按一次 `Ctrl+C`，看它确实什么都不发生**（屏上零变化、进程还在）；再敲 `/exit`，看终端是否干净
  （屏幕恢复 / 光标可见）。⚠️ **`Ctrl+C` 压根不是退出路径**，故这一项必须手敲。
- **`/exit` 与 `/quit` 敲完确实回到 shell**（而 `/help` 上找得到那扇门）。
- **改窗口大小（拉宽拉窄）**：Ink 会重排它手里那**上一帧**，应用必须按新的高宽重排一帧新的。
  单测只验得「resize 后屏上那一帧按新尺寸重排了」，真终端还要看有没有**闪一帧旧布局**。
- **弹窗遮罩压暗整屏**：盯**侧边栏那一列**（自带底色，最易被挖空）与**输入框上下框那两行**（不继承祖先
  底色），屏最底下不许横着两条亮线。`/managers` 与 `/sessions` 各看一遍。
- **改名框的插入符**：① 光标块落在**正确的列**上；② **输入区那一行的光标块真的不见了**（留在屏上的
  光标块等于说「焦点还在输入框」）。
- **侧边栏滚动**：清单长过屏时用 `Ctrl+↑↓` 切会话，当前会话保持可见（`revealSession`），选中与滚动位置解耦。
- **按天数分组的跨月边界**：`dayGroupLabel`（`@/lib/format.ts`）按**本地日历日**，故「上个月」不等于
  「30 天前」——只差一个钟点却跨午夜归「昨天」。
- **「从侧边栏移出」不会被误读成「删除」**：`Ctrl+X` 只是从侧边栏拿掉，那个会话还在 `/sessions`
  弹窗里；**永久删除**在弹窗里走 `Ctrl+D`。

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