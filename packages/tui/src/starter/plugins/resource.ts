/**
 * @fileoverview 本地资源插件：在 `ctx.database` 上备好 schema，把四个资源挂成服务 `ctx.resource`
 * @module starter/plugins/resource
 * @description
 * 句柄的生与死归 `databasePlugin`；本插件 `inject: ["database"]` —— 等 database 装载完成（ACTIVE）才加载，
 * schema 因此只会跑在句柄已打开之后。本插件管资源层：备 schema，再把四个**各自独立**的服务
 * （`ctx.resource.sessions` / `ctx.resource.messages` / `ctx.resource.providers` / `ctx.resource.models`）
 * 一起提供出去。服务类型按 Cordis 惯例在提供者的文件里声明（`declare module`）。
 *
 * ⚠️ 建表失败 = 插件装载失败：只有预设 `await` 了本插件，它才会变成启动失败（理由见 `@/starter/index.ts`）。
 */

import type { Context } from "cordis";
import { ensureSchema } from "@/db/sqlite/init.js";
import { MessagesService, ModelsService, ProvidersService, SessionsService } from "@/service/index.js";

declare module "cordis" {
  interface Context {
    /** 本地资源（会话 / 消息 / 提供商 / 模型各自一个服务；由 `resourcePlugin` 提供） */
    resource: Resource;
  }
}

/** 四个资源服务组成的对象 */
export interface Resource {
  /** 会话（`sessions` 表） */
  readonly sessions: SessionsService;
  /** 消息（`messages` + `message_parts` 表） */
  readonly messages: MessagesService;
  /** 模型提供商（`providers` 表） */
  readonly providers: ProvidersService;
  /** 模型清单（`models` 表） */
  readonly models: ModelsService;
}

/** 在已打开的库上备好 schema 并挂四个资源服务；卸载时无需收尾（句柄归 `databasePlugin`） */
export function resourcePlugin(ctx: Context): void {
  ensureSchema(ctx.database); // 建表失败 = 插件装载失败
  ctx.provide("resource", {
    sessions: new SessionsService(ctx.database),
    messages: new MessagesService(ctx.database),
    providers: new ProvidersService(ctx.database),
    models: new ModelsService(ctx.database),
  });
}

resourcePlugin.inject = ["database"]; // 等 database 装载完成再加载（顺序由容器排，与预设里的挂载次序无关）
