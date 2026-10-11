/**
 * @fileoverview database 一节的默认值：sqlite + `~/.config/swain-proxy/tui/db/data.db`
 * @module config/database/defaults
 */

import { join } from "node:path";
import type { DbConfig } from "@/db/dialect.js";
import { configRootDir } from "../paths.js";

/** sqlite 库文件的默认落点：`~/.config/swain-proxy/tui/db/data.db` */
export function defaultDbPath(): string {
  return join(configRootDir(), "db", "data.db");
}

/** database 一节的默认值 */
export function defaultDatabaseConfig(): DbConfig {
  return { dialect: "sqlite", path: defaultDbPath() };
}
