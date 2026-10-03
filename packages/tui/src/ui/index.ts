/** `@/ui` 的唯一出口：排版与着色的判据（`theme` / `format` / `columns`）与引导屏那块标记的素材（`logo`） */
export {
  COLUMN_GAP,
  DEFAULT_MIN,
  planColumns,
  type CellValue,
  type ColumnPlan,
  type ColumnSpec,
  type ColumnWidth,
  type PlanRow,
  type PlannedColumn,
} from "./columns.js";
export {
  dash,
  bytes,
  duration,
  ellipsis,
  isoOrNull,
  maskToken,
  onOff,
  padToWidth,
  percent,
  uptime,
  widthOf,
  EM_DASH,
  MASKED,
  UNLIMITED,
  type Align,
} from "./format.js";
export {
  connectionMark,
  connectionStateOf,
  themeOf,
  toneColor,
  type ConnectionMark,
  type ConnectionState,
  type ProbeSlot,
  type Theme,
  type ThemeOptions,
  type Tone,
} from "./theme.js";
export { LOGO, LOGO_ROWS, LOGO_TAG, LOGO_WIDTH, type LogoLine } from "./logo.js";
