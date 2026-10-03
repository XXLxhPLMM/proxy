/** `@/view/components` 的唯一出口：九个各画一块、彼此不知情的组件（组合出口是 `@/view/layout.js`） */

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