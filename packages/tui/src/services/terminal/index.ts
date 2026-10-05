/** `@/services/terminal` 的唯一出口：会往 stdout 写控制序列的那一半（SGR 鼠标上报）+ 收尾的合成 */

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
export { chainRestores, type ScreenRestore } from "./screen.js";