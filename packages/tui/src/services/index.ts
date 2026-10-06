/** 本目录答「本机的那些事」：台账（`config/`，一份 SQLite 库）、宿主的告警（`warnings.ts`）、终端协议（`terminal/`）；
 *  ⚠️ **控制面的拨号不在这里** —— 它住在 `@/api`（端点函数自己 axios，见那个目录的 `AGENTS.md`） */

export { installSqliteWarningFilter } from "./warnings.js";
