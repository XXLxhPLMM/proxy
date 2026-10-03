/**
 * @fileoverview `src/terminal/` 的**唯一出口**（barrel，只转发）
 * @module terminal/index
 * @description
 * 终端协议层：会**往 stdout 写控制序列**的那一半（`mouse.ts` / `screen.ts`）。⚠️ 与 `@/view/geometry.ts` 分开
 * 是因为性质不同：判据能被逐字断言，而这里每一条序列都必须在退出时**成对**撤销，漏一条就留下一个坏掉的终端。
 * 命中测试也在 `geometry.ts` 那一侧，本目录只管协议。
 *
 * @module
 */

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