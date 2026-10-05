/** `@/services/model` 的唯一出口：模型 provider 那一侧的拨号点（⚠️ **刻意不在** `@/services/index.js` 里） */

export { HISTORY_LIMIT, commandOfReply, messagesOf } from "./dialogue.js";
export { askModel, listProviderModels } from "./dispatch.js";
export {
  ModelError,
  type ChatMessage,
  type DialectInput,
  type FetchLike,
  type ModelDialect,
  type ModelListing,
  type ModelReply,
} from "./types.js";