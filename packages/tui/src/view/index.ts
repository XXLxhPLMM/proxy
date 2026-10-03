/**
 * @fileoverview `src/view/` 的**唯一**出口（barrel，只转发）
 * @module view/index
 * @description
 * 界面层：**坐标的算术真相**（{@link ./geometry.ts}）与**把坐标画出来**（{@link ./layout.tsx}
 * 那一个组合出口 + {@link ./components/index.ts} 里各画一块的九个组件）。
 *
 * 为什么要 barrel：与 `@/api/index.js` / `@/ledger/index.js` / `@/ui/index.js` /
 * `@/cmd/index.js` 同一条理由（本包是独立子包，目录将来拆分时调用方零改动），代价是多一层转发，
 * 故 **本文件只 `export`，一行逻辑都不许有**。
 *
 * ## 本目录的层不变量
 * @description
 * - **绘制与命中测试读同一个 `geometry()` 结果**：任何组件都一行坐标都不许自己算。
 *   反例的症状是「点输入行定位插入符偏一个字」—— 那意味着画与点各算了一遍。
 * - **零 HTTP、零 `fs`**：本层不认识控制面的任何字段语义（那在 `@/exec/run.js`），只认
 *   「一行字 + 一个颜色」。
 * - **只有一个组合出口**：`Layout` 算几何、各组件只画自己那一块，谁都不许再排一遍版。
 *
 * @module
 */

export {
  BORDER_COLUMNS,
  BORDER_LEFT_COLUMN,
  BORDER_ROWS,
  MAIN_MIN_WIDTH,
  MAIN_TEXT_X,
  MIN_TERMINAL_COLUMNS,
  NOTICE_ROWS,
  PALETTE_MAX_RATIO,
  PROMPT_COLUMNS,
  SESSION_ROWS,
  SIDEBAR_GAP,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_TEXT_X,
  SIDEBAR_WIDTH,
  STATUS_LINE_HEIGHT,
  WINDOW_CLOSE_COLUMNS,
  caretFromColumn,
  caretFromWrappedPoint,
  caretRowOf,
  geometry,
  hitTest,
  sidebarWidthBounds,
  wrapInput,
  type Geometry,
  type GeometryInput,
  type Rect,
  type WrappedRow,
} from "./geometry.js";
export { Layout } from "./layout.js";
export type {
  LayoutProps,
  PaletteRowView,
  PaletteView,
  SessionRow,
  WindowRow,
  WindowView,
} from "./components/index.js";