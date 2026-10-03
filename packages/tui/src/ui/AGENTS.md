# src/ui/ — 排版与着色的判据 + 终端设施（零 Ink 组件）

本目录现在只有**纯函数**与**终端协议**，**零 Ink 组件**：

- `theme.ts` / `format.ts` / `columns.ts` — 颜色、排版、列宽的**全部**判据；
- `logo.ts` — 两串常量（艺术字与副标）；
- `mouse.ts` / `screen.ts` — 全屏接管与鼠标协议（**终端设施**，不是呈现）。

⚠️ **呈现全部在 `@/console/layout.tsx`**，而它**只**从本目录取「怎么排、怎么上色」的判据。
判据是「画在哪 = 点在哪」：**布局必须与 `@/console/geometry.ts` 的算术逐字一致**，而一个
「自己算宽度、自己算边框」的组件库正是那种不一致的产地。⚠️ 本目录**不许**再出现 Ink 组件 ——
加一个组件就等于加一份「它自己算的那个宽度」，而两份会漂。

## 文件

- `theme.ts` — **颜色与字形的唯一映射出口**：11 个语义色档（7 个前景 + `surface` / `hover` /
  `scrim` / `panel` 四个**背景**）、`themeOf`、`connectionMark` 与
  **探活持有的值 → 呈现档**的**唯一**换算 `connectionStateOf`。零 React、零 `process.*`。
- `format.ts` — **人读形态的格式化**（纯函数）：`bytes` / `duration` / `uptime` / `isoOrNull` /
  `percent` / `maskToken` / `ellipsis` / `padToWidth` / `dash` / `onOff` / `fitTo`，以及全包唯一的
  宽度度量 `widthOf`（`string-width`）。
- `columns.ts` — **列宽规划**（纯函数）：`planColumns(specs, rows, totalWidth)`。表格排版全在这里，
  `@/console/exec.ts` 每一张表都经它排好版之后再拍平成字符串。
- `logo.ts` — `BANNER` 与 `TAGLINE`。⚠️ **零 React**（判据见文件头：本包只有一处挂 Ink）。
- `mouse.ts` — 鼠标事件源：SGR 开闭序列、`parseSgr`（纯函数）、探活四档、`createMouseSource`。
  ⚠️ **本目录不导出 `Rect` 也不导出 `hitTest`** —— 矩形与命中测试是**布局**的判据。
- `screen.ts` — 全屏接管的**对称性**：`ENTER_SEQUENCE` / `EXIT_SEQUENCE` 成对序列 + 幂等收尾
  `enterFullScreen` 与 `chainRestores`。⚠️ **备用屏幕（`?1049`）归 Ink，本模块一条都不许碰**。
- `index.ts` — 目录 barrel，**只转发**。
- `AGENTS.md` — 本文件。

## 层不变量

- **零 `console`、零 `process.*`**：终端宽高 / 是否上色 / 版本号全部由组合根 `src/cli.tsx` 采集一次，
  往下当参数传。`process.*` 是**组合根**的采集面，叶子模块自己摸等于把「这份快照从哪来」从一处拆成 N 处。
- **`theme` / `format` / `columns` / `logo` 不 import React**：它们是排版与着色的判据，能被单测逐字
  断言正因如此；挂上 React 就不再是纯函数，而 Ink 组件在测试里渲染要起 stdin/stdout。
  ⚠️ 反过来 `@/console/layout.tsx` 是**本包唯一**挂 Ink 的文件 —— 于是「哪一层能起 React」这件事
  在目录形状上就是看得见的。
- **颜色只有一个出口**：`themeOf`（语义档 → 颜色）。想加一种意思就加一个**语义档**并写清理由，
  不许在某处偷偷换个 hex。
- **「探活持有的值 → 呈现档」只有一个换算口**：`connectionStateOf`（`ProbeSlot | undefined` →
  `ConnectionState`）。侧边栏是它唯一的读者。⚠️ 这不是「省几行字」：本包曾经有过第二份
  （组合根与台账页各一份，逐字相同），分叉出来的不是「多一次请求」而是**同一屏两句话** ——
  表格那一格永远「未知 / 还没探过」而目标条说「未连接」，且两处各自都没 bug。
