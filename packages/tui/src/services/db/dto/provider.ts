import type { ProviderRow } from "@/services/db/sqlite/schemas/index.js";

/**
 * `providers` 表的行：`id` / `name` / `baseUrl` / `key` / `createdAt` / `updatedAt`。
 * 这是基于表结构的「基类型」（drizzle 按表结构推断），不是手写契约。
 */
export type Provider = ProviderRow;

/**
 * 建一个提供商的草稿：除 `updatedAt` 外全字段；`updatedAt` 由写入层从 `createdAt` 填充，
 * 不劳动调用方填两遍。
 */
export type NewProvider = Omit<Provider, "updatedAt">;

/**
 * 改一个提供商的入参：`name` / `baseUrl` / `key` 可缺省（不动那一格），`updatedAt`
 * 由调用方给。
 */
export type ProviderPatch = Pick<Partial<Provider>, "name" | "baseUrl" | "key"> & {
  updatedAt: number;
};
