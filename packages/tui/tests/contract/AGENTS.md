# tests/contract/ — 呈现层**视图契约**的形状

本目录回答「`@/components/types.ts` 那份 props 契约长什么样」：`ModalView` 每一档的键集、判别字段与
`@/store` 的 `WindowState.kind` **逐字同名**、`LayoutProps` 里**零坐标零函数**。
**零 IO、零 Ink、零 React**（判据是读源码文本 + 真的造一份对象，故不必起一个 Ink 去截图）。

被测模块的不变量归 `src/components/AGENTS.md`；这里只记**本目录这一组断言共同成立的那些前提**。

## ⚠️ 两边的判别值**不是同一个集合**：`ModalView` 是 `@/store` 的**超集**，例外逐字列得出

⚠️ 五个表单（提供商 / 控制面 / 账号 / 改密码 / 改显示名）要的格子从**四格到一格**不等，而一个跨帧联合
表达不了 ⇒ 它们是**呈现**的形状（`ModalView["provider-form"]`，走 `fields`）而不是**跨帧状态**的形状。
故判据是「`ModalView` 的判别值 == `@/store` 的判别值 ∪ **例外表**」：

| 档 | 为什么它不进 `@/store` 的 `WindowState` |
| --- | --- |
| `provider-form` | 五种表单的字段表彼此不同（`draft` 那一格只表达得了提供商那一种），而一个「`kind` + 全可选字段」的变体正是那份形状的谎话 ⇒ 住状态层的局部 `FormState`，屏上只拿 `fields`（长度由状态层给） |

⚠️ **例外表是判据的一部分，不许因为「今天只有一档」就把它删掉**：少了它，「多一档」与「少一档」两个方向
就有一个恒绿 —— 而那正是根仓 `AGENTS.md`「写护栏时」点名的坑（**放行一个已删的例外**与点名一个已删的
符号一样会让判据恒真）。⚠️ 故表里每一项都带**为什么**，且判据额外断两条：① 每一项**真的在**视图里
（表里写着一个已删的档名 ⇒ 恒绿）；② 表**恒非空**（空表 ⇒ 上面那条恒绿）。
⚠️ 另一半也断：**`@/store` 那一侧不许多出不在视图里的档**（多一档 ⇒ 状态层开得出来而呈现层画不出，
症状是「弹窗开了一张空卡片」而屏上零解释）。两条变异实测：`ModalView` 加一档 ⇒ 三条转红；
`WindowState` 加一档 ⇒ 那一条转红（且 `AppState` 的收窄与 `slotsOf` 同时被 `tsc` 逮住）。

## ⚠️ 本档的判据形状：**现取的事实**，不是抄一份数组、也不是点名某个符号

这一档的第一版把七档判别值**抄成一份 `MODAL_KINDS` 常量**再自己比自己 —— 实测五种变异
（加一档 / 判别字段改名 / 删一档 / 加一格坐标 / 加一个函数字段）**全部恒绿**，
而那正是根仓 `AGENTS.md`「写护栏时」点名的两种恒真（抄一份 ⇒ 两处一起漂时一起绿；
点名一个已删的符号 ⇒ 永远不会红）。故那一版整段拿掉，换成**从源码现取**：

| 现取什么 | 从哪儿取 | 判据落在什么上 |
| --- | --- | --- |
| `ModalView` 的判别值 | `types.ts` 里那个 union 的**每一个** `readonly kind: "…"` | 等于 `@/store` 那一侧的集合 **∪ 例外表** |
| `ModalView` 每一档的键集 | 那一支从 `readonly kind: "x"` 到下一个 `readonly kind:` 之间 | 逐档等于那张期望表（**多一格少一格都红**） |
| `WindowState` 每一档的键集 | `@/store/app-store.ts` 里同一个判别值的分支（**同一套括号计数**） | **每一档都带 `pending`**，而**视图那一侧不带** |
| `LayoutProps` 的成员 | 那个 `interface` 里每一个 `readonly x[?]:` | **零坐标零函数**（见下）与「那几格恒在」 |
| `RunState` / `WindowState` / `WindowSlot` | `@/store/app-store.ts` · `@/lib/geometry.ts` | `run` 三档不少 · 两边判别值的关系如上 · 槽位六档不多不少 |

⚠️ **`codeOnly` 先剔注释**：不剔的话「本文档自己提了一句 `Rect`」会让判据恒红，
而「探测器认错了东西」与「实现坏了」在屏上完全一样。

## ⚠️ 每条负向断言都配**同一条 `it` 里的正向对照**

⚠️ **`expectTypeOf` 那一族在 `vitest` 里恒绿**（类型断言不是运行期判据，只在 `tsc` 那一层生效），
故每条形状判据旁边都有一条**运行期可判**的对照，答的是「探测器今天还能取到东西吗」——
取不到就当场红，而不是静默判成通过。

- 「零坐标」那条的对照：`columns` / `rows` / `sidebarWidth` / `top` / `cursor` **恒在**
  （`top` 与 `cursor` 是**行号与下标**，不是坐标 —— 它们推不出一个矩形）。
