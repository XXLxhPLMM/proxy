/**
 * @fileoverview 本地库资源层的出口：门面 `SessionStore` + 入参类型（`ops/` 是门面的实现细节，不外转）
 * @module services/resource
 * @description ⚠️ 目录内部用相对路径，不自我引用本 barrel。
 */

export { SessionStore } from "./store.js";

export type { NewMessage } from "./ops/messages.js";
export type { NewSession, SessionPatch } from "./ops/sessions.js";
