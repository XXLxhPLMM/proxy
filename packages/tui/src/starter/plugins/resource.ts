/**
 * @fileoverview 本地资源插件：在 `ctx.database` 上备好 schema，把会话 / 消息两个门面挂成服务 `ctx.resource`
 * @module starter/plugins/resource
 * @description
 * 句柄的生与死归 `databasePlugin`；本插件 `inject: ["database"]` —— **等 database 装载完成（ACTIVE）才加载**，
 * schema 因此只会跑在句柄已打开之后。本插件管**资源这一层**：备 schema，再把两个**各自独立**的门面
 * （`ctx.resource.sessions` / `ctx.resource.messages`，不共用一个 store）一起提供出去。
 * 服务类型按 Cordis 惯例在**提供者的文件里**声明（`declare module`）。
 *
 * ⚠️ 建表失败 = 插件装载失败：只有预设 `await` 了本插件，它才会变成启动失败（理由见 `@/starter/index.js`）。
 */

import type { Context } from "cordis";
import { attachResource, type Resource } from "@/services/resource/index.js";

declare module "cordis" {
  interface Context {
    /** 本地资源（会话 / 消息各自一个门面；由 `resourcePlugin` 提供） */
    resource: Resource;
  }
}

/** 在已打开的库上备好 schema 并挂资源门面；卸载时无需收尾（句柄归 `databasePlugin`） */
export function resourcePlugin(ctx: Context): void {
  ctx.provide("resource", attachResource(ctx.database)); // 建表失败 = 插件装载失败
}

resourcePlugin.inject = ["database"]; // 等 database 装载完成再加载（顺序由容器排，与预设里的挂载次序无关）
