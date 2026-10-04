/** `@/features` 的唯一出口：一块块「用户看得见的会话 / 输入 / 输出」；⚠️ 每个 feature 目录对外只暴露这一个出口 */

export { Composer } from "./chat/Composer.js";
export { CommandPalette } from "./chat/CommandPalette.js";
export { OutputView } from "./output/OutputView.js";
export { Welcome } from "./output/Welcome.js";
export { SessionSidebar } from "./sessions/SessionSidebar.js";