/**
 * @fileoverview 会话门面：`attach` 包装已打开的库句柄，方法即 `sessions` 表的操作
 * @module business/store/sessions
 * @description 方法们只是把 `@/service/sessions.js` 的原语绑上本实例的句柄（判据、事务都在那边）。
 * ⚠️ 句柄的开 / 关不归本门面（归 `@/starter/plugins/database.js`）；应用里组装走 `@/business/attach.js` 的 `attachResource`。
 */

import type { Db } from "@/db/dialect.js";
import type { NewSession, Session, SessionPatch } from "@/db/dto/index.js";
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  updateSession,
} from "@/service/sessions.js";

export class SessionsStore {
  private readonly db: Db;

  private constructor(db: Db) {
    this.db = db;
  }

  /** 包装一个已打开的库句柄（schema 由 `attachResource` 备好） */
  static attach(db: Db): SessionsStore {
    return new SessionsStore(db);
  }

  /** 会话清单；最近更新的在前 */
  list(): readonly Session[] {
    return listSessions(this.db);
  }

  /** 按 `id` 取一个会话；不在库里给 `undefined` */
  get(id: string): Session | undefined {
    return getSession(this.db, id);
  }

  /** 建一个会话 */
  create(draft: NewSession): Session {
    return createSession(this.db, draft);
  }

  /** 改标题 / 换模型 / 记更新时刻；`id` 不在库里给 `false` */
  update(id: string, patch: SessionPatch): boolean {
    return updateSession(this.db, id, patch);
  }

  /** 删一个会话连同它的消息与消息段（同一个事务） */
  delete(id: string): boolean {
    return deleteSession(this.db, id);
  }
}
