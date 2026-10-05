# src/theme/ — 语义 → 颜色的唯一映射面

`palette.ts`（三张表 + 盖遮罩的那一道变换 + 取表的那一道判据：`COLORED` / `SCRIMMED` / `PLAIN` —— ⚠️ 三张表都是
**模块私有**，唯一合法的取法是同文件的 `themeOf`；另有 `Tone` / `Theme` / `ThemeOptions`）与 `impl.ts`
（语义 → 颜色 / 字形的其余函数与类型：`toneColor` / `severityColor` / `connectionMark` / `connectionStateOf` /
`toastMark` / `runMarkOf`）。对外唯一出口 `@/theme/index.js`（纯转发 barrel）。**零 IO、零 Ink、零 `process.*`**（组合根采一次往下传）。

⚠️ 底色**只有四档**（`surface` / `hover` / `scrim` / `panel`），而**加第五档的前提是先有一个真的要用它的地方**
（一处语义、一个真的要被指着的那一格），不是「将来也许用得上」—— 判据是**屏上有一件事要靠它分**。

## 层不变量

- ⚠️ **输出必须逐字唯一**：两个不同的事实**不许**渲染成同一个东西 —— 一个「连接失败」与一个「从来没试过」长得
  一样，操作者就分不出「卡住了」与「还没开始」。`connectionStateOf` 是全包唯一那份换算。
- ⚠️ **不存在「这里我想用青色」这种用法**：`toneColor` 是**全包唯一**的颜色出口，语义 → 色的映射只有这一个面
  （`@/components/constants.ts:tone` 是它在组件侧的同形薄封装，两处都只查表）。
- ⚠️ **`themeOf` 入参是对象**而不是两个 `boolean`：写反了在类型上合法，而症状是「遮罩开着却整屏正常亮」。
- ⚠️ **不上色时每一档都是 `undefined`**（而不是换一套灰阶）：灰阶仍然会被读成「这里有分级」；底色同样归
  `undefined`，于是无色档上侧边栏与主区**长得一样**（那条 hover 测试只在 `color: true` 下有意义）。
- ⚠️ **底色四档排成两条链**（判据，不是审美）：平时只有 `surface` < `hover`；**遮罩开着时**
  `scrim` < `surface` < `hover` < `panel` —— **遮罩最深、卡片次之**（明暗差的方向是「卡片浮起来」，
  旧版那条「浅遮罩 + 深卡片」的链已经翻过来了）。⚠️ 中间那两档只为了让侧边栏的列边界与悬停仍读得出来。
  ⚠️ **遮罩态的 `surface` / `hover` 与全部七档前景都由 `veiled()` 从 `COLORED` 推出来**
  （`veil(色, keep)` = 按 `keep` 压向 `scrim`），故那条链**不可能**与基础表漂。
- ⚠️ **遮罩态的前景「两两不同、且都读不出来」**：压暗的幅度由 `VEIL_TEXT` 一个数定死（至多留一成），
  于是「近乎不可读」与「两个事实不许渲染成同一个东西」这两条不变量**同时成立** —— 旧版把七档压成同一档
  是因为亮遮罩里「差一点点」与「差很多」之间没有余地；⚠️ 换成暗遮罩之后那个约束消失了，别再压成一档。
- ⚠️ **字形是状态的第二通道**：`connectionMark` / `toastMark` / `runMarkOf` 的字形刻意选成**轮廓差异明显**的一组
  （色盲用户与 `NO_COLOR` 环境下两者都靠形状读），且这三张表**刻意共用字形** —— 同一个字形在不同语境里
  必须指同一件事。
  ⚠️ **`runMarkOf` 的三档真值表**（`RunState` 是**穷举**的，加一档就是 `tsc` 直接红）：

  | 档 | 字形 | 色档 | 为什么 |
  | --- | --- | --- | --- |
  | `idle` | **一个空格** | `idle` | 那一格**恒存在**（空串会让名字在两帧之间跳一格），而它答「没在跑」 |
  | `running` | `⠋` | `accent` | 唯一那一档「在动」，色档也最显眼 |
  | `done` | **`●`** | **`ok`（绿）** | 与 `connectionMark("connected")` / `toastMark("ok")` **共用 `●`** —— 「跑完了」正是成功 |

  ⚠️ `done` 用 **`ok` 那一档而不是 `muted`**：「跑完了但你没看」是**要你看**的事，压暗它等于把这一档说成噪音。
- ⚠️ **`SEVERITY_TONE` 的类型是 `Record<TuiCode, Tone>` 而不是 `Partial`**：这让「服务端加一档 code」在
  `pnpm typecheck` 阶段就把这张表打红。

## 相关

`@/lib/errors.js`（`TuiCode`）/ `@/services/config/index.js`（`ProbeResult`）· `@/components/index.js`（消费方）
`tests/theme/`（`theme.test.ts` 遮罩那一段 · `marks.test.ts` 记号那一族）· 判据的画面在 `tests/layout/`