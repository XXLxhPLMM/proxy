/**
 * @fileoverview 业务服务层出口：会话 / 消息 / 提供商 / 模型各一个服务类（挂载于 `ctx.services.*`），
 *   另导出 `NewMessage` 消息追加入参
 * @module service
 * @description 四个类都收 `ctx`（行操作目录在 `ctx.dao`、库句柄在 `ctx.db`），**不 import DAO**。
 */

export { SessionsService } from "./sessions.js";
export { MessagesService } from "./messages.js";
export { ProvidersService } from "./providers.js";
export { ModelsService } from "./models.js";
export type { NewMessage } from "./messages.js";
