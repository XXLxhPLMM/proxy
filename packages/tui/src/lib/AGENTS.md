# src/lib/ — 零 IO 的那一半（纯函数层）

本目录回答「一个值怎么变成屏上/请求里的一句话或一个坐标」：**排版**（`format` / `columns`）、**屏幕几何**
（`geometry`）、**行模型**（`log/`）、**输入串与插入符**（`input-line`）、**失败词汇与收窄组合子**
（`errors` / `decode` / `http`）、**失败 → 一行字**（`failures`）、**一条命令 → 若干行 + 副作用**
（`exec/`）、**对话那一圈**（`agent.ts`）。对外唯一出口 `@/lib/index.js`。

⚠️ `exec/` 与 `agent.ts` 有意**不在** `@/lib/index.js` 里转发：前者依赖 `@/api`，而本目录其余部分不认识契约的
字段语义；后者要引 `exec/` 与 `@/services/model.js`，转发进来就是运行期环。调用方分别直接引
`@/lib/exec/index.js` 与 `@/lib/agent.js`（成环理由与逐条清单见 `src/AGENTS.md` 那张表）。

## 层不变量

- ⚠️ **本目录零 IO、零 `process.*`、零 React、零 Ink**（`geometry.ts` 只读注入进来的宽高）：没有一处能触网、
  读时钟或读环境 —— 这是这些判据能被逐字断言的前提。⚠️ 牙齿在 `tests/geometry/layer-boundary.test.ts`
  （**源码级**：读本目录的源码文本，零 `process.*` / 零 `console.*` / 零宿主与渲染依赖的 import），
  而它**带判据自检** —— 负向断言的探测器写坏了照样全绿。
- ⚠️ **绘制与命中测试读同一个 `geometry()` 结果**：组件一行坐标都不许自己从 props 算，
  `Geometry.inputTextRows` 是唯一那份「字画在哪」的数组。⚠️ 矩形一律**半开区间** `[x, x+w)` × `[y, y+h)`，
  真重叠时**后来者赢**；非整数坐标 `hitTest` 返回 `-1`。
- ⚠️ **几何层只夹不推**：`sessionsTop` 越界由它夹一次，而「当前会话必须留在可见窗口里」是**状态层**的活
  （`@/AppState.js:revealSession`）—— 一并接管的话，滚轮翻看别的会话会在下一帧被拽回来。
- ⚠️ **`WINDOW_MIN_ROWS = 4` 是「上下 padding 两行 + 标题 + 分隔」的最小值**，而模态**装不下就整个不画**
  （一个装不下自己标题的窗口是纯噪音）：更小 ⇒ 画得出来却没内容，更大 ⇒ 矮终端上按 `/managers` **没反应**
  （屏上零解释）。⚠️ 它是**下限而不是比例**，故判据是「那一档画得下」而不是「屏高的一半」。
  ⚠️ **右上角那枚 `esc` 不是那四行里的固定一行**（`windowCloseHint` 为假时它整个不存在，而内容区照样铺槽位）
  —— ⚠️ 而**下限刻意不因此降**：「装不下自己标题的模态是纯噪音」这条判据与 `esc` 在不在**无关**。
- ⚠️ **窗口内容区按槽位铺**（`note` / `group` / `row` / `input` 四档，每档占一行；`GeometryInput.window`
  `[]` 是「没开窗口」的**唯一**写法）。⚠️ **`windowSlots` 是真相**（**与入参那串槽位同序同长**，装不下的给
  `null`），而 `windowRows` / `windowGroups` / `windowInput` 三者是**它的投影** —— ⚠️ **三档投影必须与
  `windowSlots` 同一趟循环里算出来**：各自再算一遍的话绘制与命中测试会错开一行，而症状是「点第 2 行选中第 3 个」。
- ⚠️ **侧边栏那一列的度量只有这一份**：`SIDEBAR_WIDTH` / `SIDEBAR_TEXT_X` / `SESSION_ROWS` /
  `SESSION_GAP_ROWS` / `SIDEBAR_TOP_PAD_ROWS` / `SESSION_STRIDE`（= `SESSION_ROWS` + `SESSION_GAP_ROWS`）/
  记号位 `SESSION_MARK_COLUMNS` / 关闭位 `SESSION_CLOSE_COLUMNS`。
  ⚠️ **两个留白是两个数**：项与项之间是 `SESSION_GAP_ROWS`，而**清单第一项之上另有
  `SIDEBAR_TOP_PAD_ROWS`**（恒 `1` 行，**不参与** `SESSION_STRIDE`）—— 少它的症状不是「看着挤」，而是
  侧边栏第一行与主区第一行同高，两侧的行号会互相读串。
  ⚠️ **记号位恒是 `3` 列（奇数才能居中）而关闭位是 `2` 列**：两枚字形（`⠋` / `●` 与 `✕`）的 East Asian
  Width 都是 **Ambiguous**，按 CJK 宽度渲染的终端里它们占**两列**。⚠️ **恒预留**（与「有没有记号」「指针在哪儿」
  都无关），⚠️ **`SIDEBAR_TEXT_X` 恒等于记号位的右缘** —— 记号位与名字那一列缩进是**同一批列**，不许叠加成两倍。
  ⚠️ **一个会话都没有**与「屏太窄」是**同一个**答案（`sidebar` 给
  `null`、那一列宽度归 0），而给一个 0 宽的矩形的话手柄会落到第 0 列上（那一列本来是主区的）。
