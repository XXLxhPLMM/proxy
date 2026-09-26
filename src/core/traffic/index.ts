/**
 * @fileoverview 流量配额层出口
 * @module core/traffic
 * @description
 * 端口（`./types.ts`）+ 窗口键（`./window.ts`）+ 内存账本（`./memory.ts`）+ 计量落点（`./meter.ts`）
 * + 落盘账本（`./ledger.ts` 格式与 IO / `./flush-loop.ts` 唯一的定时器站点）。
 *
 * 跨目录引用**一律走本 barrel**（`@/core/traffic/index.js`），与 `@/core/helpers/index.js`、
 * `@/config/files/rules/index.js` 同一纪律：目录重构时调用方零改动。
 *
 * 装配纪律：
 * - **默认实现（读 `users.json` 的内存账本 + 它的落盘副本）只在唯一组装点解析**
 *   （`runtime/services.ts` 经 `createProxyRuntime`），core 与转发层拿到的永远是**已注入的
 *   端口实例**。
 * - 直构 core（测试 / 低层调用方）不注入时用 {@link inertTrafficAccount} 这一个**显式禁用档**，
 *   与 `BaseProxy` 里 `auth ?? new Auth({ enabled: false })` 同构。
 * - **落盘账本零配置依赖**：目录/间隔/窗口/「有没有配额」全部由装配点以闭包注入。
 *   `core/**` 与 `runtime/**` 一律不读 `process.env`（槽位是显式参数，见 `TRAFFIC_SLOT_ENV`）。
 */

export type {
  QuotaResolver,
  RestoredLedger,
  RestoredUsage,
  TrafficAccount,
  TrafficDirection,
  TrafficLedgerController,
  TrafficLedgerError,
  TrafficScope,
  TrafficSink,
  TrafficUsage,
  TrafficVerdict,
  UserQuota,
} from "./types.js";

export { DEFAULT_QUOTA_WINDOW, quotaWindow, windowKey } from "./window.js";
export type { QuotaWindow } from "./window.js";

export { MemoryTrafficAccount, createMemoryTrafficAccount, inertTrafficAccount } from "./memory.js";
export type { TrafficWindowSource } from "./memory.js";

export {
  DEFAULT_LEDGER_COMPACT_BYTES,
  DEFAULT_TRAFFIC_SLOT,
  JsonlTrafficLedger,
  TRAFFIC_SLOT_ENV,
  compactEntries,
  ledgerFileName,
  normalizeSlot,
  parseLedger,
  summarizeCurrent,
} from "./ledger.js";
export type { JsonlTrafficLedgerOptions, LedgerEntry } from "./ledger.js";

export { startFlushLoop } from "./flush-loop.js";
export type { FlushLoopHandle } from "./flush-loop.js";

export { meterStream, openLinkMeter } from "./meter.js";
export type {
  BufferedCharge,
  ByteSource,
  QuotaExceededHandler,
  StreamMeter,
} from "./meter.js";
