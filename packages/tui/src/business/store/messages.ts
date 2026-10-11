/**
 * @fileoverview 消息门面：`attach` 包装已打开的库句柄，方法即 `messages` + `message_parts` 两张表的操作
 * @module business/store/messages
 * @description 方法们只是把 `@/service/messages.js` 的原语绑上本实例的句柄（判据、事务都在那边）。
 * ⚠️ 句柄的开 / 关不归本门面（归 `@/starter/plugins/database.js`）；应用里组装走 `@/business/attach.js` 的 `attachResource`。
 */

import type { Db } from "@/db/dialect.js";
import type { Message } from "@/db/dto/index.js";
import { appendMessage, listMessages, type NewMessage } from "@/service/messages.js";

export class MessagesStore {
  private readonly db: Db;

  private constructor(db: Db) {
    this.db = db;
  }

  /** 包装一个已打开的库句柄（schema 由 `attachResource` 备好） */
  static attach(db: Db): MessagesStore {
    return new MessagesStore(db);
  }

  /** 追加一条消息（消息行 + 各段行 + 会话 `updatedAt`，同一个事务） */
  append(draft: NewMessage): Message {
    return appendMessage(this.db, draft);
  }

  /** 一个会话的全部消息；消息按 `seq`、段按 `idx` 升序 */
  list(sessionId: string): readonly Message[] {
    return listMessages(this.db, sessionId);
  }
}
