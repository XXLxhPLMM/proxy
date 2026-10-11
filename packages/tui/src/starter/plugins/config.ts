/**
 * @fileoverview 配置插件：启动**最先行**的一棒——装载本地配置（缺文件先建空文件），把 `ConfigStore` 挂成服务 `ctx.cfg`，
 * 并把 store 的 `reload` 订阅转成树上的事件 `config.reload`（插件用 `ctx.on("config.reload")` 听）
 * @module starter/plugins/config
 * @description
 * 配置是其它插件的入口条件（数据库地址等）：消费者用 `inject: ["cfg"]` 等它就绪。装载失败
 * （坏 JSON / 非法取值）= 插件装载失败（预设 `await` 了本插件，= 启动失败）。
 * store 是纯数据层、不认识 cordis——「谁调 `ctx.cfg.reload()` 都会广播」这条接线只在本文件搭一次。
 * 事件与服务的类型按 Cordis 惯例在**提供者的文件里**声明（`declare module`）。
 */

import type { Context } from "cordis";
import { ConfigStore, type ConfigReload } from "@/config/index.js";

declare module "cordis" {
  interface Context {
    /** 本地配置（由 `configPlugin` 提供；`get` / `set` / `reload`，见 `ConfigStore`） */
    cfg: ConfigStore;
  }
  interface Events {
    /** `ctx.cfg.reload()` 重读**成功**后的广播：换前 / 换后快照 + 这次变了的顶层节（`ConfigReload`） */
    "config.reload"(event: ConfigReload): void;
  }
}

/** 装载配置挂成 `ctx.cfg`，并把 reload 转发成树上的 `config.reload` 事件（fiber 卸载时退订） */
export function configPlugin(ctx: Context): void {
  const cfg = ConfigStore.load();
  ctx.provide("cfg", cfg);
  ctx.effect(() => cfg.onReload((event) => ctx.emit("config.reload", event)));
}
