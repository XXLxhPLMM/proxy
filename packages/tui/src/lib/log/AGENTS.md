# src/lib/log/ — 对话模型 + 行模型（一格 `Turn` → 一组行）

结果区那半边的全部状态模型：纯数据 + 纯函数，**零 Ink、零 React、零终端、零 HTTP、零 `fs`**。排版的**算术**
在 `@/lib/format.js`（宽度与对齐），本层只决定**哪一档行怎么折**。对外唯一出口 `@/lib/log/index.js`。

## 文件

- `turn.ts` — `Turn`（六个变体）+ `rowsOfTurn()`（**穷举 `switch`**）：**桶里的一格是 `Turn` 而不是 `LogRow`**。
- `rows.ts` — `LogRow`（**七档**）/ `LogLine`、`flatten()`、视口（`visibleLines` / `clampTop`）、环形缓冲（`append` /
  `trim` / `dropped`）、**全包唯一的掩码出口** `maskEcho()`。
- `codec.ts` — `encodeTurns` / `decodeTurns`：一格对话 ⇄ 一段 JSON（`messages.turns` 那一格的唯一编解码）。
- `index.ts` — barrel，**只转发**。

## 两层，两件事

- ⚠️ **`Turn` 答「这是什么」，`LogRow` 答「画成什么形状」**。它们**不许**合成一个类型：桶里装的是
  `Turn`（六档），摊平之后才是 `LogRow`（**七档**），而**判别字段各归一层**（`Turn` 的 `echo` 里装的是一格 `LogRow`）。
  ⚠️ **同一种形状的两件事不许合并渲染**：屏上必须分得开「操作者敲的那句话」与
  「模型挑的**要执行**的那条命令」，而按字形分就得去嗅探字符串 —— `❯ /providers` 那条命令恰好是要执行的那一条。
- ⚠️ **`LogRow` 的变体表（七档）**：`echo`（命令回显）/ `user`（**操作者敲的那一句话**，⚠️ 与 `echo` 分开是
  **判据**：`❯` 两处都有，而**底色只有 `user` 有**，两个通道各自独立）/ `head` / `kv` / `table` / `note` / `err`。
- ⚠️ **`Turn` 的变体表（六个）**：`user`（不以 `/` 开头的那一行）/ `assistant`（模型的一句话，逐字上屏）/
  `tool-call`（模型挑的命令，`echo` **恒为掩码之后那一份**，由 `@/lib/exec` 的回显边界造）/
  `tool-result`（命令的输出行）/ `notice`（**本包**自己说的话：存盘结果、显隐结果、「当前会话不许藏」）/
  `error`（一次失败）。⚠️ `notice` 与 `error` 分开是**判据**不是装饰。
- ⚠️ **`rowsOfTurn` 的 `switch` 穷举**（`default` 那支形参是 `never`）：多一个变体时 **`tsc` 就红**，
  不是运行期静默少一行。牙齿：`tests/log/turn.test.ts` 不变量 ⑦（六个变体各一例 + **`user` 独占
  `kind:"user"` 那一档** + 它与命令回显色档不同；⚠️ 而「六档色档两两不同」是**假事实** ——
  `tool-result` 与 `notice` 都把内部行原样透出，色档由行自己决定）。

## 层不变量

- **散文（`text` / `note` / `err` / `echo` / `user`）按显示列折行**（CJK 与 emoji 占两列）；
  **`kv` / `table` 永不折行** —— 折了就对不齐，改为裁剪并留 `…`；
  ⚠️ `LogRow.table` 的**表头长度恒等于每行长度**。
- ⚠️ **折行的**每一段**都带那一档 `kind` 与色档**（呈现层按**逐行**的 `kind` 分派气泡与普通行，
  只给第一段带的话气泡左边会参不齐；而 `part` 是段序号，呈现层拿它当 React key 的一半）。
