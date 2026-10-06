# src/theme/ — 语义 → 颜色的唯一映射面

`palette.ts`（三张表 + 盖遮罩的那一道变换 + 取表的那一道判据：`COLORED` / `SCRIMMED` / `PLAIN` —— ⚠️ 三张表都是
**模块私有**，唯一合法的取法是同文件的 `themeOf`；另有 `Tone` / `Theme` / `ThemeOptions`）与 `impl.ts`
（语义 → 颜色 / 字形的其余函数与类型：`toneColor` / `severityColor` / `connectionMark` / `connectionStateOf` /
`toastMark` / `runMarkOf`）。对外唯一出口 `@/theme/index.js`（纯转发 barrel）。**零 IO、零 Ink、零 `process.*`**（组合根采一次往下传）。

⚠️ 底色**只有五档**（`surface` / `hover` / `scrim` / `panel` / `bubble`），而**加第六档的前提是先有一个真的要用它的地方**
（一处语义、一个真的要被指着的那一格），不是「将来也许用得上」—— 判据是**屏上有一件事要靠它分**。
⚠️ **`bubble` 之所以够那个门槛**：用户消息那一段**有底色而命令回显没有**，两件事在屏上真的靠它分开
（症状是「这两行都是我说的话」而分不出哪一行是要执行的）。

⚠️ **`reasoning` 那一档与 `warn` 同值而独立成档**：屏上「推理强度」那一行与「要你处理」的提示
从不相邻，故同色不违反「两个事实不许渲染成同一个东西」（那一条的射程是**同一处语境**）；
而独立成档是因为它**是个不同的语义** —— 将来改配色时它该能单独动。同理，**「提供商名」那一档
复用 `muted`**：加第六/第七档的前提是有一件新事要靠它分，而那一行已经有 `muted` 可用。

## 相关

`@/lib/errors.js`（`TuiCode`）/ `@/services/config/index.js`（`ProbeResult`）· `@/components/index.js`（消费方）
`tests/theme/`（`theme.test.ts` 遮罩那一段 · `marks.test.ts` 记号那一族）· 判据的画面在 `tests/layout/`