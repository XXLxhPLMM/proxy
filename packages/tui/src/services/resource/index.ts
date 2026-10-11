/**
 * @fileoverview 本地资源层的出口：组装点 `attachResource` + `store/` 里的四个门面（`ops/` 是实现原语，不外转）；
 * 入参/出参形状即 `providers.$inferSelect` / `models.$inferSelect`，由门面方法的签名直接暴露。
 * @module services/resource
 * @description ⚠️ 目录内部用相对路径，不自我引用本 barrel。
 */

export { attachResource, type Resource } from "./attach.js";
export { MessagesStore } from "./store/messages.js";
export { ModelsStore } from "./store/models.js";
export { ProvidersStore } from "./store/providers.js";
export { SessionsStore } from "./store/sessions.js";

export type { NewMessage } from "./ops/messages.js";
export type { NewSession, SessionPatch } from "./ops/sessions.js";
export type { Model, NewModel } from "@/services/db/dto/index.js";
export type { NewProvider, Provider, ProviderPatch } from "@/services/db/dto/index.js";
