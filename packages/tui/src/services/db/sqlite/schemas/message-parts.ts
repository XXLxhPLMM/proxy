import { integer, primaryKey, text } from "drizzle-orm/sqlite-core";
import { MESSAGE_PART_KINDS } from "../../dto/message.js";
import { table } from "./table.js";

export const messageParts = table(
  "message_parts",
  {
    sessionId: text().notNull(),
    seq: integer().notNull(),

    idx: integer().notNull(),
    kind: text({ enum: MESSAGE_PART_KINDS }).notNull(),

    text: text(),

    toolCallId: text(),

    toolName: text(),

    payload: text({ mode: "json" }).$type<unknown>(),

    isError: integer(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq, t.idx] })],
);

export type MessagePartRow = typeof messageParts.$inferSelect;
