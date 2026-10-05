# src/features/ — 一块块用户看得见的东西

本目录按**功能**而不是按版式分块：`sessions/SessionSidebar`（会话栏）、`sessions/SessionMenu`（右键弹出的
那个菜单）、`sessions/SessionHistory`（**历史会话弹窗的内容区**）、`chat/Composer`（输入行）、
`chat/CommandPalette`（命令面板）、`output/OutputView`（结果区）、
`output/Welcome` + `output/logo.tsx`（引导屏那块标记的素材）。对外唯一出口 `@/features/index.js`；
组合出口是 `@/app.tsx`。

⚠️ 这些组件**只画**：坐标全部来自 `props.g`，判定全部来自 `@/lib`，着色列全部来自 `@/theme`。
版式的词汇（props 契约、共用字形、`tone`）与**模态卡片的外壳**在 `@/components/index.js`。

## 层不变量

- ⚠️ **组件之间不认识**：feature 之间零 import（`features/index.js` 只是转发），面板高亮与输入行的关系由
  状态层经 `PaletteView` 传进来，而菜单的高亮与那一项作用在谁身上由 `MenuView` 传进来 —— 组件互相找对方。
- ⚠️ **`SessionMenu` 与 `SessionSidebar` 互不认识**：菜单画在侧边栏**之上**，而「谁压在谁上面」靠的是
  `Layout` 里的**顺序**（后画的赢），不是靠这两块互相知道。
- ⚠️ **`SessionHistory` 与控制面清单那一份（`@/components/layout/window.js`）互不认识**：两者共用**同一块
  卡片外壳**（`WindowCard`）与**同一份槽位序**（`historySlotsOf`），而行模型与动作都不同（每一行是
  「一个会话 + 它有没有在侧边栏上」，外加**分组标题**与**改名框**）。⚠️ **槽位序不许在组件里另排一次**：
  `@/app.tsx` 拿它喂几何层，呈现层拿它读 `Geometry.windowSlots`，三处各算一次就会错开一格。
- ⚠️ **`SessionHistory` 的两处「已」是两件事**：`at`（高亮 = 指针/键盘停在哪）与 `pinned`
  （已在侧边栏上）**形不同、档也不同** —— 渲染成同一个东西就分不出「它已经在了」与「我现在指着它」。
  ⚠️ 分组标题**不吃高亮、也没有记号**（它是标题不是可选项）；而 `view.at` 数的是**可选会话**而不是数组下标。
- ⚠️ **改名框搬进弹窗之后输入区不再参与**：提示符恒 `PROMPT`，而**弹窗开着时 `Composer` 不画插入符**
  （屏上留着那个反底色的光标块等于说「焦点还在输入框」）。⚠️ 那一格要留在输入框里就白改了。
- ⚠️ **`label` 是状态层裁好的那一份，呈现层不自己裁**（`WindowRow.name` 那条纪律）；反过来
  `note` **没有**那份承诺，由本层裁到那一槽的预算 —— 两条相反的纪律住同一个 `switch` 的两个分支上。
- ⚠️ **不得画不属于自己的那一块**：`Composer` 只画输入框内那几行，框与折行由几何层给（`props.g.inputTextRows`）。
- ⚠️ **`logo.tsx` 零 React**（`.tsx` 只是历史遗留的扩展名），⚠️ **艺术字不许用花体字 / 阴影字 / emoji**；
  ⚠️ 它**不是**「只许纯 ASCII」—— 引导屏那块标记刻意用了 `█` 与 box-drawing（理由写在该文件头）。⚠️ 代价不藏：
  那些字形在 East Asian Width = **Ambiguous** 的终端里是两列，整块标记会宽出一倍并折断 —— 缓解是
  「**放不下就不画**」由几何层判。
- ⚠️ **引导屏那块标记的尺寸住在 `logo.tsx`**（`LOGO_ROWS` / `LOGO_WIDTH`），而 `@/lib/geometry.ts` 据此判
  「这一屏放不下就不画」—— 走**深层路径**引它，而补一个 `output/` 自己的 barrel **也去不掉**那条例外
  （`OutputView.js` 引 `@/lib/index.js` ⇒ 成环的理由见 `src/AGENTS.md` 那张表）。
- ⚠️ **子目录自己没有 barrel**（`chat/` `output/` `sessions/` 各只有一层出口），⚠️ 故 `features/index.js`
  转发的是那 **7** 个组件本身，而不是三个子 barrel。

## 相关

`@/app.tsx`（唯一组合方）· `@/components/index.js`（props 契约、共用字形与模态卡片外壳）· `@/lib/index.js`（几何与排版）· `@/theme/index.js`
`tests/layout/` · `tests/input/`