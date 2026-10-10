import { snakeCase } from "drizzle-orm/sqlite-core/casing";

/** 列名统一 snake_case 的建表器（JS 侧 `modelId` → 库里 `model_id`，迁移 SQL 与它对齐） */
export const table = snakeCase.table;
