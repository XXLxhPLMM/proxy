import { integer, primaryKey, text } from "drizzle-orm/sqlite-core";
import { MESSAGE_PART_KINDS } from "../../dto/message.js";
import { table } from "./table.js";

export const messageParts = table(
  "message_parts",
  {
    /** 所属会话；与 `seq` 一起指向 `messages` 的一行 */
    sessionId: text().notNull(),
    /** 所属消息的顺序号（同 `messages.seq`） */
    seq: integer().notNull(),

    /** 同一条消息内第几段（对应 `Message.parts` 的下标） */
    idx: integer().notNull(),
    /** 段的类型（`MESSAGE_PART_KINDS` 闭合集） */
    kind: text({ enum: MESSAGE_PART_KINDS }).notNull(),

    /** text / reasoning 段的正文 */
    text: text(),

    /** 工具调用的关联 id（tool-call / tool-result 段用） */
    toolCallId: text(),

    /** 工具名（tool-call / tool-result 段用） */
    toolName: text(),

    /** 工具入参 / 结果的原样 JSON（JSON 列） */
    payload: text({ mode: "json" }).$type<unknown>(),

    /** 工具结果是否失败：`0` / `1`（sqlite 无布尔） */
    isError: integer(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq, t.idx] })],
);

export type MessagePartRow = typeof messageParts.$inferSelect;
