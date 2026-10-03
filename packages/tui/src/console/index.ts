/**
 * @fileoverview `src/console/` 的**唯一**出口（barrel，只转发）
 * @module console/index
 * @description
 * 目录内三个零件各答一件事：{@link ./geometry.ts} 是**屏幕几何与命中测试**的算术真相，
 * {@link ./log.ts} 是**结果区的条目模型与摊平**，{@link ./exec.ts} 是**命令执行层**
 * （一条命令 → 若干行 + 一组副作用）。本文件是它们对外的全部承诺。
 *
 * 为什么要 barrel：与 `@/client/index.js` / `@/ledger/index.js` / `@/ui/index.js` /
 * `@/cmd/index.js` 同一条理由（本包是独立子包，目录将来拆分时调用方零改动），代价是多一层转发，
 * 故 **本文件只 `export`，一行逻辑都不许有**。
 *
 * ## 本目录的层不变量
 * @description
 * - **零 Ink、零 React**：`exec.ts` 与 `log.ts` 是纯数据层 —— 挂上 React 之后它们就不再能在一台
 *   没有终端的机器上单测，而「`changed: false` 不是失败」这种一句话的规则恰好需要被逐字断言。
 *   呈现（怎么画一行、怎么上色、怎么滚）是**另一层**的事。
 * - **执行层不碰状态**：`exec.ts` 只发请求、只读注入进来的东西，然后**说**发生了什么
 *   （`Effect`）。它一旦 `setState`，它的判据就都要起一个真的界面才能验。
 * - **命令表只有一份**（`@/cmd/index.js:parse.ts` 的那张表），本目录**只读它**不抄第二份。
 * - **逐字限定不许改写**：`runningMeans` / `notice` / `effective` / `sideEffect` / `note` /
 *   `TuiError.message` 全部原样上屏 —— 措辞是**服务端**的知识，本层改写等于宣称「我知道这是什么」。
 * - **凭据不��任何一行**：`user pass` / `user set … password` / `target add` 的密码与 token 只以
 *   掩码形态出现在回显行（`log.ts:maskEcho` 是全包唯一的掩码出口）。
 * - 本目录内部一律用**相对路径**互引，**禁止自我引用**（`exec.ts` 不引 `./index.js`）——
 *   那会把 barrel 与它的兄弟模块放进同一个循环依赖图。
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
} from "./log.js";
export {
  exec,
  type Effect,
  type ExecDeps,
  type ExecResult,
  type LedgerWrite,
  type TargetAddRequest,
} from "./exec.js";
export {
  Layout,
  type LayoutProps,
  type PaletteRowView,
  type PaletteView,
  type SessionRow,
  type WindowRow,
  type WindowView,
} from "./layout.js";
