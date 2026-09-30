/**
 * **文件型**配置热加载读取层出口（JSON 文本与 SQLite 库共用同一套节流 / 缓存 / 事件机制）。
 *
 * 跨目录引用一律走本文件（`@/utils/json-file/index.js`），**不要**深入目录内部路径：这样目录
 * 继续拆分时调用方零改动。层内互用相对路径、**禁止自引 barrel**。
 *
 * 只导出公共面：两个读取入口（`readJsonCached` / `readCachedSource`）与它的四个类型契约。
 * 层内实现（`CacheEntry` / `SubscriberState` / 判定面允许集等）刻意不从这里出去。
 *
 * **两个入口不是两份实现**：`readJsonCached` 是 `readCachedSource` 的一层 JSON 特化，
 * 节流 / 缓存 / 四态事件全在后者里。选 `readCachedSource` 的场景是「数据在文件里但不是
 * JSON 文本」——如账号表切到 SQLite 库文件（`config/files/account-store.ts`）。
 */

export { readCachedSource, readJsonCached } from "./json-file.js";
export type { JsonFileEvent, JsonFileEventType, JsonFileOptions, JsonFileRead } from "./types.js";
