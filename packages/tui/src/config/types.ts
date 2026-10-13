/**
 * @fileoverview 配置的形状：`database` 与 `agents` 两格
 * @module config/types
 * @description 库那一格**直接沿用开库契约** `DbConfig`（字段名与档位都在那边定），读出来即 `openDb` 的入参——
 * 两处永远同形，不各养一份。
 */

import type { DbConfig } from "@/db/dialect.js";
import type { AgentsConfig } from "./agents/defaults.js";

/** 配置文件里今天认下的集合（缺项吃 `defaults.ts` 的默认值） */
export interface TuiConfig {
  /** 本地库：数据源（`dialect`，默认 `sqlite`）与地址（sqlite 给 `path`；mysql / pgsql 给 `url`，凭据可放 `user` / `password`） */
  database: DbConfig;
  /** agent 循环：一次调用最多走几步（`maxSteps`） */
  agents: AgentsConfig;
}