- 「零函数」那条的对照：探测器**认得** `=>` 与 `Function` 那两种形状。
- 「两两不同 / 逐字钉住」那几条的对照：期望表本身**覆盖了全部成员**（少一档就红）。
- 「每一档都带 `pending`」那条的对照：同一档的**别的**格子（`kind`）也取得到 ⇒ 取到的是那一支而不是整份声明。
- 「`FieldCell.cursor` 必带」那条的对照：`cursor?:` **真的没有**（可选的那份混进来时上面那条会红）。
- 「改显示名那一档只有一格」那条的对照：**同一档**给五格时 `slotsOf` 的输出真的长到五格
  （恒长一格是恒绿的；而判据量的是**槽位串**不是「渲染器支持几格」这种读不出来的东西）。

## 判据为什么这么写（三条，各自有牙齿 —— 变异实测全红）

| # | 变异 | 转红的判据 |
| --- | --- | --- |
| C1 | `ModalView` 加一档（`panels`） | 「视图的判别值 == `@/store` ∪ 例外表」+「每一档的键集逐字钉住」+「现取的每一档都造得出来」+ `slotsOf` 的穷尽 `switch` |
| C1b | `WindowState` 加一档（`panels`，视图里没有它） | 「视图的判别值 == `@/store` ∪ 例外表」（实测转红）+ `AppState.tsx` 的收窄被 `tsc` 逮住 |
| C1c | 从 `ModalView` 删掉 `provider-form` 那一档而**不动例外表** | 「视图的判别值 == `@/store` ∪ 例外表」（例外表恒非空 + 每一项真在视图里 ⇒ 那一档删了就红） |
| C2 | `sessions` 那一档的判别值改名成 `history` | 同 C1 的三条（且 `@/store` 那一侧不变 ⇒ 集合关系不成立） |
| C3 | 删掉 `sessions` 那一整档 | 同 C1 的三条 |
| C4 | `provider-form` 的 `fields` 改名成 `cells` | 「每一档的键集逐字钉住」 |
| C5 | `ListRow` / `SessionListRow` 删掉 `pending` | 「清单三档**行上**带 `pending`」 |
| C6 | `LayoutProps` 加一格坐标（`where: Rect` / `hit: readonly Rect[]` / `origin: { x; y }`） | 「零坐标成员」 |
| C7 | `LayoutProps` 加一个函数字段（`pickSession: (id) => void`） | 「零函数字段」（判据是**声明原文的形状**，不靠命名习惯） |
| C8 | 删掉 `SessionRow.seen`（把「跑完了没看」合成一格） | 「『完成』记号那一族是**两个格子**」 |
| C9 | `RunState` 删一档（`runMarkOf` 的 `Record` 靠它） | 同 C8 那一条 |
| C10 | `FieldCell.cursor` 改成**可选**（`cursor?:`） | 「`FieldCell` 的几个键」里的必带那条 + 那条的反向自检 |
| C11 | `WindowState` 少一档带 `pending`（比如把 `models` 那一个改回去） | 「每一档清单的**窗态**上都挂着 `pending`」 |
| C12 | 给 `ModalView` 某一档加一格 `pending` | 同 C11 的后半句（视图那一侧**不许**有那一格） |

⚠️ **C6 的三种写法都试过**：只按**成员名**判（列 `x` / `y` / `rect` / `origin` …）时
`where: Rect` 与 `hit: readonly Rect[]` **漏过** —— 故最终判据是**类型形状**：
类型**指名**几何层那几种（`Rect` / `Geometry` / `Point` / `MenuRequest`）**或**内联一个带坐标格的对象，
两条各自独立。

⚠️ **`declBody` 的括号只数 `(` `[` `{`**（数 `<`/`>` 会被 `=>` 与比较运算坑掉，而本目录里两者都有），
且**结束判据分两种**：`interface` 收在把深度带回 0 的那个 `}`，`type` 收在深度 0 上的 `;`
—— `type X = | {…} | {…}` 的第一档闭完深度就回 0 了，按「闭括号即止」取到的**只有第一档**
（这是本档实测踩过的第二个探测器 bug）。

## 档位地图

⚠️ **本目录只有一档**（`contract.test.ts`），故**不建**第二份 `AGENTS.md` —— 判据是
「这段不变量有几档共用」（`packages/tui/AGENTS.md`），只有一档时那唯一一档的文件头就是全部。

| 档 | 答什么 |
| --- | --- |
| `contract.test.ts` | `ModalView` 七档的键集与判别值（**含那份逐字列出的例外表**）、`FieldCell` 的必带格、`WindowState` 每一档的 `pending`、`LayoutProps` 的零坐标零函数、「完成」记号是两个格子 |

## 相关

`src/components/types.ts`（被测的契约）· `src/components/AGENTS.md`（那一层的不变量）·
`@/store/app-store.ts`（`WindowState.kind` / `RunState`，判别值的另一半）·
`@/lib/geometry.ts`（`WindowSlot` 六档）· 判据的画面在 `tests/layout/`（假 TTY 真渲染）