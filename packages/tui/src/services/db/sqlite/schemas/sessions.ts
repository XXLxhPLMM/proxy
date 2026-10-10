import { integer, text } from "drizzle-orm/sqlite-core";
import { table } from "./table.js";

export const sessions = table("sessions", {
  /** 会话 id（主键） */
  id: text().primaryKey(),
  /** 显示标题 */
  title: text().notNull(),

  /** 会话选中的模型键（`provider/model`）；`null` = 还没选 */
  modelId: text(),
  /** 创建时刻（epoch 毫秒） */
  createdAt: integer().notNull(),
  /** 最后更新时刻（epoch 毫秒） */
  updatedAt: integer().notNull(),
});

export type SessionRow = typeof sessions.$inferSelect;
