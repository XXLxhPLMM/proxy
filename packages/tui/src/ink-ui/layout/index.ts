/**
 * @fileoverview 布局层的对外出口：只转出 `SplitLayout` 与它的 props 类型
 * @module ink-ui/layout
 * @description
 * 视图层要用分栏，只认这一个入口：`@/ink-ui/layout/index.js`。
 *
 * ⚠️ **`split-layout.tsx` 里的纯数学不往外转**（`clamp`）：要在外面复算列数，说明那份状态该由父层
 * 自己拿 —— 用 `onLeftWidthChange` 收值，别复制一套公式。
 */

export { SplitLayout } from "./split-layout.js";
export type { SplitLayoutProps } from "./split-layout.js";
