import { integer, text } from "drizzle-orm/sqlite-core";
import { table } from "./table.js";

export const sessions = table("sessions", {
  id: text().primaryKey(),
  title: text().notNull(),

  modelId: text(),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
});

export type SessionRow = typeof sessions.$inferSelect;
