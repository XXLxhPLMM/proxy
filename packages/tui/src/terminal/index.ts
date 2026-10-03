/**
 * @fileoverview `src/terminal/` 的**唯一**出口（barrel，只转发）
 * @module terminal/index
 * @description
 * 终端协议层：会**往 stdout 写控制序列**的那一半。{@link ./mouse.ts}（SGR 鼠标上报与解析）与
 * {@link ./screen.ts}（光标显隐与全屏接管）。
 *
 * 为什么要与 `@/ui/index.js`（排版判据、纯函数、零 IO）分开：那两个目录的性质不同到不能放在一处
 * —— 判据能被逐字断言，而这里每一条序列都必须在退出时**成对**撤销，漏一条就留下一个坏掉的终端。
 *
 * 机制与不变量写在两个源文件的头部，barrel 只转发。
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