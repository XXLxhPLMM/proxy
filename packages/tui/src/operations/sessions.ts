/**
 * @fileoverview 会话资源的操作**原语**：`sessions` 表的增删改查，出参恒为本包 DTO 的 `Session`
 * @module operations/sessions
 * @description 库句柄走函数参数；时刻由调用方给，本层不读时钟。
 * ⚠️ 写面判据与读面同一套（`assertModelId` / `badContentError`）：写不进一条「读出来会被拒」的行。
 * ⚠️ 只给 `business/store/sessions.js`（门面）用：跨目录取本地库走 `ctx.business.sessions`，别直接 import 本文件。
 */

import { asc, desc, eq } from "drizzle-orm";
import type { ModelId } from "@/lib/model-id.js";
import type { Db } from "@/db/dialect.js";
import type { Session } from "@/db/dto/index.js";
import { assertModelId, badContentError } from "@/db/read.js";
import {
  messageParts,
  messages,
  sessions,
  type SessionRow,
} from "@/db/sqlite/schemas/index.js";

/** 新建会话的入参；`updatedAt` 初始等于 `createdAt`（刚建出来就是刚更新过），不劳动调用方填两遍 */
export interface NewSession {
  readonly id: string;
  readonly title: string;
  readonly modelId: ModelId | null;
  /** 创建时刻（epoch 毫秒） */
  readonly createdAt: number;
}

/** 改会话的入参；⚠️ `undefined` = 不动那一格，`modelId: null` = 清掉选中的模型 */
export interface SessionPatch {
  readonly title?: string;
  readonly modelId?: ModelId | null;
  /** 本次更新的时刻（epoch 毫秒） */
  readonly updatedAt: number;
}

/** 一行 → 一个 `Session`；`id` 空串或 `model_id` 不是 `provider/model` 形状即抛 */
function sessionFromRow(row: SessionRow, where: string): Session {
  if (row.id === "") throw badContentError(where, "id");
  assertModelId(row.modelId, where);
  return {
    id: row.id,
    title: row.title,
    modelId: row.modelId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 会话清单；最近更新的在前，同一时刻按 `id` 定序（顺序可复现，不靠驱动给的偶然次序） */
export function listSessions(db: Db): readonly Session[] {
  return db
    .select()
    .from(sessions)
    .orderBy(desc(sessions.updatedAt), asc(sessions.id))
    .all()
    .map((row) => sessionFromRow(row, `会话 ${row.id}`));
}

/** 按 `id` 取一个会话；不在库里给 `undefined` */
export function getSession(db: Db, id: string): Session | undefined {
  const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
  return row === undefined ? undefined : sessionFromRow(row, `会话 ${id}`);
}

/** 建一个会话；`id` 撞了让驱动抛（主键约束的文案自己点名那一列） */
export function createSession(db: Db, draft: NewSession): Session {
  const where = `新会话 ${draft.id}`;
  if (draft.id === "") throw badContentError(where, "id");
  assertModelId(draft.modelId, where);
  db.insert(sessions)
    .values({
      id: draft.id,
      title: draft.title,
      modelId: draft.modelId,
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    })
    .run();
  return {
    id: draft.id,
    title: draft.title,
    modelId: draft.modelId,
    createdAt: draft.createdAt,
    updatedAt: draft.createdAt,
  };
}

/** 改标题 / 换模型 / 记更新时刻；改一个不存在的 `id` 给 `false`（不抛），在库里给 `true` */
export function updateSession(db: Db, id: string, patch: SessionPatch): boolean {
  const set: { title?: string; modelId?: ModelId | null; updatedAt: number } = {
    updatedAt: patch.updatedAt,
  };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.modelId !== undefined) {
    assertModelId(patch.modelId, `会话 ${id}`);
    set.modelId = patch.modelId;
  }
  return Number(db.update(sessions).set(set).where(eq(sessions.id, id)).run().changes) > 0;
}

/**
 * 删一个会话连同它的消息与消息段（三张表同一个事务）
 * @returns 会话那行本来在库里给 `true`；不在给 `false`（顺带扫掉的孤儿行是清理，不是「删到了」的证据）
 */
export function deleteSession(db: Db, id: string): boolean {
  return db.transaction((tx) => {
    tx.delete(messageParts).where(eq(messageParts.sessionId, id)).run();
    tx.delete(messages).where(eq(messages.sessionId, id)).run();
    return Number(tx.delete(sessions).where(eq(sessions.id, id)).run().changes) > 0;
  });
}
