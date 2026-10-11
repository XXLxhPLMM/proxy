/**
 * @fileoverview 本地库插件：按 `ctx.cfg` 开库（`openDb`）并把句柄挂成服务 `ctx.database`，卸载时关库（`closeDb`）
 * @module starter/plugins/database
 * @description
 * 句柄的**生与死**都在这里：打开后 `ctx.provide`，卸载时由 effect 关掉——消费者（今天的资源层、将来的
 * 其它表）只消费 `ctx.database`，不各开各的连接（SQLite 单写者，单进程单连接）。
 * 数据源与地址从 `ctx.cfg.get("database")` 读（`DbConfig` 形状；默认值住 `@/config`）。
 * 服务类型按 Cordis 惯例在**提供者的文件里**声明（`declare module`）。
 *
 * ⚠️ 开库失败 = 插件装载失败：只有预设 `await` 了本插件，它才会变成启动失败（理由见 `@/starter/index.js`）。
 */

import type { Context } from "cordis";
import { closeDb, openDb, type Db } from "@/services/db/dialect.js";

declare module "cordis" {
  interface Context {
    /** 本地库句柄（由 `databasePlugin` 提供） */
    database: Db;
  }
}

/** 开库并挂成 `ctx.database`（数据源 / 地址从 `ctx.cfg.get("database")` 读），卸载时关库 */
export function databasePlugin(ctx: Context): void {
  const db = openDb(ctx.cfg.get("database")); // 开库失败 = 插件装载失败
  ctx.provide("database", db); // 注册服务；fiber 卸载时自动撤销
  ctx.effect(() => () => closeDb(db)); // 关库；fiber 卸载时执行（closeDb 幂等）
}

databasePlugin.inject = ["cfg"]; // 等配置装载完成才加载（顺序由容器排，与预设里的挂载次序无关）
