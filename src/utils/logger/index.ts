/**
 * @fileoverview 日志层目录出口
 * @module utils/logger/index
 * @description
 * 跨目录引用一律走本文件（`@/utils/logger/index.js`），**不要**深入
 * `utils/logger/` 内部路径：这样目录继续拆分时调用方零改动。
 *
 * 导出面：
 * - `port.ts`：`Logger` / `LogFields` / `LogLevel` + 等级表 `ORDER` / `COLOR`
 * - `sanitize.ts`：净化与参数拆分（`sanitizeLogText` / `renderErrorText` /
 *   `isPlainObject` / `splitFields` / `renderFieldValue` / `renderFields` /
 *   `stringifyValue`）
 * - `impl.ts`：`LoggerImpl` / `LoggerOptions` / `createLogger`
 * - `console.ts` / `noop.ts`：`createConsoleLogger` / `createNoopLogger`
 *
 * `jsonl.ts` 刻意不导出：它是 `impl.ts` 的私有落盘实现面
 * （小时轮转文件名、目录/文件权限、在途写集合都不属于对外契约）。
 *
 * 注：历史上的 `Logger` 类构造别名（`new Logger(...)`）已删除——
 * 类型位置用最小端口 `Logger`，构造位置用 `LoggerImpl`。
 */

export * from "./port.js";
export * from "./sanitize.js";
export * from "./impl.js";
export * from "./console.js";
export * from "./noop.js";
