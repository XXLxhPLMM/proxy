/**
 * @fileoverview 资源层的组装点：备好 schema，把会话 / 消息两个门面一起交出去
 * @module business/attach
 * @description 两个门面**各自独立**（`store/sessions.ts` / `store/messages.ts`），共享同一个库句柄与同一份基线 ——
 * {@link ensureSchema} 在这里**只跑一次**（不随门面数量重复）。句柄的开 / 关归调用方（应用里是 database 插件）。
 */

import type { Db } from "@/db/dialect.js";
import { ensureSchema } from "@/db/sqlite/init.js";
import { ModelsStore } from "./store/models.js";
import { MessagesStore } from "./store/messages.js";
import { ProvidersStore } from "./store/providers.js";
import { SessionsStore } from "./store/sessions.js";

/** 资源门面：会话 / 消息与模型配置各自一个 store（不共用一个类） */
export interface Resource {
  /** 会话（`sessions` 表） */
  readonly sessions: SessionsStore;
  /** 消息（`messages` + `message_parts` 表） */
  readonly messages: MessagesStore;
  /** 模型提供商（`providers` 表） */
  readonly providers: ProvidersStore;
  /** 模型清单（`models` 表） */
  readonly models: ModelsStore;
}

/**
 * 备好 schema 并组装资源门面
 * @param db - 已打开的库句柄（开 / 关归调用方）
 * @throws 建表 / 列校验失败即抛；句柄仍归调用方管，本层不留半成品
 */
export function attachResource(db: Db): Resource {
  ensureSchema(db);
  return {
    sessions: SessionsStore.attach(db),
    messages: MessagesStore.attach(db),
    providers: ProvidersStore.attach(db),
    models: ModelsStore.attach(db),
  };
}