- **「在飞」与「结果」在同一个容器里**：`ProbeSlot`（= `ProbeResult | { pending: true }`）是那一个
  `Map` 里一个 id 的**唯一**值形状。⚠️ 理由：一个 id 一个值 ⇒ 结构上不可能对它说两个词。
  ⚠️ 因此 `connecting`（连接中）这一档**要**有：它与 `unknown`（还没试过）必须是两个词 ——
  一个 `timeoutMs` 4000 的死目标在飞那 4 秒里说「连接中」，而说「未知」的话操作者分不出
  「还没开始」与「卡住了」，而这两件事的处置完全相反。⚠️ 它**只**认 `{ pending: true }` 这一个输入
  形状，不许新增别的「还没结论」的标记。
- **状态不许只靠颜色**：`connectionMark` **同时**给字形与色档，那两个是**形状**通道，
  在无色终端下唯一可读。
  ⚠️ **侧边栏与命令面板的「选中」不走反底色**，而走「最亮那一档 + **加粗** + 记号」：反底色那一列
  归 hover（它**整条**都有底色），再叠一层会让「选中的那一个」与「指针在的那一个」互相盖过。
  ⚠️ 而**加粗与记号是颜色之外的通道**，故无色终端里也还看得出来 —— 那一档里「哪一个被选中了」
  是唯一的线索，而把它压在颜色上就等于把它压在终端支持上。
- **四个背景档与前景档写在同一个坐标系里**：`surface`（侧边栏整列的底色）、`hover`（指针
  悬停那一项的底色）、`scrim`（模态窗口开着时**整屏**那层遮罩）、`panel`（窗口自己的底色）不是
  「另一张背景色表」—— 写成另一张就等于承认「同一个语义两种颜色」是可接受的。⚠️ 挑值时**相对
  深浅是判据不是审美**：`hover` 必须比 `surface` 深（「悬停看不出来」是一种无法归因的失败，
  因为那一项**什么都没变**），`scrim` 必须比 `surface` 浅（窗口开着时背后**变浅**），而 `panel`
  必须比 `scrim` 深（否则窗口自己也被冲淡，「浮在上面」就变成了「铺在下面」）。
  ⚠️ 而 `selected` 是**全场最亮**的那一档：它不许暗于 `accent`，否则面板的高亮行与窗口里那一行
  的记号都读起来与普通行同档。
- **打码只有一个出口**：`maskToken`（**固定长度**，不透露长度 —— 长度是可二分的信号，与
  `src/manager/http/auth.ts` 那条纪律同源，那条管时序侧、本条管屏幕侧）。
  ⚠️ 本目录**不许**再判「哪些键是秘密」，那是服务端 `CONFIG_SECRET_KEYS` 一份清单的读者。
- **度量一律 `string-width`**：本目录没有一处用 `String.length` 做宽度判断（`账号` 的 `length`
  是 2、显示宽度是 4；按 `length` 排出来的中文表格右边必然错开一格）。
- **非法输入抛，不装**：`bytes` / `duration` / `percent` 对负数与非有限数抛 `RangeError`。一个 `NaN`
  落在用量列里会被读成「这个数我不知道」，而真相是「上游给坏了」。
- **空形态收敛成一个**：至少 `dash(null | undefined) === "—"`。⚠️ **空串保持空串**（「配了个空」与
  「没配」是两件事）。「没值」与「不限流」也各有**唯一**写法：`—` 与 `∞`（`total === 0` 是「不限流」，
  不是除零）。
- **显示层不做换算**：`isoOrNull` 原样透传服务端给的带偏移 ISO 串。换算成本地时间就是给「同一时刻」
  两种说法，而配额的到期判定按绝对时刻做。
- **展示决定不许进数据层，反向也不许**：列宽、字节怎么写、右对齐、空形态怎么写，全在本目录；
  而本目录**不认识**账号 / 名单 / 账本的字段语义，只认 `@/client` 声明过的那些名字。

## 鼠标事件源（`mouse.ts`）

- **Ink 没有鼠标，故必须自己挂 `data` 监听**：`ink/build/input-parser.js` 把未知 CSI 序列交给
  `parseKeypress`，`ESC[<b;x;yM` 在那里既不成键、也没有上交通道。Node 的流把同一份字节**广播**给
  所有监听器（Ink 与本模块都收得到），⚠️ 故 `ParsedSgr.rest` **绝不回灌 stdin** —— 回灌一遍就是双发，
  而双发的按键会被输入行收两次。
