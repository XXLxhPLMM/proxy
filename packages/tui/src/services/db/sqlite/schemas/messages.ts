import { integer, primaryKey, text } from "drizzle-orm/sqlite-core";
import { MESSAGE_ROLES } from "../../dto/message.js";
import { table } from "./table.js";

export const messages = table(
  "messages",
  {
    /** 所属会话（与 `seq` 一起做主键） */
    sessionId: text().notNull(),

    /** 会话内的顺序号（与 `sessionId` 一起做主键；消息定序靠它） */
    seq: integer().notNull(),

    /** 消息标识（主键是 `(sessionId, seq)`，不是它） */
    id: text().notNull(),
    /** 说话方（`MESSAGE_ROLES` 闭合集） */
    role: text({ enum: MESSAGE_ROLES }).notNull(),

    /** 这条消息关联的模型键；`null` = 无 */
    modelId: text(),
    /** 写入时刻（epoch 毫秒） */
    createdAt: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

export type MessageRow = typeof messages.$inferSelect;
