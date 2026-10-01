/**
 * @fileoverview 数据源层出口（`@b-hole/proxy` 内部引用它，不引子目录路径）
 * @module datasource/index
 * @description
 * 三份数据源——账号表 / 访问控制名单 / 配额账本——各自的子目录 barrel 由本文件汇成一处。
 * 同一纪律与 `@/config/index.js`、`@/datasource/index.js` 自身 相同：**目录重构时调用方零改动**。
 *
 * **为什么本层是「数据从哪来」而不是「数据是什么意思」**：形状校验在各自的 `validate.ts`
 * 且三处共用同一份判据（账号表与名单的条目语法判据是同一个 `@/addr/index.js`
 * ——纯函数语法层，零 IO、零配置依赖）；
 * 而「账号级封禁」「配额耗尽」这类**判定**在代理侧，本层一个判定函数都不提供。
 *
 * 护栏：`src/datasource/AGENTS.md` 的层不变量；「不启动代理也能用」的库级契约在
 * `tests/library/entry.test.ts`。
 */

// ---------------------------------------------------------------------------
// 根：驱动名词汇表 + 注册表本体 + 窗口键
// ---------------------------------------------------------------------------

export {
  BUILTIN_ACL_DRIVERS,
  BUILTIN_ACCOUNT_DRIVERS,
  BUILTIN_USAGE_DRIVERS,
  unknownDriverError,
} from "./driver.js";
export type { DataSourceDriver } from "./driver.js";

export { createSourceRegistry } from "./registry.js";
export type { SourceFactory, SourceRegistry } from "./registry.js";

export { DEFAULT_QUOTA_WINDOW, quotaWindow, windowKey } from "./quota-window.js";
export type { QuotaWindow } from "./quota-window.js";

// ---------------------------------------------------------------------------
// 三份数据源
// ---------------------------------------------------------------------------

export * from "./users/index.js";
export * from "./acl/index.js";
export * from "./quota/index.js";