- ⚠️ **「广播」的另一半是 Ink 把同一份报文当文本交给 `useInput`**（本包真的在这上面栽过）：
  `ink/build/hooks/use-input.js` 里 `parseKeypress` 解析不出键名，于是 `input = keypress.sequence`，
  紧接着 `if (input.startsWith("\u001B")) input = input.slice(1)` —— 到达输入层时已经是
  `[<35;64;32M`，**一串全是可打印字符**。故本模块导出 `isMouseReport`，由 `src/app.tsx` 的 `useInput`
  认领掉；漏掉的后果是输入行里逐字长出协议报文（`?1003h` 开着时移动一次鼠标就是几十行那种）。
  ⚠️ 「Ink 收得到」**不等于**「Ink 会替我们认协议」——协议这一侧自己认领。
- ⚠️ **`isMouseReport` 必须与 `parseSgr` 同源**（同一个 `scanSgr`），不许另写一份 `startsWith("[<")`：
  那份宽松判据会把用户自己敲的 `[<1;2;3M` 与**故意放过**的四段形态一起吞掉。
  ⚠️ ESC 被砍掉之后「未解析的 CSI 序列」与「用户敲的 `[abc`」在字符串上**再也分不开**，故这道闸
  只能认**结构上就是报告**的那些 —— 宁可放过不可错杀（这是判据的**能力边界**；要更强的保证只能把
  过滤挪到 Ink 之前，而那要换掉 Ink 的整条输入流）。
- **`?1006` 必开**：传统 X10 坐标在 223 列以上会 wrap，而宽终端是常态；wrap 出来的坐标看似合法，
  界面会据此选中**另一行**。开闭两条序列**一一对应且顺序相反**（`MOUSE_REPORTING_ON` / `_OFF`），
  且顺序不能改：退出那一刻终端可能还在发最后几条移动报告。
- **关闭必须无条件执行**：终端一旦被留在「上报开着」的状态，操作者退出后会得到一个**一直吞掉选中与
  粘贴**的终端（拖选变点击、`Ctrl+V` 失效）且**屏幕上没有任何东西说明它**。故 `MouseSource.stop`
  只有一道幂等守卫、**不**加「开成功过才关」的第二道闸 —— 那道闸只会在开启抛了的时候把唯一的补救挡掉。
- **残留缓冲是跨调用的**：`parseSgr(chunk, pending)` 收上一个 chunk 留下的残留，恒满足
  `input === rest + pending`。⚠️ 漏掉它的后果不是「少一个事件」，而是**半条序列被当成按键**
  （`ESC[<0;1` 变成一次 Esc 加三个字符），界面会毫无征兆地跳页。残留有上限（`MAX_PENDING`），
  否则一条畸形流能让缓冲**无界增长**而吃干一个长驻进程。
- **坐标就是终端屏幕坐标，不需要任何平移**：SGR 协议给的 (x, y) 是那一格在**可见屏幕**上的位置
  （1-based），`parseSgr` 减一到 0-based 之后与 `@/console/geometry.ts` 的矩形已在同一套坐标里。
  ⚠️ **Ink `measureElement` 的那条警告不适用于这里**：它给的是 layout-tree 坐标、需要平移，
  **那是它的坐标需要平移，不是鼠标的**。
- **`Cx` / `Cy` 非正整数时消费字节但不产出事件**：有些终端拿不到位置时报 0，而 0 不是一格终端；
  硬减一成 0 就是拿假位置去喂命中测试，而命中的下标会被当成「用户点了那一行」。
- **命中测试不在本目录，在 `@/console/geometry.ts:hitTest`**（矩形是布局的概念，不是终端协议的
  概念）。⚠️ 本目录**不许**再导出第二个 `hitTest`。
- **探活的唯一诚实判据是「终端有没有回我们的上报请求」**：SGR 模式下按下鼠标时终端才会回一条序列，
  故四档 `MouseSupport`（`unknown` / `reported` / `idle` / `silent`）全部由**实测**得出。
  ⚠️ **绝不**查环境变量或平台去猜。⚠️ 更要紧的一条：**绝不许因为「没收到鼠标事件」就禁用键位** ——
  `MOUSE_UNSUPPORTED_HINT` 是一句提示，键位永远全部可用。
- **`process.*` 一律当入参**（`stdin` / `out` / `now`）：与本目录「组合根是唯一宿主采集面」同一条纪律。
- **回调里的异常不上报也不吞**：它沿 stdin 的 `emit` 冒出去把进程带崩。这与 Ink 调 `useInput`
  回调时的暴露面一致（它也没有守卫），在这里加守卫等于给鼠标这条路单独造一套吞异常的语义。
