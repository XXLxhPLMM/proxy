# tests/columns/ — `@/lib/columns` 的断言

两档：**量出来的宽度对不对**（行宽与显示宽度）与**宽度不够时砍谁、砍到哪、砍了说不说**（裁剪策略 +
`truncated`）。两档都只调 `planColumns` 这一个纯函数：零 IO、零终端、零 React，喂进去的是行数组与一个
总宽，拿到的是一份排版计划。「拆掉哪一处会红」归本文件，测试文件头只留一句「本档答什么」+
指回这里。

## 文件

- `width.test.ts` — 成品行宽不超总宽（Ink 折行是静默的，必须在排版层就掐掉）+ 宽度按**显示宽度**算
  （中文 / emoji 不许歪、`auto` 列取内容最大值）。
- `trim.test.ts` — 切了必须说一声（`truncated`）+ 裁剪顺序（先右后左、砍不到 `min`、定值列是承诺）。
- `AGENTS.md` — 本文件。

## 为什么拆掉哪一处会红

- `stringWidth` 换成 `String.length` → 「`auto` 列取内容最大值」那组在含中文的行上立刻给出 2
  而不是 4，表格在真终端里右边错开一格。**纯 ASCII 的用例对两种度量都成立**，所以那一组必须
  带中文行，否则这条护栏是恒绿的。
- 「从右往左砍」改成从左往右 → 「左边的身份列先保住」那组红。
- `min` 生效那组 → 有人把下限去掉（或者改成 `min - 1`）时红。
- 静默截断 → 有人删掉 `truncated` 的置位点时红（本组三条断言都在这一点上交汇）。

## 相关路径 / 测试

- `@/lib/columns.js` — 被断言的模块（`planColumns` / `ColumnSpec` / `COLUMN_GAP` / `DEFAULT_MIN`）。
- `@/lib/format.js:widthOf` — 显示宽度那一份度量，两档都拿它当尺子。⚠️ 它断言的是 `ellipsis` /
  `padToWidth`（`tests/format/width.test.ts`），**不是 `widthOf` 自己** —— 而「纯 ASCII 用例对两种度量
  都成立」那个坑对两档同时成立，改度量时两处要一起看。
- 两档都直接引 `COLUMN_GAP` / `widthOf`（模块的导出），**不经第三个文件中转** —— 本目录没有 `_` 模块，
  因为除了 `planColumns` 本身没有任何本地代码跨档共用。
