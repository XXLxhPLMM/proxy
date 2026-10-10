import { integer, primaryKey, text } from "drizzle-orm/sqlite-core";
import { MESSAGE_ROLES } from "../../dto/message.js";
import { table } from "./table.js";

export const messages = table(
  "messages",
  {
    sessionId: text().notNull(),

    seq: integer().notNull(),

    id: text().notNull(),
    role: text({ enum: MESSAGE_ROLES }).notNull(),

    modelId: text(),
    createdAt: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

export type MessageRow = typeof messages.$inferSelect;