- ⚠️ **本模块是鼠标终端模式的唯一写入者**：`@/ui/screen.ts:ENTER_SEQUENCE` 里的那三条**只是把同一批
  序列列出来给对称性断言用**，而真正写出去的是 `enterFullScreen` 与 `createMouseSource.start/stop`。
  组合根走 `chainRestores(enterFullScreen(out), () => mouse.stop())` —— **两处都写**，因为
  DECSET / DECRST 是幂等的，而「漏关」的代价（操作者的终端永久吞掉粘贴）远比「多关一次」贵。

## 全屏接管（`screen.ts`）

- **备用屏幕（`?1049`）归 Ink，本模块一条都不许碰**：`render(…, { alternateScreen: true })` 自己发
  `?1049h` / `?1049l`。⚠️ 再写一遍会让终端的**备用屏幕栈错位**（进入两次、离开一次，此后每一次
  alt screen 程序都少一层）—— 这个错误**不会有任何一行报错**。故 `ENTER_SEQUENCE` / `EXIT_SEQUENCE`
  与源码里都不含它；`tests/screen.test.ts` 把这一条钉成**字符串字面量**级的断言。
- **本模块发的每一条都要有配对的撤销**，且 `EXIT_SEQUENCE === [...ENTER_SEQUENCE].reverse()` 逐条
  取反（同一个模式号、`h` ↔ `l`）。光标显隐也是**幂等的 set**（不是 toggle），故与 Ink 退出时补的
  那一次 `?25h` 重复不冲突。
- **收尾必须幂等**：`enterFullScreen` 返回的 `ScreenRestore` 重复调用一个字节都不写。理由是收尾有
  **三条**到达路径（`try/finally` / `process.once("exit")` / `waitUntilExit`），而它们经常都会跑。
  ⚠️ 幂等守卫**先**置位再写：收尾期间没有第二次机会，重试也写不进去。
- **`chainRestores` 把若干收尾合成一个**（结果仍幂等），让 `finally` 里只有一个调用点；
  ⚠️ 前一个抛了**不许**跳过后面的 —— 「一失败就都不做」等于把一条已知代价换成另一条已知代价，
  而最贵的那条是关不掉鼠标上报。

## 相关路径

- `@/ui/index.js` — 本目录**唯一**的出口（跨目录不许引深层路径）。
- `@/console/layout.tsx` — 唯一的消费者（它画）。
- `@/client/index.js` — `TuiCode`（`severityColor` 那条映射的键类型；⚠️ 它现在只在 barrel 上留着，
  呈现改由 `TONE_OF` 那张表承担）。
- 根仓 `src/manager/http/auth.ts` — 打码纪律的时序侧对侧。
- 根仓 `src/utils/log/config-log.ts` — 服务端那一侧的同一份「哪些键是秘密」。

## 相关测试

- `tests/format.test.ts` — 人读形态的边界值（`bytes` / `duration` / `percent(_, 0)` / `maskToken`
  固定长度 / `ellipsis` 的中文与 emoji / `padToWidth` 的中文右对齐 / `dash` 的空形态）。
- `tests/columns.test.ts` — 排版三条不变量：成品行宽不超总宽、按显示宽度算（中英混排）、
  切了必须置 `truncated`；外加「先砍右边」「`min` 生效」「定值列是承诺」「`flex` 分配是确定的」。
- `tests/mouse.test.ts` — 鼠标协议五条：分片到达（跨 `data` 的残留缓冲）、多条序列的条数与顺序、
  坐标 1-based 与已减一、滚轮是**按下**形态且无按键、`isMouseReport` 与 `parseSgr` 同源；
  外加探活四档换算与 `createMouseSource` 的接线。
  ⚠️ **命中测试的断言已经搬走**，它在 `@/console/geometry.ts:hitTest` 那一档里。
- `tests/input.test.ts` — **真 Ink 输入通路**（假 stdin + 真 `App` + 真 `MouseSource`）：
  鼠标报告一个字都不许进输入行。⚠️ 这一档**不能**由 `tests/mouse.test.ts` 代替 —— 那个 bug 出在
  两个消费者**之间**，纯函数档看不见「Ink 砍掉 ESC 之后把它当文本」。
- `tests/screen.test.ts` — 全屏接管的**序列对称性**与**幂等收尾**；外加两条源码级断言：
  本模块的**字符串字面量**里没有 1049、**文件头**必须留着「1049 归 Ink」那句警告。