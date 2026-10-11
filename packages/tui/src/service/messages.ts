/**
 * @fileoverview 消息资源的**业务操作原语**：对 `@/db/dao/messages` 作校验后调用；
 * 追加/删除在事务中编排，事务内的原子行操作交给 DAO；出入参走 DTO（`@/db/dto/`）。
 * @module service/messages
 * @description 写面判据复用读面那一套（`partFromRow` / `assertRoleParts` / `assertModelId`）：写不进一条「读出来会被拒」的行。
 * ⚠️ 只给 `business/store/messages.js`（门面）用：跨目录取本地库走 `ctx.business.messages`，别直接 import 本文件。
 */

import { eq } from "drizzle-orm";
import type { ModelId } from "@/lib/model-id.js";
import type { Db } from "@/db/dialect.js";
import { MESSAGE_ROLES } from "@/db/dto/index.js";
import type { Message, MessagePart, MessageRole } from "@/db/dto/index.js";
import {
  assertModelId,
  assertRoleParts,
  badContentError,
  partFromRow,
} from "@/db/read.js";
import { dao } from "@/db/index.js";
import { sessions, type MessageRow } from "@/db/sqlite/schemas/index.js";

/** 追加一条消息的入参；`seq` 由本层现算（同一会话内 `nextMessageSeq + 1`），不劳动调用方 */
export interface NewMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: MessageRole;
  readonly modelId: ModelId | null;
  readonly parts: readonly MessagePart[];
  /** 写入时刻（epoch 毫秒）；同时把所属会话的 `updatedAt` 推到这一刻（这条消息就是那次更新） */
  readonly createdAt: number;
}

/** 一行 → 一个 `Message`（`parts` 由调用方按 `seq` 归好组）；`id` 空串、`seq` / `createdAt` 不是整数、`role` / `modelId` 表外即抛 */
function messageFromRow(row: MessageRow, parts: readonly MessagePart[], where: string): Message {
  if (row.id === "") throw badContentError(where, "id");
  if (!Number.isInteger(row.seq)) throw badContentError(where, "seq");
  if (!Number.isInteger(row.createdAt)) throw badContentError(where, "created_at");
  if (!MESSAGE_ROLES.includes(row.role)) throw badContentError(where, "role");
  assertModelId(row.modelId, where);
  assertRoleParts(row.role, parts, where);
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    role: row.role,
    modelId: row.modelId,
    parts,
    createdAt: row.createdAt,
  };
}

/**
 * 追加一条消息：消息行 + 各段行 + 所属会话的 `updatedAt`，同一个事务
 * @description `seq` 在事务内现算，同一会话里恒为当前最大 `seq + 1`。
 * 会话不在库里即抛：`messages.session_id` 在 DDL 里没有外键，这层的存在性检查就是它的替代。
 */
export function appendMessage(db: Db, draft: NewMessage): Message {
  const where = `新消息 ${draft.id}`;
  if (draft.id === "") throw badContentError(where, "id");
  assertModelId(draft.modelId, where);
  assertRoleParts(draft.role, draft.parts, where);

  return db.transaction((tx) => {
    const session = tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, draft.sessionId)).get();
    if (session === undefined) {
      throw new Error(`会话 ${draft.sessionId} 不在库里，消息追加不了`);
    }

    const seq = dao.messages.nextMessageSeq(tx, draft.sessionId);

    dao.messages.insertMessageRow(tx, draft.sessionId, seq, draft.id, draft.role, draft.modelId, draft.createdAt);
    draft.parts.forEach((part) => {
      dao.messages.insertMessagePartRows(tx, draft.sessionId, seq, [part]);
    });
    // 会话清单按 updatedAt 排序：不跟上这一刻的话，顺序就停在过去
    dao.sessions.updateSessionUpdatedAtRow(tx, draft.sessionId, draft.createdAt);

    return {
      id: draft.id,
      sessionId: draft.sessionId,
      seq,
      role: draft.role,
      modelId: draft.modelId,
      parts: draft.parts,
      createdAt: draft.createdAt,
    };
  });
}

/** 一个会话的全部消息：消息按 `seq` 升序，每条的段按 `idx` 升序附上 */
export function listMessages(db: Db, sessionId: string): readonly Message[] {
  const rows = dao.messages.listMessageRows(db, sessionId);
  const partRows = dao.messages.listMessagePartRows(db, sessionId);

  const bySeq = new Map<number, MessagePart[]>();
  for (const row of partRows) {
    const where = `会话 ${sessionId} 的消息 ${row.seq} 第 ${row.idx} 段`;
    if (!Number.isInteger(row.seq) || !Number.isInteger(row.idx)) {
      throw badContentError(where, "seq / idx");
    }
    const part = partFromRow(row, where);
    const list = bySeq.get(row.seq);
    if (list === undefined) bySeq.set(row.seq, [part]);
    else list.push(part);
  }

  return rows.map((row) =>
    messageFromRow(row, bySeq.get(row.seq) ?? [], `会话 ${sessionId} 的消息 ${row.seq}`),
  );
}
