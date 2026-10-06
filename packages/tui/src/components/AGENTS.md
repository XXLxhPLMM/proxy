# src/components/ — 呈现层的词汇与整屏的框

本目录回答「屏上有哪些块、每块拿什么、拿到的坐标从哪来」：`types.ts`（组件 props 契约，**零组件**）、
`constants.ts`（两个以上块共用的字形 + `tone`）、`layout/`（整屏那三块：侧边栏底色无关的框、页脚、**模态卡片
的外壳 + 槽位序 + 五个内容渲染器与那个按 `kind` 分派的入口** + 右上角那枚 `esc`）、`index.ts`（唯一出口）。
对外出口 `@/components/index.js`；**组合出口是 `@/app.tsx`**。

⚠️ 「会话栏 / 输入行 / 模型状态行 / 结果区 / 命令面板 / 引导屏 / 用户消息那一块」七块住在 `@/features/`
—— 它们是**功能**而不是**版式**。⚠️ 而**七种弹窗的内容渲染器住在 `layout/`**：它们是「同一块卡片外壳 +
同一份槽位序」的**七种填法**，与版式绑得比与功能紧。

## 相关

`@/app.tsx`（唯一上游）· `@/lib/index.js`（几何与排版）· `@/theme/index.js`（色档）· `@/features/index.js`（七块功能）
`tests/layout/`（假 TTY 真渲染，`ModalView` 七档各自压暗整屏）+ `tests/render/`（输入行与用户消息那一块）
+ `tests/geometry/`（九条纯算术 + 层边界那道源码级判据）+ `tests/contract/`（视图契约的形状）