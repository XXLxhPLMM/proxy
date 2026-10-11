/**
 * @fileoverview 配置插件：启动**最先行**的一棒——装载本地配置（缺文件先建空文件），把 `ConfigStore` 挂成服务 `ctx.cfg`
 * @module starter/plugins/config
 * @description
 * 配置是其它插件的入口条件（数据库地址等）：消费者用 `inject: ["cfg"]` 等它就绪。装载失败
 * （坏 JSON / 非法取值）= 插件装载失败（预设 `await` 了本插件，= 启动失败）。
 * 服务类型按 Cordis 惯例在**提供者的文件里**声明（`declare module`）。
 */

import type { Context } from "cordis";
import { ConfigStore } from "@/config/index.js";

declare module "cordis" {
  interface Context {
    /** 本地配置（由 `configPlugin` 提供；`get` / `set` / `reload`，见 `ConfigStore`） */
    cfg: ConfigStore;
  }
}

/** 装载配置并挂成 `ctx.cfg`（缺文件先建空配置；无卸载收尾——配置是纯数据） */
export function configPlugin(ctx: Context): void {
  ctx.provide("cfg", ConfigStore.load());
}
