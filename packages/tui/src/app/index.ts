/**
 * @fileoverview `src/app/` 的唯一出口（barrel，只转发）
 */

export { App, type AppProps } from "./app.js";
export { useTerminalSize, type TerminalSize } from "./use-terminal-size.js";
export { FALLBACK_ROWS } from "./state.js";
export {
  caretLeft,
  caretRight,
  deleteAt,
  deleteBefore,
  insertAt,
  printableOnly,
} from "./input-line.js";
