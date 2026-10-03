/**
 * @fileoverview `src/app/` 的**唯一**出口（barrel，只转发）
 * @module app/index
 * @description
 * 与 `@/api/index.js` / `@/view/index.js` 同一条纪律：目录将来再拆时调用方零改动，故**本文件只
 * `export`，一行逻辑都不许有**。⚠️ 导出面**与拆分前的 `src/app.tsx` 逐字相同**。
 *
 * @module
 */

export { App, type AppProps } from "./app.js";
export { FALLBACK_ROWS } from "./state.js";
export {
  caretLeft,
  caretRight,
  deleteAt,
  deleteBefore,
  insertAt,
  printableOnly,
} from "./input-line.js";
