/**
 * @fileoverview `src/ui/` 的**唯一**出口（barrel，只转发）
 * @module ui/index
 * @description
 * 本目录现在只有**四个纯函数模块 + 一个素材模块**，**零 Ink 组件**：
 * - `theme.ts` / `format.ts` / `columns.ts` — 颜色、排版与列宽的全部判据；
 * - `mouse.ts` / `screen.ts` — 全屏接管与鼠标协议（终端**设施**，不是呈现）；
 * - `logo.ts` — 两串常量。
 *
 * ⚠️ **呈现全部在 `@/console/layout.tsx`**，而它**只**从本目录取「怎么排、怎么上色」的判据，
 * 自己画每一个 `<Box>`。理由是布局必须与 `@/console/geometry.ts` 的算术**逐字一致**
 * （画在哪 = 点在哪），而一个「自己算宽度、自己算边框」的组件库正是那种不一致的产地 ——
 * 本包真的为此删掉过一整套组件（`Frame` / `TabBar` / `DataTable` / `Field` / `Toast` / …）。
 *
 * 为什么要 barrel：与 `@/client/index.js` / `@/ledger/index.js` 同一条理由（本包是独立子包，
 * 目录将来拆分时调用方零改动），代价是多一层转发，故 **本文件只转发、不含任何逻辑、
 * 不重新导出任何内部实现**。
 *
 * ## 层不变量（细则见各零件的文件头）
 * @description
 * - **零 `console`、零 `process.*`**：终端宽高 / 是否上色 / 版本号全部由组合根 `src/cli.tsx`
 *   采集后当参数传下来。`process.*` 是**组合根**的采集面，叶子模块自己摸等于把「这份快照
 *   从哪来」从一处拆成 N 处。
 * - **纯函数模块不 import React**：`theme` / `format` / `columns` / `logo` 是排版与着色的判据，
 *   它们能被单测逐字断言正因如此。⚠️ 呈现（画）住在 `@/console/layout.tsx`，那是**本包唯一**
 *   挂 Ink 的地方 —— 于是「哪一层能起 React」这件事在目录形状上就是看得见的。
 * - **「探活结果 → 呈现档」只有一个换算口**：`connectionStateOf`（`ProbeSlot | undefined` →
 *   `ConnectionState`）。侧边栏是它唯一的读者，而一个 id 一个值 ⇒ 结构上不可能对它说两个词。
 * - **打码只有一个出口**：`maskToken`（**固定长度**，不透露长度 —— 长度是可二分的信号）。
 *   ⚠️ 本目录**不许**再判「哪些键是秘密」，那是服务端 `CONFIG_SECRET_KEYS` 一份清单的读者。
 * - **度量一律 `string-width`**：本目录没有一处用 `String.length` 做宽度判断。
 * - **非法输入抛，不装**：`bytes` / `duration` / `percent` 对负数与非有限数抛 `RangeError`。
 * - **显示层不做换算**：`isoOrNull` 原样透传服务端给的带偏移 ISO 串。
 * - **空形态收敛成一个**：至少 `dash(null | undefined) === "—"`。⚠️ **空串保持空串**。
 *   「没值」与「不限流」也各有**唯一**写法：`—` 与 `∞`（`0` 字节是「不限流」，不是除零）。
 *
 * @module
 */

/* ── 三个纯函数模块（本包排版与着色的全部判据）──────────────────────────── */

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
  type Tone,
} from "./theme.js";
export { BANNER, TAGLINE } from "./logo.js";

/* ── 终端设施（全屏接管与鼠标；机制与不变量见 mouse.ts / screen.ts 的文件头）── */

export {
  MOUSE_QUIET_MS,
  MOUSE_REPORTING_OFF,
  MOUSE_REPORTING_ON,
  MOUSE_UNSUPPORTED_HINT,
  createMouseSource,
  disableMouseReporting,
  enableMouseReporting,
  isMouseReport,
  mouseSupportOf,
  mouseUnsupportedHintOf,
  parseSgr,
  type MouseAction,
  type MouseButton,
  type MouseEvent,
  type MouseLiveness,
  type MouseSource,
  type MouseSourceOptions,
  type MouseStdin,
  type MouseSupport,
  type ParsedSgr,
  type TerminalOut,
} from "./mouse.js";
export {
  CURSOR_HIDE,
  CURSOR_SHOW,
  ENTER_SEQUENCE,
  EXIT_SEQUENCE,
  chainRestores,
  enterFullScreen,
  type ScreenRestore,
} from "./screen.js";