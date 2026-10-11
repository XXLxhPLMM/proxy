import { integer, primaryKey, text } from "drizzle-orm/sqlite-core";
import { table } from "./base/table.js";

/** models 表：提供商的模型清单 */
export const models = table(
  "models",
  {
    /** 所属提供商 id（`providers.id` 的外键约束已交由应用层事务兜底） */
    providerId: text().notNull(),
    /** 模型 id（如 `gpt-4o`）；本提供商下唯一，用来查询 */
    id: text().notNull(),
    /** 显示 id（如 `GPT-4o`）；用来查询 */
    displayName: text().notNull(),
    /** 决定调用哪个端点的 sdk 包（如 `openai`）；用来查询 */
    sdk: text().notNull(),
    /** 创建时刻（epoch 毫秒） */
    createdAt: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.id, t.providerId], name: "models_pk" })],
);

/** `models` 表的行：drizzle 按表结构推断的行类型。 */
export type ModelRow = typeof models.$inferSelect;
