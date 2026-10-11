/**
 * @fileoverview 本地配置的出口：装载（缺文件先建）→ 校验 + 合默认值 → 活配置 `ConfigStore`
 * @module config
 * @description ⚠️ 目录内部用相对路径，不自我引用本 barrel。
 */

export { ConfigStore, type ConfigReload } from "./store.js";
export type { TuiConfig } from "./types.js";
