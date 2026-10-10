/**
 * @fileoverview 本地会话库的门面：`create` 开库建表、方法即操作、`close` 收尾
 * @module services/resource/store
 * @description ⚠️ 刻意**没有连接池、没有重连**：SQLite 是嵌入式单写者，本包单进程单线程（同步驱动），
 * 一条连接就是最优形态；同一个路径开两个实例 = 两条连接，调用方自己避免。
 * 方法们只是把 `./ops/sessions.js` / `./ops/messages.js` 的原语绑上本实例的句柄（判据、事务都在那边）。
 * 应用侧取实例走 `@/services/container.js`（单例 + 初始化）；`create` 留给测试与需要临时库的场景。
 */

import { closeDb, openDb, type Db } from "@/services/db/dialect.js";
import type { Message, Session } from "@/services/db/dto/index.js";
import { ensureSchema } from "@/services/db/sqlite/init.js";
import { appendMessage, listMessages, type NewMessage } from "./ops/messages.js";
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  updateSession,
  type NewSession,
  type SessionPatch,
} from "./ops/sessions.js";

export class SessionStore {
  private readonly db: Db;

  private closed = false;

  private constructor(db: Db) {
    this.db = db;
  }

  /**
   * 开库并备好 schema
   * @param dbPath - 库文件路径；父目录 / 文件不存在就建出来（0700 目录 + 0600 文件），缺表就按基线建表
   */
  static create(dbPath: string): SessionStore {
    const db = openDb({ path: dbPath });
    try {
      ensureSchema(db);
    } catch (err) {
      closeDb(db); // 建表没成不留半开句柄
      throw err;
    }
    return new SessionStore(db);
  }

  /** 关过没有；关过之后任何操作都抛 */
  get isClosed(): boolean {
    return this.closed;
  }

  /** 关库（幂等：重复调用是空操作；驱动档也各自幂等） */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeDb(this.db);
  }

  /** 会话清单；最近更新的在前 */
  listSessions(): readonly Session[] {
    return listSessions(this.handle());
  }

  /** 按 `id` 取一个会话；不在库里给 `undefined` */
  getSession(id: string): Session | undefined {
    return getSession(this.handle(), id);
  }

  /** 建一个会话 */
  createSession(draft: NewSession): Session {
    return createSession(this.handle(), draft);
  }

  /** 改标题 / 换模型 / 记更新时刻；`id` 不在库里给 `false` */
  updateSession(id: string, patch: SessionPatch): boolean {
    return updateSession(this.handle(), id, patch);
  }

  /** 删一个会话连同它的消息与消息段（同一个事务） */
  deleteSession(id: string): boolean {
    return deleteSession(this.handle(), id);
  }

  /** 追加一条消息（消息行 + 各段行 + 会话 `updatedAt`，同一个事务） */
  appendMessage(draft: NewMessage): Message {
    return appendMessage(this.handle(), draft);
  }

  /** 一个会话的全部消息；消息按 `seq`、段按 `idx` 升序 */
  listMessages(sessionId: string): readonly Message[] {
    return listMessages(this.handle(), sessionId);
  }

  /** 句柄在关库之后不许再用：错误在这里说清，而不是让驱动抛 `ERR_INVALID_STATE` */
  private handle(): Db {
    if (this.closed) throw new Error("本地库已关（close() 之后不再接受操作）");
    return this.db;
  }
}
