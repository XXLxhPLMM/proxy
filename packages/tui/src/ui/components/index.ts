/** `@/ui/components` 的唯一出口：呈现层的词汇（组件 props 契约 + 跨组件共用的字形与 `tone`）与整屏的框（`layout/`） */

export {
  ECHO_PREFIX,
  MAIN_TEXT_X,
  MARK_BLANK,
  MARK_SELECTED,
  MENU_PAD_X,
  PROMPT,
  PROMPT_COLUMNS,
  SESSION_CLOSE_COLUMNS,
  SESSION_GAP_ROWS,
  SESSION_MARK_COLUMNS,
  SIDEBAR_CLOSE_MIN_NAME,
  SIDEBAR_TEXT_X,
  SIDEBAR_TOP_PAD_ROWS,
  WINDOW_FULL_WIDTH_BELOW,
  WINDOW_MIN_WIDTH,
  WINDOW_WIDTH_RATIO,
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
  WindowSlot,
} from "./types.js";