- ⚠️ **会话菜单也是这一份坐标**（`Geometry.menu` / `menuRows`）：落点由**状态层**记（它是输入事件的位置），
  夹进屏内由**几何层**做 —— 两处各算一次的话贴着屏角的一次右键会让半张菜单掉出屏外。
- ⚠️ **`GeometryInput.menu` 不许设成可选**：`null` 是「没开菜单」的**唯一**写法，而 `undefined` 会让
  「忘了传」与「没开」在类型上分不开。
- ⚠️ **下标一律是 UTF-16 code unit**：`input-line.ts` / `geometry.ts:caretFromWrappedPoint` /
  `@/commands/complete.js` / `CaretRow` 四处必须逐字一致，否则插入符偏一个字。
- ⚠️ **换算只许在这里做**（字节 → 人话、时间 → 相对、token → 掩码），组件只把它们摆出去，否则同一个值在两处
  被换算成两个样子。⚠️ **`truncated` 不许被调用方忽略**：`fitTo` 先判「裁不裁得下」再裁并如实带出那个标志。
  ⚠️ **日历日不许按 24 小时算**（`format.ts:calendarDay`）：「上个月」不等于「30 天前」（月长不齐），
  而**只差一个钟点却跨了午夜**归「昨天」不归「今天」—— 牙齿在 `tests/format/day-group.test.ts`。
- **列宽从右往左让**（右列先缩）；⚠️ **宁丢列不丢字**；声明了固定宽度的列**是一个承诺**，不许被悄悄改窄。
- ⚠️ **`flatten()` 不许跨宽度缓存**；**滚动位置恒以「行」为单位**且被 `clampTop` 夹住，改了视口高度要在
  **读的那一侧**再夹一次。⚠️ **`maskEcho` 是唯一的掩码出口**：固定长度、按**凭据类别**而不是真实长度。
- ⚠️ **文案绝不转述对面的数据**（响应的 body、带凭据的地址、任何一段 token），**也绝不重打 userinfo** ——
  只说「哪个路径期望什么」与「地址的哪一段不对」。
- ⚠️ **`TuiError` 三档分开的理由是处置动作不同**：服务端答了「不」⇒ 读文案；**根本没答上** ⇒ 查地址与网络；
  答了但形状不对 ⇒ 多半是对面版本新/旧。本地形状不对挂 `wire` 档 + `invalid` 码（`TuiError.local`），
  ⚠️ 代价是 `status` 恒 `null`（**没收到响应就没有状态码，不许拿 `0` 冒充**）。
- ⚠️ **失败文案绝不引用用户输入**：token 与密码经过 `failures.ts` / `exec/failures.ts` 落进**可滚动的结果区**。
- ⚠️ **`agent.ts` 那一圈只拿到 `Command`、拿不到任何 client**（`ManagerClient` 一次都不许出现在它与
  `@/services/model.js` 的**代码**里，而判据是源码级的那一条，不变量写在 `packages/tui/AGENTS.md`「模型」一节）。
  ⚠️ **往返轮数有上限**（`MAX_ROUNDS`）：模型每轮都能再挑一条命令，而没有上限的那一版是一个会自己烧钱的循环。
  ⚠️ **命令跑完而模型没再说话时的那一句必须对得上屏面事实**：那一格**先于**副作用落桶，
  而 `/batch` 是**唯一一个零行却异步产出 N 份行**的命令 ⇒ 那句话按 `effects` 分流，指向**下面**。
- ⚠️ **收窄组合子（`decode.ts`）的调用点只有 `@/api/wire.js`**，而它走**深层路径** `@/lib/decode.js`：
  走 barrel 就是 `api/index → api/wire → lib/index → lib/failures → services/config → services → api/index`
  那条运行期环。⚠️ `obj` **放行未知键**；`opaque` 只给 `configKey.value` 那一个字段用。

## 相关

`@/api/index.js`（上游，契约）· `@/services/index.js`（下游，唯一拨号点）· `@/theme/index.js`（色档，本目录只读 `Tone` 做数据标注）
`tests/format/`（数量那一族）· `tests/columns/`（量宽度 / 砍宽度）· `tests/geometry/`（屏幕几何）· `tests/log/`（行模型与对话模型）· `tests/decode/`（收窄组合子）· `tests/agent/`（对话那一圈 + `/batch` 扇出）