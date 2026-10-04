/** 行模型：一组条目 → 一组行（barrel，只转发；零 Ink、零 React、零终端、零 HTTP、零 `fs`） */
export {
  append,
  clampTop,
  dropped,
  flatten,
  maskEcho,
  trim,
  visibleLines,
  type FlatLog,
  type LogEntry,
  type LogLine,
  type LogRow,
  type LogTone,
} from "./rows.js";