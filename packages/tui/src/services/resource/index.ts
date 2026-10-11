/**
 * @fileoverview 本地资源层的出口：组装点 `attachResource` + `store/` 里的会话 / 消息门面与入参类型（`ops/` 是实现原语，不外转）
 * @module services/resource
 * @description ⚠️ 目录内部用相对路径，不自我引用本 barrel。
 */

export { attachResource, type Resource } from "./attach.js";
export { MessagesStore } from "./store/messages.js";
export { SessionsStore } from "./store/sessions.js";

export type { NewMessage } from "./ops/messages.js";
export type { NewSession, SessionPatch } from "./ops/sessions.js";
