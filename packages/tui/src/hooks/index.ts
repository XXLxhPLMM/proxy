/** 本目录答「本包的输入订阅挂在哪儿」：键位、鼠标、终端宽高 —— ⚠️ 每个订阅口各只有一处 */

export { useHotkeys } from "./useHotkeys.js";
export { useMouse, type ResizeStart } from "./useMouse.js";
export { useTerminalSize, type TerminalSize } from "./useTerminalSize.js";