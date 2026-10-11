import { integer, text } from "drizzle-orm/sqlite-core";
import { table } from "./base/table.js";

/** providers 表：模型提供商（model provider）清单 */
export const providers = table("providers", {
  /** 提供商 id（如 `openai`）；唯一键，用来查询 */
  id: text().primaryKey(),
  /** 显示名称（如 `OpenAI`）；用来查询 */
  name: text().notNull(),
  /** 提供商的 base url（如 `https://api.openai.com/v1`）；用来查询 */
  baseUrl: text().notNull(),
  /** api key；用来查询 */
  key: text().notNull(),
  /** 创建时刻（epoch 毫秒） */
  createdAt: integer().notNull(),
  /** 最后更新时刻（epoch 毫秒） */
  updatedAt: integer().notNull(),
});

/** `providers` 表的行：drizzle 按表结构推断的行类型。 */
export type ProviderRow = typeof providers.$inferSelect;
