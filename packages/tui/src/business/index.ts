/**
 * @fileoverview 资源门面出口：`attachResource` / `Resource` + 四个资源 store
 * @description ⚠️ 目录内部用相对路径，不自我引用本 barrel。资源门面之下的表原语与事务在 `@/service/` 层
 *   编排（校验下沉到 `@/db/dao/`），门面只绑库句柄。
 */

export { attachResource, type Resource } from "@/business/attach.js";
export { MessagesStore } from "@/business/store/messages.js";
export { ModelsStore } from "@/business/store/models.js";
export { ProvidersStore } from "@/business/store/providers.js";
export { SessionsStore } from "@/business/store/sessions.js";
export * from "@/service/index.js";
