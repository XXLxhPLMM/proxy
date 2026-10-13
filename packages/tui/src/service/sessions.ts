/**
 * @fileoverview 会话资源**服务**：会话的**业务操作原语**，对 `@/db/dao/sessions` 作校验后调用；
 * 跨表关联删除在事务中编排（事务内的原子行操作交给 DAO），出入参走 DTO（`@/db/dto/`）。
 * @module service/sessions
 * @description 写面判据与读面同一套（`assertModelId` / `badContentError`）：写不进一条「读出来会被拒」的行。
 * ⚠️ 跨目录取本地库走 `ctx.resource.sessions`（由 `starter/plugins/resource` 提供），别直接 import 本文件。
 */

import { randomUUID } from "node:crypto";
import type { ModelId } from "@/lib/model-id.js";
import type { Db } from "@/db/dialect.js";
import type { NewSession, Session, SessionPatch, SessionStatus } from "@/db/dto/index.js";
import { assertModelId, assertSessionStatus, badContentError } from "@/db/read.js";
import { dao } from "@/db/index.js";
import type { SessionRow } from "@/db/sqlite/schemas/index.js";

/**
 * 一行 → 一个 `Session`；`id` 空串、`modelId` 不是 `provider/model` 形状、`status` 表外、
 * `isActive` 不是布尔即抛
 */
function sessionFromRow(row: SessionRow, where: string): Session {
  if (row.id === "") throw badContentError(where, "id");
  assertModelId(row.modelId, where);
  assertSessionStatus(row.status, where);
  if (typeof row.isActive !== "boolean") throw badContentError(where, "is_active");
  return {
    id: row.id,
    title: row.title,
    modelId: row.modelId,
    status: row.status,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 会话资源服务 */
export class SessionsService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** 会话清单；最近更新的在前，同一时刻按 `id` 定序（顺序可复现，不靠驱动给的偶然次序） */
  list(): readonly Session[] {
    return dao.sessions.listSessionRows(this.db).map((row) => sessionFromRow(row, `会话 ${row.id}`));
  }

  /** 激活的会话（`isActive` 为真的那几个）；定序同 {@link list} */
  listActive(): readonly Session[] {
    return dao.sessions
      .listActiveSessionRows(this.db)
      .map((row) => sessionFromRow(row, `会话 ${row.id}`));
  }

  /** 按 `id` 取一个会话；不在库里给 `undefined` */
  get(id: string): Session | undefined {
    const row = dao.sessions.getSessionRow(this.db, id);
    return row === undefined ? undefined : sessionFromRow(row, `会话 ${id}`);
  }

  /**
   * 建一个会话；先校验，`id` 撞了让驱动抛（主键约束的文案自己点名那一列）
   * @description `id` 不带就现生成 `randomUUID()`（UUID v4；与 `messages.id` 同一个生成器），
   * 同 `append` 现算 `seq` 是同一个分工：主键怎么来归写入层，调用方只管说「建一个什么样的会话」。
   * ⚠️ 带空串不是「不带」：那是坏行，当场抛。
   */
  create(draft: NewSession): Session {
    const id = draft.id ?? randomUUID();
    const where = `新会话 ${id}`;
    if (id === "") throw badContentError(where, "id");
    assertModelId(draft.modelId, where);
    assertSessionStatus(draft.status, where);
    return dao.sessions.createSessionRow(this.db, { ...draft, id });
  }

  /**
   * 改标题 / 换模型 / 记状态 / 切活动会话 / 记更新时刻；`id` 不在库里给 `false`（不抛），在库里给 `true`
   */
  update(id: string, patch: SessionPatch): boolean {
    const set: { title?: string; modelId?: ModelId | null; status?: SessionStatus | null; isActive?: boolean; updatedAt: number } = {
      updatedAt: patch.updatedAt,
    };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.modelId !== undefined) {
      assertModelId(patch.modelId, `会话 ${id}`);
      set.modelId = patch.modelId;
    }
    if (patch.status !== undefined) {
      assertSessionStatus(patch.status, `会话 ${id}`);
      set.status = patch.status;
    }
    if (patch.isActive !== undefined) set.isActive = patch.isActive;
    return dao.sessions.updateSessionRow(this.db, id, set);
  }

  /**
   * 删一个会话连同它的消息与消息段（三张表同一个事务）：先级联删段、再删消息、最后删会话
   * @returns 会话那行本来在库里给 `true`；不在给 `false`（顺带扫掉的孤儿行是清理，不是「删到了」的证据）
   */
  delete(id: string): boolean {
    return this.db.transaction((tx) => {
      dao.messages.deleteMessageRows(tx, id);
      return dao.sessions.deleteSessionRow(tx, id);
    });
  }
}
