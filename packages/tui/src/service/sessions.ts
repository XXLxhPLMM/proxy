/**
 * @fileoverview 会话**服务**：会话的业务操作原语。行操作走 `ctx.dao.sessions`，库句柄走 `ctx.db`，
 * 跨表关联删除在事务中编排（事务内的原子行操作交给 DAO），出入参走 DTO（`@/db/dto/`）。
 * @module service/sessions
 * @description
 * 写面判据与读面同一套（`assertModelId` / `badContentError`）：写不进一条「读出来会被拒」的行。
 * ⚠️ **不 import DAO**：行操作目录挂在 `ctx.dao`（由 `starter/plugins/dao` 提供），库挂在 `ctx.db`。
 *   库的传法只有两种 —— 普通路径 `this.ctx.db`，事务回调里的 `tx` —— DAO 的第一个参数收得住这两种，
 *   所以永远显式传、不闭包持有。
 * ⚠️ 跨目录取会话服务走 `ctx.services.sessions`（由 `starter/plugins/services` 提供），别直接 import 本文件。
 */

import { randomUUID } from "node:crypto";
import type { Context } from "cordis";
import type { ModelId } from "@/lib/model-id.js";
import type { NewSession, Session, SessionPatch, SessionStatus } from "@/db/dto/index.js";
import { assertModelId, assertSessionStatus, badContentError } from "@/db/read.js";
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

/** 会话服务 */
export class SessionsService {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** 会话清单；最近更新的在前，同一时刻按 `id` 定序（顺序可复现，不靠驱动给的偶然次序） */
  list(): readonly Session[] {
    return this.ctx.dao.sessions
      .listSessionRows(this.ctx.db)
      .map((row) => sessionFromRow(row, `会话 ${row.id}`));
  }

  /** 激活的会话（`isActive` 为真的那几个）；定序同 {@link list} */
  listActive(): readonly Session[] {
    return this.ctx.dao.sessions
      .listActiveSessionRows(this.ctx.db)
      .map((row) => sessionFromRow(row, `会话 ${row.id}`));
  }

  /** 按 `id` 取一个会话；不在库里给 `undefined` */
  get(id: string): Session | undefined {
    const row = this.ctx.dao.sessions.getSessionRow(this.ctx.db, id);
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
    return this.ctx.dao.sessions.createSessionRow(this.ctx.db, { ...draft, id });
  }

  /**
   * 改标题 / 换模型 / 记状态 / 切活动会话 / 记更新时刻；`id` 不在库里给 `false`（不抛），在库里给 `true`
   */
  update(id: string, patch: SessionPatch): boolean {
    const set: {
      title?: string;
      modelId?: ModelId | null;
      status?: SessionStatus | null;
      isActive?: boolean;
      updatedAt: number;
    } = {
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
    return this.ctx.dao.sessions.updateSessionRow(this.ctx.db, id, set);
  }

  /**
   * 删一个会话连同它的消息与消息段（三张表同一个事务）：先级联删段、再删消息、最后删会话
   * @description ⚠️ 事务里 DAO 的第一个参数是 `tx` 而不是 `this.ctx.db` —— 行操作目录不绑库，
   *   所以同一组调用在事务内外长一个样。
   * @returns 会话那行本来在库里给 `true`；不在给 `false`（顺带扫掉的孤儿行是清理，不是「删到了」的证据）
   */
  delete(id: string): boolean {
    return this.ctx.db.transaction((tx) => {
      this.ctx.dao.messages.deleteMessageRows(tx, id);
      return this.ctx.dao.sessions.deleteSessionRow(tx, id);
    });
  }
}