# src/lib/log/ — 对话模型 + 行模型（一格 `Turn` → 一组行）

结果区那半边的全部状态模型：纯数据 + 纯函数，**零 Ink、零 React、零终端、零 HTTP、零 `fs`**。排版的**算术**
在 `@/lib/format.js`（宽度与对齐），本层只决定**哪一档行怎么折**。对外唯一出口 `@/lib/log/index.js`。

## 文件

- `turn.ts` — `Turn`（六个变体）+ `rowsOfTurn()`（**穷举 `switch`**）：**桶里的一格是 `Turn` 而不是 `LogRow`**。
- `rows.ts` — `LogRow` / `LogLine`、`flatten()`、视口（`visibleLines` / `clampTop`）、环形缓冲（`append` /
  `trim` / `dropped`）、**全包唯一的掩码出口** `maskEcho()`。
- `index.ts` — barrel，**只转发**。

## 两层，两件事

- ⚠️ **`Turn` 答「这是什么」，`LogRow` 答「画成什么形状」**。它们**不许**合成一个类型：
  今天「用户敲的」「模型挑的命令」「命令的结果」「本包自己说的话」「一次失败」全是同一种行，
  于是渲染只能靠字符串嗅探，而「本包自己说了一句」要么被塞进 `error`（染上危险色 = 一句假事实）、
  要么就得另造一个变体。
- ⚠️ **变体表（六个）**：���`user`（不以 `/` 开头的那一行）/ `assistant`（模型的一句话，逐字上屏）/
  `tool-call`（模型挑的命令，`echo` **恒为掩码之后那一份**，由 `@/lib/exec` 的回显边界造）/
  `tool-result`（命令的输出行）/ `notice`（**本包**自己说的话：存盘结果、显隐结果、「当前会话不许藏」）/
  `error`（一次失败）。⚠️ `notice` 与 `error` 分开是**判据**不是装饰。
- ⚠️ **`rowsOfTurn` 的 `switch` 穷举**（`default` 那支形参是 `never`）：多一个变体时 **`tsc` 就红**，
  不是运行期静默少一行。牙齿：`tests/log.test.ts` 不变量 ⑦（六个变体各一例 + 色档两两可分）。

## 层不变量

- **散文（`text` / `note` / `err` / `echo`）按显示列折行**（CJK 与 emoji 占两列）；**`kv` / `table` 永不折行**
  —— 折了就对不齐，改为裁剪并留 `…`；⚠️ `LogRow.table` 的**表头长度恒等于每行长度**。
- ⚠️ **`flatten()` 不许跨宽度缓存**：行是按宽度算出来的，换宽度必须重算。
- **`append` 的 id 从 1 起**，于是 `dropped()` 的 `0` 哨兵（「什么都没丢」）没有歧义；⚠️ **丢掉的
  历史必须报得出来**（界面写进滚动提示行）。
- **滚动位置恒以「行」为单位**且被 `clampTop` 夹住；改了视口高度要在**读的那一侧**再夹一次。
- **`maskEcho` 是唯一的掩码出口**：固定长度、⚠️ 按**凭据类别**（`user-pass` / `target-add` / `provider-key`）
  而不是真实长度 —— 两个不同长度的 token 必须渲染成**一模一样**的东西。⚠️ 类别是**逐条对齐**的而不是
  「凡是要紧的都打码」：漏一个类别，那个凭据就**原样上屏**（而屏上有回显、操作者滚得回去、终端还有回滚缓冲）。

## 相关路径 / 测试

- `@/lib/index.js` — `fitTo` / `padToWidth` / `widthOf`；列宽由 `@/lib/exec/rows.js` 算好后带进来，本层不重排。
- `@/features/output/OutputView.tsx` — 下游：把行画成 `<Text>`，颜色由 `LogLine.tone` 决定。
- `tests/log.test.ts` — 折行 / 表与 kv 不折行 / 滚动位置 / 丢弃报得出；每条折行判据配一个 CJK 案例；
  不变量 ⑦ 是 **`Turn` 的六个变体各一例**（判据按 `kind` 与色档，不靠字符串嗅探）。
