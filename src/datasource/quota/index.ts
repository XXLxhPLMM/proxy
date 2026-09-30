/**
 * @fileoverview 配额用量数据源层出口（`datasource/quota/` 的唯一对外出口）
 * @module datasource/quota
 * @description
 * **权威总量住在这一侧**：端口（`./types.js`）+ 进程内镜像与判定（`./mirror.js`）+ 两个内置
 * 驱动（`./sqlite-source.js` / `./jsonl-source.js`）+ 驱动注册表（`./registry.js`）+ 周期驱动
 * （`./flush-loop.js`）。窗口键（`@/datasource/quota-window.js`）是**本层根上**那份，账号表与
 * 账本共用它——两边必须有同一份定义，而代理层不是它们的公共祖先。
 *
 * 跨目录引用**一律走本 barrel**（`@/datasource/quota/index.js`），与 `@/core/helpers/index.js`、
 * `@/config/index.js` 同一纪律：目录重构时调用方零改动。
 *
 * 装配纪律：默认实现（读账号表 `quota` 的镜像 + 注册表选出的数据源）只在唯一组装点
 * `runtime/services.ts:buildDefaultServices` 解析，core 与转发层拿到的永远是**已注入的端口
 * 实例**；直构 core（测试 / 低层调用方）不注入时用 {@link inertUsageAccount} 这一个**显式
 * 禁用档**（与 `identity` 的 `noneIdentity()` 先例完全同构）。
 *
 * **数据源零配置依赖**：目录 / 周期 / 窗口口径 / 「有没有配额」/ 两个旁路全由
 * {@link UsageSourceSpec} 的平值闭包注入，装配层负责从 `ConfigAccessor` 取值。本层
 * **零 `@/config` / 零 `@/core` / 零 `@/runtime` / 零 `@/server` import**（护栏：
 * `tests/unit/traffic-ledger.test.ts`）。
 *
 * **计量落点不在这里**：在代理的数据面上「在源流上挂被动 `data` 监听器」是 core 的事
 * （`@/core/quota-meter.js`），它消费本层的 {@link UsageAccount} 端口。数据源层不 import
 * `node:stream`，判定层也不必为「字节从哪条流上来」操心。
 */

export type {
  QuotaResolver,
  TrafficDirection,
  TrafficVerdict,
  UsageAccount,
  UsageQuota,
  UsageSink,
  UsageSnapshot,
  UsageSource,
  UsageSourceController,
  UsageSourceError,
  UsageSourceFactory,
  UsageSourceSpec,
  WindowUsage,
} from "./types.js";

export {
  UsageMirror,
  createUsageMirror,
  inertUsageAccount,
  mirrorLagBoundMs,
} from "./mirror.js";
export type { QuotaWindowSource } from "./mirror.js";

export { clampFlushIntervalMs, startFlushLoop } from "./flush-loop.js";
export type { FlushLoopHandle } from "./flush-loop.js";

export { LEDGER_DB_NAME, SqliteUsageSource, ledgerFileName } from "./sqlite-source.js";
export type { SqliteUsageSourceOptions } from "./sqlite-source.js";

// 账本的 **json 档**：单进程部署 / 需要「账本人肉可读 + 能用 shell 统计」时用
// （`QUOTA_LEDGER_DRIVER=json` 选中它，而它是**缺省**）。它与 sqlite 档的多进程判定语义
// **完全相同**（都靠进程内镜像 + 周期回读），差别只在「累加是不是数据库内部的原子操作」与
// 「回读是不是 O(全文件)」，两者都写在各自文件头。
export {
  DEFAULT_LEDGER_COMPACT_BYTES,
  JSONL_LEDGER_FILE_NAME,
  JsonlUsageSource,
  compactEntries,
  parseLedger,
  sharedLedgerFileName,
  summarizeCurrent,
} from "./jsonl-source.js";
export type { JsonlUsageSourceOptions, LedgerEntry } from "./jsonl-source.js";

export {
  hasUsageSource,
  listUsageSourceDrivers,
  registerUsageSource,
  resolveUsageSource,
} from "./registry.js";

export { DEFAULT_QUOTA_WINDOW, quotaWindow, windowKey } from "@/datasource/quota-window.js";
export type { QuotaWindow } from "@/datasource/quota-window.js";
