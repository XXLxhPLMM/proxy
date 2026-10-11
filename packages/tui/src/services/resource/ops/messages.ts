/**
 * @fileoverview 消息资源的操作**原语**：`messages` + `message_parts` 两张表的读写，出参恒为本包 DTO 的 `Message`
 * @module services/resource/ops/messages
 * @description 库句柄走函数参数；时刻由调用方给，本层不读时钟。
 * ⚠️ 写面判据复用读面那一套（`partFromRow` / `assertRoleParts` / `assertModelId`）：写不进一条「读出来会被拒」的行。
 * ⚠️ 只给 `../store/messages.js`（门面）用：跨目录取本地库走 `ctx.resource.messages`，别直接 import 本文件。
 */

import { asc, eq, max } from "drizzle-orm";
import type { ModelId } from "@/lib/model-id.js";
import type { Db } from "@/services/db/dialect.js";
import {
  MESSAGE_ROLES,
  type Message,
  type MessagePart,
  type MessageRole,
} from "@/services/db/dto/index.js";
import {
  assertModelId,
  assertRoleParts,
  badContentError,
  partFromRow,
} from "@/services/db/read.js";
import {
  messageParts,
  messages,
  sessions,
  type MessageRow,
} from "@/services/db/sqlite/schemas/index.js";

/** 追加一条消息的入参；`seq` 由本层现算（同一会话内 `max(seq) + 1`），不劳动调用方 */
export interface NewMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: MessageRole;
  readonly modelId: ModelId | null;
  readonly parts: readonly MessagePart[];
  /** 写入时刻（epoch 毫秒）；同时把所属会话的 `updatedAt` 推到这一刻（这条消息就是那次更新） */
  readonly createdAt: number;
}

/**
 * 一个段 → `message_parts` 的列值
 * @description ⚠️ 组装完过一遍 {@link partFromRow}：判据不另抄一份，写面与读面因此**由构造保证**同一个形状。
 * `undefined` 载荷落成 `null`（JSON 表示不了 `undefined`）。
 */
function partValues(sessionId: string, seq: number, idx: number, part: MessagePart) {
  const values = {
    sessionId,
    seq,
    idx,
    kind: part.type,
    text: part.type === "text" || part.type === "reasoning" ? part.text : null,
    toolCallId: part.type === "tool-call" || part.type === "tool-result" ? part.toolCallId : null,
    toolName: part.type === "tool-call" || part.type === "tool-result" ? part.toolName : null,
    payload:
      part.type === "tool-call" ? (part.input ?? null)
      : part.type === "tool-result" ? (part.output ?? null)
      : null,
    isError: part.type === "tool-result" ? (part.isError ? 1 : 0) : null,
  };
  partFromRow(values, `会话 ${sessionId} 的消息 ${seq} 第 ${idx} 段`);
  return values;
}

/** 一行 → 一个 `Message`（`parts` 由调用方按 `seq` 归好组）；`id` 空串、`seq` / `createdAt` 不是整数、`role` / `model_id` 表外即抛 */
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
 * @description `seq` 在事务内现算，同一会话里恒为 `max(seq) + 1`。
 * 会话不在库里即抛：`messages.session_id` 在 DDL 里没有外键，这层的存在性检查就是它的替代。
 */
export function appendMessage(db: Db, draft: NewMessage): Message {
  const where = `新消息 ${draft.id}`;
  if (draft.id === "") throw badContentError(where, "id");
  assertModelId(draft.modelId, where);
  assertRoleParts(draft.role, draft.parts, where);

  return db.transaction((tx) => {
    const session = tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, draft.sessionId))
      .get();
    if (session === undefined) {
      throw new Error(`会话 ${draft.sessionId} 不在库里，消息追加不了`);
    }

    const top = tx
      .select({ seq: max(messages.seq) })
      .from(messages)
      .where(eq(messages.sessionId, draft.sessionId))
      .get();
    const seq = (top?.seq ?? -1) + 1;

    tx.insert(messages)
      .values({
        sessionId: draft.sessionId,
        seq,
        id: draft.id,
        role: draft.role,
        modelId: draft.modelId,
        createdAt: draft.createdAt,
      })
      .run();
    draft.parts.forEach((part, idx) => {
      tx.insert(messageParts).values(partValues(draft.sessionId, seq, idx, part)).run();
    });
    // 会话清单按 updatedAt 排序：不跟上这一刻的话，顺序就停在过去
    tx.update(sessions).set({ updatedAt: draft.createdAt }).where(eq(sessions.id, draft.sessionId)).run();

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
  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.seq))
    .all();
  const partRows = db
    .select()
    .from(messageParts)
    .where(eq(messageParts.sessionId, sessionId))
    .orderBy(asc(messageParts.seq), asc(messageParts.idx))
    .all();

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
