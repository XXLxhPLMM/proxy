/**
 * @fileoverview 本机库的**位置**（纯函数，宿主只出 `homedir` 一个入参）
 */

import path from "node:path";

// ⚠️ **不读任何环境变量**：认它等于让「东西在哪儿」取决于从哪里敲起这个命令，而那种分裂的部署比一个固定位置难查

/** 配置目录名（Windows 与 POSIX 同一个字面量，接 `APPDATA` 会让 WSL 与 Windows 各有一份） */
const CONFIG_DIR_NAME = "swain-proxy";

/** 库文件名 */
const DB_FILE = "tui.db";

/** 配置目录（`<homedir>/.config/swain-proxy`）；⚠️ 目录由 `./db.js` 建并 `chmod 0700`，本函数只算位置 */
export function resolveConfigDir(homedir: string): string {
  return path.join(homedir, ".config", CONFIG_DIR_NAME);
}

/** 库文件路径（`~/.config/swain-proxy/tui.db`） */
export function dbPath(homedir: string): string {
  return path.join(resolveConfigDir(homedir), DB_FILE);
}