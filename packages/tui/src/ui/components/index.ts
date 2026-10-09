/** `@/components` 的唯一出口：呈现层的词汇（组件 props 契约 + 跨组件共用的字形与 `tone`）与整屏的框（`layout/`） */

export {
  ECHO_PREFIX,
  MARK_BLANK,
  MARK_SELECTED,
  PROMPT,
  tone,
} from "./constants.js";
export { CloseChip } from "./layout/close-chip.js";
export { Footer } from "./layout/footer.js";
export { SlotLine, WindowCard, type WindowCardProps } from "./layout/window-card.js";
export { slotsOf } from "./layout/window-slots.js";
export { Window } from "./layout/window.js";
export type {
  FieldCell,
  InputSelection,
  LayoutProps,
  ListRow,
  MenuView,
  ModelCheckRow,
  ModelListRow,
  ModelStatusView,
  ModalView,
  PaletteRowView,
  PaletteView,
  RegionProps,
  RenameField,
  SessionListRow,
  SessionRow,
} from "./types.js";
