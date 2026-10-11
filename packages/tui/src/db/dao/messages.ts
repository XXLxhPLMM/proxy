/**
 * @fileoverview `messages` + `message_parts` 两张表的**原子**行操作（CRUD）：每一句只做一件事，不含事务、跨表或校验。
 * @module db/dao/messages
 * @description 校验下沉到 `service/`（`partFromRow` / `assertRoleParts` / `assertModelId`），DAO 层只负责行 ↔ 表。
 */

import type { Db } from "@/db/dialect.js";
import type { MessagePart, MessageRole } from "@/db/dto/message.js";
import { asc, eq, max } from "drizzle-orm";
import { messageParts, messages, type MessagePartRow, type MessageRow } from "@/db/sqlite/schemas/index.js";

/** 建一条消息的行（不含段；不含会话 `updatedAt` 推进） */
export function insertMessageRow(
  db: Db,
  sessionId: string,
  seq: number,
  id: string,
  role: MessageRole,
  modelId: string | null,
  createdAt: number,
): void {
  db.insert(messages).values({ sessionId, seq, id, role, modelId, createdAt }).run();
}

/** 追加一个段到消息的行集合；段载荷按各类型规则落 `null`（JSON 表示不了 `undefined`） */
export function insertMessagePartRows(db: Db, sessionId: string, seq: number, parts: readonly MessagePart[]): void {
  for (const [idx, part] of parts.entries()) {
    db.insert(messageParts).values({
      sessionId,
      seq,
      idx,
      kind: part.type,
      text: part.type === "text" || part.type === "reasoning" ? part.text : null,
      toolCallId: part.type === "tool-call" || part.type === "tool-result" ? part.toolCallId : null,
      toolName: part.type === "tool-call" || part.type === "tool-result" ? part.toolName : null,
      payload: part.type === "tool-call" ? (part.input ?? null) : part.type === "tool-result" ? (part.output ?? null) : null,
      isError: part.type === "tool-result" ? (part.isError ? 1 : 0) : null,
    }).run();
  }
}

/** 按会话取全部消息行（按 `seq` 升序） */
export function listMessageRows(db: Db, sessionId: string): readonly MessageRow[] {
  return db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.seq)).all();
}

/** 按会话取全部段行（按 `seq` / `idx` 升序） */
export function listMessagePartRows(db: Db, sessionId: string): readonly MessagePartRow[] {
  return db
    .select()
    .from(messageParts)
    .where(eq(messageParts.sessionId, sessionId))
    .orderBy(asc(messageParts.seq), asc(messageParts.idx))
    .all();
}

/** 下一个可用的 `seq`（当前最大 + 1；空会话给 `0`） */
export function nextMessageSeq(db: Db, sessionId: string): number {
  const top = db.select({ seq: max(messages.seq) }).from(messages).where(eq(messages.sessionId, sessionId)).get();
  return (top?.seq ?? -1) + 1;
}

/** 删某个会话下的全部段行与消息行（不删会话本身；供事务中的级联删除使用） */
export function deleteMessageRows(db: Db, sessionId: string): void {
  db.delete(messageParts).where(eq(messageParts.sessionId, sessionId)).run();
  db.delete(messages).where(eq(messages.sessionId, sessionId)).run();
}
