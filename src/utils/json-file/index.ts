/**
 * JSON 配置文件热加载读取层出口。
 *
 * 跨目录引用一律走本文件（`@/utils/json-file/index.js`），**不要**深入目录内部路径：这样目录
 * 继续拆分时调用方零改动。层内互用相对路径、**禁止自引 barrel**。
 *
 * 只导出公共面：`readJsonCached` 与它的四个类型契约。层内实现
 * （`CacheEntry` / `SubscriberState` / 判定面允许集等）刻意不从这里出去。
 */

export { readJsonCached } from "./json-file.js";
export type { JsonFileEvent, JsonFileEventType, JsonFileOptions, JsonFileRead } from "./types.js";
