# src/features/ — 一块块用户看得见的东西

本目录按**功能**而不是按版式分块：`sessions/SessionSidebar`（会话栏）、`sessions/SessionMenu`（右键弹出的
那个菜单）、`chat/Composer`（输入行）、`chat/CommandPalette`（命令面板）、`output/OutputView`（结果区）、
`output/Welcome` + `output/logo.tsx`（引导屏那块标记的素材）。对外唯一出口 `@/features/index.js`；
组合出口是 `@/app.tsx`。

⚠️ 这些组件**只画**：坐标全部来自 `props.g`，判定全部来自 `@/lib`，着色列全部来自 `@/theme`。
版式的词汇（props 契约、共用字形、`tone`）在 `@/components/index.js`。

## 层不变量

- ⚠️ **组件之间不认识**：feature 之间零 import（`features/index.js` 只是转发），面板高亮与输入行的关系由
  状态层经 `PaletteView` 传进来，而菜单的高亮与那一项作用在谁身上由 `MenuView` 传进来 —— 组件互相找对方。
- ⚠️ **`SessionMenu` 与 `SessionSidebar` 互不认识**：菜单画在侧边栏**之上**，而「谁压在谁上面」靠的是
  `Layout` 里的**顺序**（后画的赢），不是靠这两块互相知道。
- ⚠️ **不得画不属于自己的那一块**：`Composer` 只画输入框内那几行，框与折行由几何层给（`props.g.inputTextRows`）。
- ⚠️ **`logo.tsx` 零 React**（`.tsx` 只是历史遗留的扩展名），⚠️ **艺术字不许用花体字 / 阴影字 / emoji**；
  ⚠️ 它**不是**「只许纯 ASCII」—— 引导屏那块标记刻意用了 `█` 与 box-drawing（理由写在该文件头）。⚠️ 代价不藏：
  那些字形在 East Asian Width = **Ambiguous** 的终端里是两列，整块标记会宽出一倍并折断 —— 缓解是
  「**放不下就不画**」由几何层判。
- ⚠️ **引导屏那块标记的尺寸住在 `logo.tsx`**（`LOGO_ROWS` / `LOGO_WIDTH`），而 `@/lib/geometry.ts` 据此判
  「这一屏放不下就不画」—— 走**深层路径**引它，而补一个 `output/` 自己的 barrel **也去不掉**那条例外
  （`OutputView.js` 引 `@/lib/index.js` ⇒ 成环的理由见 `src/AGENTS.md` 那张表）。
- ⚠️ **子目录自己没有 barrel**（`chat/` `output/` `sessions/` 各只有一层出口），⚠️ 故 `features/index.js`
  转发的是那 **6** 个组件本身，而不是三个子 barrel。

## 相关

`@/app.tsx`（唯一组合方）· `@/components/index.js`（props 契约与共用字形）· `@/lib/index.js`（几何与排版）· `@/theme/index.js`
`tests/layout.test.ts` · `tests/input.test.ts`