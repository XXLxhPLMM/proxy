/**
 * @fileoverview 默认配置：文件缺项 / 缺文件时的兜底（**代码是默认值的唯一真值**，建出来的文件不抄一份）
 * @module config/defaults
 * @description 顶层只把各节的默认值拼起来；各节自己的默认值住在自家文件夹（如 `database/defaults.js`）。
 */

import { defaultDatabaseConfig } from "./database/defaults.js";
import type { TuiConfig } from "./types.js";

/** 全量默认：今天只有 database 一节（sqlite + 默认落点） */
export function defaultTuiConfig(): TuiConfig {
  return { database: defaultDatabaseConfig() };
}
