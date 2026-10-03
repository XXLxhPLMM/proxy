/**
 * @fileoverview `src/view/components/` 的**唯一**出口（barrel，只转发）
 * @module view/components/index
 * @description
 * 九个组件各画一屏里的一块，而**没有一块知道别的块**。⚠️ 组合出口是 {@link ../layout.tsx:Layout}：
 * 它算一次几何再派发，故每个组件拿到的坐标与鼠标命中测试读的是**同一份**。
 * @module
 */

export { CloseChip } from "./close-chip.js";
export { InputBlock } from "./input-block.js";
export { Output } from "./output.js";
export { Palette } from "./palette.js";
export { Sidebar } from "./sidebar.js";
export { StatusLine } from "./status-line.js";
export { Welcome } from "./welcome.js";
export { Window } from "./window.js";
export type {
  LayoutProps,
  PaletteRowView,
  PaletteView,
  SessionRow,
  WindowRow,
  WindowView,
} from "./types.js";