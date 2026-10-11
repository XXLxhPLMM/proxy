/**
 * @fileoverview database 一节的校验：与开库契约 `DbConfig` 同形——读出来即 `openDb` 的入参
 * @module config/database/parse
 * @description 字段名与档位都跟着 `@/db/dialect.js` 走；mysql / pgsql 在配置层放行
 * （凭据散格 `user` / `password` 先预留形状），真要开库时由 `openDb` 按既有逻辑报「还没实现」。
 */

import type { DbConfig } from "@/db/dialect.js";
import { assertKeys, requireRecord, requireString } from "../guards.js";
import { expandHome } from "../paths.js";
import { defaultDbPath } from "./defaults.js";

/** 校验 database 一节并合上默认值；sqlite 缺 `path` 就吃默认落点 */
export function parseDatabaseConfig(raw: unknown, file: string): DbConfig {
  const record = requireRecord(raw, file, "database");
  const dialect = record.dialect;
  if (dialect === undefined || dialect === "sqlite") {
    assertKeys(record, ["dialect", "path"], file, "database");
    const path = record.path === undefined ? defaultDbPath() : expandHome(requireString(record.path, file, "database.path"));
    return { dialect: "sqlite", path };
  }
  if (dialect === "mysql" || dialect === "pgsql") {
    assertKeys(record, ["dialect", "url", "user", "password"], file, "database");
    const url = requireString(record.url, file, "database.url");
    const user = record.user === undefined ? undefined : requireString(record.user, file, "database.user");
    const password = record.password === undefined ? undefined : requireString(record.password, file, "database.password");
    return {
      dialect,
      url,
      ...(user !== undefined ? { user } : {}),
      ...(password !== undefined ? { password } : {}),
    };
  }
  throw new Error(`${file}：认不得的 "database.dialect"：${JSON.stringify(dialect)}（只有 sqlite / mysql / pgsql）`);
}
