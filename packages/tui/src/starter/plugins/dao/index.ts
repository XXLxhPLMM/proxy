/**
 * @fileoverview DAO 插件：把本地库的**行操作目录**挂成服务 `ctx.dao`（会话 / 消息 / 提供商 / 模型四个命名空间）
 * @module starter/plugins/dao
 * @description
 * ## `ctx.dao` 是什么、不是什么
 * - **是**「有哪些原子行操作」：四个命名空间，每个下面是一组 `(db, …)` 的纯函数。
 * - **不是**一个绑好的仓储：**`ctx.dao` 上不带库**。
 *
 * ⚠️ **库永远由调用方当第一个参数显式传**，因为那个参数可能是库句柄、也可能是事务代理
 *   （`service/` 的级联删与追加消息都在 `db.transaction((tx) => …)` 里调 DAO）。所以 DAO 层保持纯函数、
 *   `db/` 整层不认识 cordis，本插件只是把四个命名空间原样挂上去，一个字都不包装。
 *
 * ⚠️ **不 inject 任何东西**：行操作目录无状态、没有生死，所以闸门与它无关 —— 结构同步没过的那个时段里
 *   谁都拿不到 `ctx.db`，自然也调不动这上面的任何一行操作。业务闸门关的是 `servicesPlugin`。
 *
 * ⚠️ 挂载点**必须**在 `starter/`：类型声明一旦落进 `db/dao/*.ts`，`db/` 那层「不认识 cordis 的叶子」就作废了。
 */

import type { Context } from "cordis";
import { dao } from "@/db/index.js";

declare module "cordis" {
  interface Context {
    /**
     * 本地库的行操作目录（由 `daoPlugin` 提供）
     * ⚠️ 每个操作的**第一个参数是库句柄或事务代理**，由调用方传（`ctx.db`，或事务里的 `tx`）。
     */
    dao: Dao;
  }
}

/** 四张表的原子行操作，按表分四组（形状 = `@/db/dao/index.js` 的出口） */
export interface Dao {
  /** 会话（`sessions` 表） */
  readonly sessions: typeof dao.sessions;
  /** 消息（`messages` + `message_parts` 表） */
  readonly messages: typeof dao.messages;
  /** 提供商（`providers` 表） */
  readonly providers: typeof dao.providers;
  /** 模型（`models` 表） */
  readonly models: typeof dao.models;
}

/** 挂上行操作目录；无状态、无收尾（真正要收的是库，归 `dbPlugin`） */
export function daoPlugin(ctx: Context): void {
  ctx.provide("dao", {
    sessions: dao.sessions,
    messages: dao.messages,
    providers: dao.providers,
    models: dao.models,
  });
}