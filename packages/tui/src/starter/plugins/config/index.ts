/**
 * @fileoverview 配置插件：启动**最先行**的一棒——装载本地配置（缺文件先建空文件），把 `ConfigStore` 挂成服务
 * `ctx.cfg`，并把 store 的 `reload` 订阅转成树上的事件 `config.reload`
 * @module starter/plugins/config
 * @description
 * 配置是其它插件的入口条件（数据库地址等）：消费者用 `inject: ["cfg"]` 等它就绪。装载失败 = 插件装载失败
 * （预设 `await` 了本插件，= 启动失败）。
 * store 是纯数据层、不认识 cordis——「谁调 `ctx.cfg.reload()` 都会广播」这条接线只在本文件搭一次。
 * 服务与事件的类型按 Cordis 惯例在**提供者的文件里**声明（`declare module`）。
 *
 * ## 事件（动手前后各一条，形状见 `@/starter/index.js`）
 * - `config.loading`（**装载前**）：此刻还没有任何配置，监听者别想读 `ctx.cfg`。
 * - `config.loaded`（装载后，排在 `ctx.provide` 之后）：载荷含实际读到的 `file` 与冻结快照。
 * - `config.failed`：装载失败（坏 JSON / 非法取值）；随后本插件**照旧装载失败** = 启动失败。
 * - `config.reload`：之后每次 `ctx.cfg.reload()` 重读**成功**（换前 / 换后 + 变了的节）。
 */

import type { Context } from "cordis";
import { ConfigStore, type ConfigReload, type TuiConfig } from "@/config/index.js";

/** `config.loaded` 的载荷：这次装到了什么（值与 `ctx.cfg.get()` 是同一份冻结快照） */
export interface ConfigLoaded {
  /** 实际读到的配置文件路径（`config.json` 优先、其次 `config.jsonc`） */
  file: string;
  /** 装载结果（全量、冻结） */
  config: TuiConfig;
}

declare module "cordis" {
  interface Context {
    /** 本地配置（由 `configPlugin` 提供；`get` / `set` / `reload`，见 `ConfigStore`） */
    cfg: ConfigStore;
  }
  interface Events {
    /** 装载前：此刻还没有配置 */
    "config.loading"(): void;
    /** 装载后：此时 `ctx.cfg` 已可用 */
    "config.loaded"(event: ConfigLoaded): void;
    /** 装载失败：随后本插件装载失败 = 启动失败，这条只管让 UI 停转 */
    "config.failed"(error: Error): void;
    /** 重读成功：换前 / 换后快照 + 这次变了的顶层节 */
    "config.reload"(event: ConfigReload): void;
  }
}

/** 插件抛出来的东西未必是 `Error`（`throw "boom"` 合法），统一成 `Error` 再交给监听者 */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** 装载配置挂成 `ctx.cfg`，并把 reload 转发成树上的 `config.reload` 事件（fiber 卸载时退订） */
export function configPlugin(ctx: Context): void {
  ctx.emit("config.loading"); // 动手之前：让 UI 先画上 loading
  let cfg: ConfigStore;
  try {
    cfg = ConfigStore.load();
  } catch (error) {
    try {
      // `ctx.emit` 会把监听器抛的错原样冒出来，不兜就会顶掉真正的装载错
      ctx.emit("config.failed", asError(error));
    } catch {
      // 监听器自己坏了，它已经在自己的栈里炸过一次，这里不再叠一个
    }
    throw error; // 装载失败 = 启动失败（预设 await 了本插件）
  }
  ctx.provide("cfg", cfg);
  ctx.emit("config.loaded", { file: cfg.file, config: cfg.get() });
  ctx.effect(() => cfg.onReload((event) => ctx.emit("config.reload", event)));
}