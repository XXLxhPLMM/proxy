/** `@/lib` 的唯一出口：零 IO 的那一半（排版、行模型、输入串、失败词汇） */

export {
  LOCAL_REQUEST,
  TuiError,
  isRetryable,
  type FailureKind,
  type LocalCode,
  type TuiCode,
} from "./request/errors.js";
export { endpointPath, normalizeBaseUrl } from "./request/http.js";
export type { ManagerTarget, Method, RequestSpec, Response } from "./request/transport.js";
export {
  EM_DASH,
  MASKED,
  UNLIMITED,
  bytes,
  dash,
  dayGroupLabel,
  duration,
  ellipsis,
  fitTo,
  isoOrNull,
  maskToken,
  onOff,
  padToWidth,
  percent,
  uptime,
  widthOf,
  type Align,
} from "./format.js";
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
  caretAtFirstRow,
  caretAtLastRow,
  caretDown,
  caretRowOf,
  caretUp,
  deleteSelection,
  historyNext,
  historyPrev,
  insertNewline,
  normalizeSelection,
  pushHistory,
  replaceSelection,
  wrapInput,
  type HistoryStep,
  type Selection,
  type WrappedRow,
} from "./editor.js";
export {
  caretLeft,
  caretRight,
  deleteAt,
  deleteBefore,
  insertAt,
  isControlChar,
  printableOnly,
} from "./input-line.js";
export { describe, droppedHint, idOfName, readLedgerSafe, rowsOfFailure } from "./failures.js";
export {
  append,
  clampTop,
  dropped,
  flatten,
  maskEcho,
  rowsOfTurn,
  trim,
  visibleLines,
  type FlatLog,
  type LogEntry,
  type LogLine,
  type LogRow,
  type LogTone,
  type Turn,
} from "./log/index.js";