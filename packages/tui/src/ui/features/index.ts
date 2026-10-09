/** `@/features` 的**唯一**出口（⚠️ 只有**这一层**：`chat/` `output/` `sessions/` 自己都没有 barrel，
 *  而补一个也去不掉那条深层路径例外 —— `OutputView.js` 引 `@/lib/index.js`，见 `src/AGENTS.md` 那张表） */

export { Composer } from "./chat/Composer.js";
export { ModelStatusLine } from "./chat/ModelStatusLine.js";
export { CommandPalette } from "./chat/CommandPalette.js";
export { OutputView } from "./output/OutputView.js";
export { UserBubble } from "./output/UserBubble.js";
export { Welcome } from "./output/Welcome.js";
export { SessionMenu } from "./sessions/SessionMenu.js";
export { SessionSidebar } from "./sessions/SessionSidebar.js";