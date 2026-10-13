/**
 * @fileoverview 业务服务插件：在 `ctx.db` 与 `ctx.dao` 之上挂五个业务服务 `ctx.services`
 * @module starter/plugins/services
 * @description
 * 本插件 `inject: ["db", "dao"]` —— **`ctx.db` 是闸门**：`dbPlugin` 只有在结构同步做完后才 provide 它，
 * 所以同步没过之前本插件根本不会装载（容器停等），业务层也就无从存在。
 * ⚠️ 闸门是**结构性**的，不是纪律：全应用只有 `dbPlugin` 一处 provide `ctx.db`，本插件注不到就拿不到。
 *
 * 本插件管业务服务层：把五个**各自独立**的服务（`ctx.services.sessions` / `messages` /
 * `providers` / `models` / `mcps`）一起提供出去。服务类型按 Cordis 惯例在提供者的文件里声明（`declare module`）。
 *
 * ⚠️ **五个服务类不 extends Cordis 的 `Service`**：`Service` 的构造会把自己 `provide` 到 ctx 上，
 *   与本插件给的 `ctx.services.*` 撞成两份真值。它们要的「fiber 卸载即撤销」由本插件的 `ctx.provide` 满足。
 *
 * ## 事件（形状的规则见 `@/starter/index.js`）
 * - `mcp.data.changed`：**`mcps` 表改了一行**（`McpsService` 的每个写方法落库成功后发一条）。
 *   ⚠️ **声明随它的发出者走**（发它的是本插件提供的 `ctx.services.mcps`），不在 `starter/plugins/mcp/`
 *   那里声明——那边只是监听方。⚠️ 它**刻意不是**「开始 / 结束 / failed」那三段形状：写库是同步的一条 SQL，
 *   调用方拿到返回值时它已经完成了 ⇒ 没有「动手之前」可发，而失败那一刻调用方已经拿到抛出的错了，
 *   再发一条 `failed` 只是把同一个错说两遍。监听方（`ctx.mcp`）据此对表，UI 据此重读。
 */

import type { Context } from "cordis";
import {
  McpsService,
  MessagesService,
  ModelsService,
  ProvidersService,
  SessionsService,
  type McpDataChange,
} from "@/service/index.js";

declare module "cordis" {
  interface Context {
    /** 业务服务（会话 / 消息 / 提供商 / 模型 / MCP 服务器各自一个；由 `servicesPlugin` 提供） */
    services: Services;
  }
  interface Events {
    /** `mcps` 表改了一行（载荷只给「哪一行、怎么改的」；行本身不在这条事件里，监听方自己重读） */
    "mcp.data.changed"(change: McpDataChange): void;
  }
}

/** 五个业务服务组成的对象 */
export interface Services {
  /** 会话（`sessions` 表） */
  readonly sessions: SessionsService;
  /** 消息（`messages` + `message_parts` 表） */
  readonly messages: MessagesService;
  /** 提供商（`providers` 表） */
  readonly providers: ProvidersService;
  /** 模型（`models` 表） */
  readonly models: ModelsService;
  /** MCP 服务器（`mcps` 表） */
  readonly mcps: McpsService;
}

/** 挂五个业务服务；卸载时无需收尾（句柄归 `dbPlugin`） */
export function servicesPlugin(ctx: Context): void {
  ctx.provide("services", {
    sessions: new SessionsService(ctx),
    messages: new MessagesService(ctx),
    providers: new ProvidersService(ctx),
    models: new ModelsService(ctx),
    mcps: new McpsService(ctx),
  });
}

// ⚠️ 注入 `db` 就是过闸门：结构同步是本插件的硬前置（闸门在 `dbPlugin`）；`dao` 无状态，不受闸门约束
servicesPlugin.inject = ["db", "dao"];