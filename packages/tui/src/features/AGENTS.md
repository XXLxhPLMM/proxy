# src/features/ — 一块块用户看得见的东西

本目录按**功能**而不是按版式分块：`sessions/SessionSidebar`（会话栏）、`sessions/SessionMenu`（右键弹出的
那个菜单）、`chat/Composer`（输入行）、`chat/ModelStatusLine`（输入框**框外**那一行「提供商 · 推理强度」）、
`chat/CommandPalette`（命令面板）、`output/OutputView`（结果区）、`output/UserBubble`（**用户消息那一块**）、
`output/Welcome` + `output/logo.tsx`（引导屏那块标记的素材）。对外唯一出口 `@/features/index.js`；
组合出口是 `@/app.tsx`。

⚠️ ⚠️ **历史会话弹窗的内容区不在这里**：它是**七种弹窗内容渲染器之一**，住在
`@/components/layout/window-sessions.tsx`（与那另外四档同壳同槽位序）⇒ 弹窗内容**全部**住在 `layout/`，
而这里只放**屏上那一大片**里的东西。

⚠️ 这些组件**只画**：坐标全部来自 `props.g`，判定全部来自 `@/lib`，着色列全部来自 `@/theme`。
版式的词汇（props 契约、共用字形、`tone`）与**模态卡片的外壳**在 `@/components/index.js`。

## 相关

`@/app.tsx`（唯一组合方）· `@/components/index.js`（props 契约、共用字形与模态卡片外壳 + 槽位序）· `@/lib/index.js`（几何与排版）· `@/theme/index.js`
`tests/layout/` · `tests/render/`（输入行 / 模型状态行 / 用户消息那一块）· `tests/input/`