/**
 * @fileoverview 本地资源插件：在**同步过**的 `ctx.library` 上挂四个资源服务 `ctx.resource`
 * @module starter/plugins/resource
 * @description
 * 句柄的生与死归 `databasePlugin`、结构同步归 `schemaPlugin`；本插件 `inject: ["library"]` ——
 * **注入的是同步过的那个句柄**，所以结构同步没过闸之前本插件根本不会装载（容器停等），资源层也就无从存在。
 * ⚠️ 注入 `database`（打开但未必同步的句柄）= 绕过闸门，别这么写。
 *
 * 本插件管资源层：把四个**各自独立**的服务（`ctx.resource.sessions` / `ctx.resource.messages` /
 * `ctx.resource.providers` / `ctx.resource.models`）一起提供出去。服务类型按 Cordis 惯例在提供者的文件里
 * 声明（`declare module`）。
 */

import type { Context } from "cordis";
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

/** 挂四个资源服务；卸载时无需收尾（句柄归 `databasePlugin`） */
export function resourcePlugin(ctx: Context): void {
  ctx.provide("resource", {
    sessions: new SessionsService(ctx.library),
    messages: new MessagesService(ctx.library),
    providers: new ProvidersService(ctx.library),
    models: new ModelsService(ctx.library),
  });
}

resourcePlugin.inject = ["library"]; // ⚠️ 注入同步过的句柄：结构同步是本插件的硬前置（闸门在 schemaPlugin）