- ⚠️ **`flatten()` 不许跨宽度缓存**：行是按宽度算出来的，换宽度必须重算。
- **`append` 的 id 从 1 起**，于是 `dropped()` 的 `0` 哨兵（「什么都没丢」）没有歧义；⚠️ **丢掉的
  历史必须报得出来**（界面写进滚动提示行）。
- **滚动位置恒以「行」为单位**且被 `clampTop` 夹住；改了视口高度要在**读的那一侧**再夹一次。
- **`maskEcho` 是唯一的掩码出口**：固定长度、⚠️ 按**凭据类别**（`user-pass` / `target-add` / `provider-key`）
  而不是真实长度 —— 两个不同长度的 token 必须渲染成**一模一样**的东西。⚠️ 类别是**逐条对齐**的而不是
  「凡是要紧的都打码」：漏一个类别，那个凭据就**原样上屏**（而屏上有回显、操作者滚得回去、终端还有回滚缓冲）。
  ⚠️ 正因为掩码在这一层，落盘那一份 `echo` 行里**没有**明文（牙齿是 `tests/sqlite/messages.test.ts` 那一条）。
- ⚠️ **编解码判别靠 `kind` 且只靠 `kind`**：`Object.hasOwn(那张表, kind)`，⚠️ **不许用 `in`** ——
  `in` 会答 `true` 给 `constructor` / `toString`（它们在 `Object.prototype` 上），于是 `{"kind":"constructor"}`
  会被当成一个真类别而**不抛**。
- ⚠️ **`Turn` 与 `LogRow` 的判别字段都叫 `kind`，而编解码不许把它们混成一层**（`Turn` 是 `{kind:"tool-result", rows: LogRow[]}`）。
  两张 `Record<kind, …>` 表**穷尽**各自的联合，故「加了变体忘了编解码」是**编译期**红。
- ⚠️ **往返必须逐字节**（`encodeTurns(decodeTurns(x)) === x`）：编解码不重排、不补默认值，
  ⚠️ 选填键（`tone` / `right`）不在字节里就**不许**在解出来的对象上有那个键（`tone: undefined` 会让 `toEqual` 绿，
  而下一次写出的字节就与上一次不同了）。
- ⚠️ **解不出来就抛，`Error` 就够**：调用方 `@/services/config` 那一层把它包成 `LedgerError`。
  ⚠️ **文案只说形状，绝不引用载荷**（载荷可能是一句用户聊天消息，而错误文案会进可滚动的结果区）。

## 相关路径 / 测试

- `@/lib/index.js` — `fitTo` / `padToWidth` / `widthOf`；列宽由 `@/lib/exec/rows.js` 算好后带进来，本层不重排。
- `@/services/config/store.ts` — 下游：`messages.turns` 那一格的读写（⚠️ 走 `@/lib/log/index.js` 这个 barrel，
  而**不是** `@/lib/index.js` —— 后者转发 `failures.js`，而它反过来引 `@/services/config/index.js` ⇒ 环）。
- `@/features/output/OutputView.tsx` — 下游：按**逐行的 `kind`** 把 `user` 分派给
  `@/features/output/UserBubble.tsx`（带底色与那枚箭头），其余各档是一色一行，色档取自 `LogLine.tone`。
- `tests/log/` — 折行 / 表与 kv 不折行 / 滚动位置 在 `layout`；丢弃报得出 在 `entry`；每条折行判据配一个 CJK 案例；
  **`user` 那一档的折行形状（逐段带 `kind` / 不标截断）在 `rows`**；不变量 ⑦ 是 **`Turn` 的六个变体各一例**
  （判据按 `kind` 与色档，不靠字符串嗅探）；**编解码**（七 × 六 = 42 个组合逐字节往返 / 未知 `kind` 即抛 /
  `Object.prototype` 撞不出类别 / 文案不引用载荷）在 `codec`。
- `tests/sqlite/messages.test.ts` — `messages` 表本身（`seq` 的来源 / 升序读回 / 收口 / 坏内容即拒 / **落盘字节里没有明文凭据**）。
