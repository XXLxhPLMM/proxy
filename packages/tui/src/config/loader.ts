/**
 * @fileoverview 配置装载：定位文件（缺则先建）→ 读 → 剥 JSONC / 严格 JSON → 顶层校验分派 → 合并默认值
 * @module config/loader
 * @description ⚠️ 文件是「覆盖手册」不是全量：只写要改的项；空文件 / 缺项都吃 `./defaults.js` 的默认值。
 * 顶层只管「认哪些节、怎么分派」，各节自己的形状与校验住在自家文件夹（如 `./database/`）。
 * 校验从严——认不得的配置项、类型不对的取值都**当场抛**：配置错了就是启动错了。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import stripJsonComments from "strip-json-comments";
import { parseDatabaseConfig } from "./database/parse.js";
import { defaultTuiConfig } from "./defaults.js";
import { assertKeys, requireRecord } from "./guards.js";
import { configFileCandidates } from "./paths.js";
import type { TuiConfig } from "./types.js";

/** 装载结果：实际生效的文件与合并后的配置 */
export interface LoadedTuiConfig {
  /** 实际读取的文件（缺文件时是新建的那个） */
  file: string;
  /** 文件覆盖 + 默认值合并后的全量配置 */
  config: TuiConfig;
}

/** 定位配置文件；候选都没有就新建第一个（空配置 `{}`——默认值在代码里，不在文件里） */
export function ensureConfigFile(): string {
  const candidates = configFileCandidates();
  const found = candidates.find((file) => existsSync(file));
  if (found !== undefined) {
    return found;
  }
  const primary = candidates[0];
  mkdirSync(dirname(primary), { recursive: true, mode: 0o700 });
  writeFileSync(primary, "{}\n", { encoding: "utf8", mode: 0o600 });
  return primary;
}

/** 装载：定位（缺则建）→ 读 → 校验并合上默认值 */
export function loadTuiConfig(): LoadedTuiConfig {
  const file = ensureConfigFile();
  return { file, config: parseTuiConfig(readConfigFile(file), file) };
}

/** 顶层校验：认哪些节（今天只有 database），缺节吃默认；各节内部校验分派给自家文件夹 */
export function parseTuiConfig(raw: unknown, file: string): TuiConfig {
  const record = requireRecord(raw, file, "顶层");
  assertKeys(record, ["database"], file, "顶层");
  const defaults = defaultTuiConfig();
  const database = record.database === undefined ? defaults.database : parseDatabaseConfig(record.database, file);
  return { database };
}

/** 读文件：空 / 纯注释 = 空配置；`.jsonc` 剥注释与尾逗号，`.json` 严格（读写按扩展名分家） */
function readConfigFile(file: string): unknown {
  const text = readFileSync(file, "utf8");
  const body = file.endsWith(".jsonc") ? stripJsonComments(text, { trailingCommas: true }) : text;
  if (body.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`${file}：不是有效 JSON（${error instanceof Error ? error.message : String(error)}）`);
  }
}
