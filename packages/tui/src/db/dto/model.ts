import type { ModelRow } from "@/db/sqlite/schemas/index.js";

/**
 * `models` 表的行：`providerId` / `id` / `displayName` / `sdk` / `createdAt`。
 * 这是基于表结构的「基类型」（drizzle 按表结构推断），不是手写契约。
 */
export type Model = ModelRow;

/**
 * 建一个模型的草稿：模型本身的内容部分；`createdAt` 由调用方给（本层不读时钟），
 * 补回后写入，不劳动调用方填两遍。
 */
export type NewModel = Omit<Model, "createdAt">;
