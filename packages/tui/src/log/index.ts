/**
 * @fileoverview `src/log/` 的**唯一**出口（barrel，只转发）
 * @module log/index
 * @description
 * 行模型：**一组条目 → 一组行**（{@link ./rows.ts}）。零 Ink、零 React、零终端、零 HTTP、零 `fs`，
 * 于是它能在一台没有终端的机器上被逐字断言。
 *
 * 呈现（怎么画一行、怎么上色）在 `@/view/layout.js`，坐标在 `@/view/geometry.js`。
 *
 * @module
 */

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