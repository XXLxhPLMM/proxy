# src/lib/log/ — 行模型（一组条目 → 一组行）

结果区那半边的全部状态模型：纯数据 + 纯函数，**零 Ink、零 React、零终端、零 HTTP、零 `fs`**。排版的**算术**
在 `@/lib/format.js`（宽度与对齐），本层只决定**哪一档行怎么折**。对外唯一出口 `@/lib/log/index.js`。

## 文件

- `rows.ts` — `LogRow` / `LogLine`、`flatten()`、视口（`visibleLines` / `clampTop`）、环形缓冲（`append` /
  `trim` / `dropped`）、**全包唯一的掩码出口** `maskEcho()`。
- `index.ts` — barrel，**只转发**。

## 层不变量

- **散文（`text` / `note` / `err` / `echo`）按显示列折行**（CJK 与 emoji 占两列）；**`kv` / `table` 永不折行**
  —— 折了就对不齐，改为裁剪并留 `…`；⚠️ `LogRow.table` 的**表头长度恒等于每行长度**。
- ⚠️ **`flatten()` 不许跨宽度缓存**：行是按宽度算出来的，换宽度必须重算。
- **`append` 的 id 从 1 起**，于是 `dropped()` 的 `0` 哨兵（「什么都没丢」）没有歧义；⚠️ **丢掉的
  历史必须报得出来**（界面写进滚动提示行）。
- **滚动位置恒以「行」为单位**且被 `clampTop` 夹住；改了视口高度要在**读的那一侧**再夹一次。
- **`maskEcho` 是唯一的掩码出口**：固定长度、⚠️ 按**凭据类别**（`user-pass` / `target-add`）而不是真实
  长度 —— 两个不同长度的 token 必须渲染成**一模一样**的东西。

## 相关路径 / 测试

- `@/lib/index.js` — `fitTo` / `padToWidth` / `widthOf`；列宽由 `@/lib/exec/rows.js` 算好后带进来，本层不重排。
- `@/features/output/OutputView.tsx` — 下游：把行画成 `<Text>`，颜色由 `LogLine.tone` 决定。
- `tests/log.test.ts` — 折行 / 表与 kv 不折行 / 滚动位置 / 丢弃报得出；每条折行判据配一个 CJK 案例。
