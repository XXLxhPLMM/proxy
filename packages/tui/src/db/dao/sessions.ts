/**
 * @fileoverview `sessions` 表的**原子**行操作（CRUD）：每一句只做一件事，不含事务、跨表或校验。
 * @module db/dao/sessions
 * @description 校验下沉到 `service/`（`assertModelId` / `badContentError`），DAO 层只负责行 ↔ 表。
 */

import type { Db } from "@/db/dialect.js";
import type { NewSession, Session, SessionPatch } from "@/db/dto/session.js";
import { asc, desc, eq } from "drizzle-orm";
import { sessions } from "@/db/sqlite/schemas/index.js";

/** 建一行；`updatedAt` 由 DAO 从 `createdAt` 填充，不劳动调用方填两遍 */
export function createSessionRow(db: Db, draft: NewSession): Session {
  db.insert(sessions).values({ ...draft, updatedAt: draft.createdAt }).run();
  return { ...draft, updatedAt: draft.createdAt };
}

/** 按 `id` 取一行；不在库里给 `undefined` */
export function getSessionRow(db: Db, id: string): Session | undefined {
  return db.select().from(sessions).where(eq(sessions.id, id)).get();
}

/** 清单；最近更新的在前（同一时刻按 `id` 定序，顺序可复现） */
export function listSessionRows(db: Db): readonly Session[] {
  return db.select().from(sessions).orderBy(desc(sessions.updatedAt), asc(sessions.id)).all();
}

/** 只取激活的那几个会话；定序与 {@link listSessionRows} 同一套（最近更新的在前） */
export function listActiveSessionRows(db: Db): readonly Session[] {
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.isActive, true))
    .orderBy(desc(sessions.updatedAt), asc(sessions.id))
    .all();
}

/** 改 `title` / `modelId` / `status` / `isActive` / `updatedAt`；`id` 不在库里给 `false` */
export function updateSessionRow(
  db: Db,
  id: string,
  patch: SessionPatch & { updatedAt: number },
): boolean {
  return Number(db.update(sessions).set(patch).where(eq(sessions.id, id)).run().changes) > 0;
}

/** 删一行；`id` 不在库里给 `false` */
export function deleteSessionRow(db: Db, id: string): boolean {
  return Number(db.delete(sessions).where(eq(sessions.id, id)).run().changes) > 0;
}

/** 推进某个会话的 `updatedAt` 到给定时刻（供追加消息时保持会话清单排序） */
export function updateSessionUpdatedAtRow(db: Db, id: string, updatedAt: number): boolean {
  return Number(db.update(sessions).set({ updatedAt }).where(eq(sessions.id, id)).run().changes) > 0;
}
