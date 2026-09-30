/**
 * @fileoverview SQLite 子系统的出口 barrel
 * @module utils/sqlite
 * @description
 * 端口（`./driver.ts`）+ 两档实现的选择（`./open.ts`）+ 类型（`./types.js`）。跨目录只引本
 * barrel，与 `@/utils/logger`、`@/utils/json-file` 同一纪律。
 *
 * **本目录是叶子层**：运行期只允许 `@/utils/sqlite/*` 内部互引 + `@/config/index.js` 的
 * type-only 引用。两个消费者都经**本 barrel** 拿驱动，方向向下：
 * 账本（`core/traffic/`）与账号表（`config/files/account-store.ts`）。
 */

export type {
  OpenSqliteDriver,
  SqliteDriver,
  SqliteDriverChoice,
  SqliteDriverKind,
} from "./driver.js";
export type { SqlValue } from "./types.js";
export { openSqliteDriver } from "./open.js";
export type { SqliteDriverFactory } from "./open.js";
