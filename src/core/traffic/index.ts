/**
 * @fileoverview 流量配额层出口
 * @module core/traffic
 * @description
 * 端口（`./types.ts`）+ 窗口键（`./window.ts`）+ 内存账本（`./memory.ts`）+ 计量落点（`./meter.ts`）
 * + 落盘账本（`./sqlite-ledger.ts` 表结构与 IO / `./flush-loop.ts` 唯一的定时器站点）。
 *
 * 跨目录引用**一律走本 barrel**（`@/core/traffic/index.js`），与 `@/core/helpers/index.js`、
 * `@/config/files/rules/index.js` 同一纪律：目录重构时调用方零改动。
 *
 * 装配纪律：默认实现（读 `users.json` 的内存账本 + 它的
 * 落盘副本）只在唯一组装点 `runtime/services.ts:buildDefaultServices` 解析，core 与转发层
 * 拿到的永远是**已注入的端口实例**；直构 core（测试 / 低层调用方）不注入时用
 * {@link inertTrafficAccount} 这一个**显式禁用档**（与 `identity` 的 `noneIdentity()` 先例
 * 完全同构）；落盘账本零配置依赖——目录/间隔/窗口/「有没有配额」全由装配点以闭包注入，
 * 且 `core/**` 与 `runtime/**` 一律不读 `process.env`。
 *
 * **账本是所有进程共用的同一个 SQLite 文件**：没有「槽位」这个概念，故本 barrel 不再
 * 转出 `TRAFFIC_SLOT_ENV` / `normalizeSlot` / `JsonlTrafficLedger`（分槽正是那个让配额
 * 变成「每进程一份」的根因，理由见 `./sqlite-ledger.ts` 文件头）。
 */

export type {
  QuotaResolver,
  RestoredLedger,
  RestoredUsage,
  TrafficAccount,
  TrafficDirection,
  TrafficLedger,
  TrafficLedgerController,
  TrafficLedgerError,
  TrafficSink,
  TrafficVerdict,
  UserQuota,
} from "./types.js";

export { DEFAULT_QUOTA_WINDOW, quotaWindow, windowKey } from "./window.js";
export type { QuotaWindow } from "./window.js";

export { MemoryTrafficAccount, createMemoryTrafficAccount, inertTrafficAccount } from "./memory.js";
export type { TrafficWindowSource } from "./memory.js";

export { LEDGER_DB_NAME, SqliteTrafficLedger, ledgerFileName } from "./sqlite-ledger.js";
export type { SqliteTrafficLedgerOptions } from "./sqlite-ledger.js";
// 账本的 **json 档**：单进程部署 / 需要「账本人肉可读 + 能用 shell 统计」时用
// （`QUOTA_LEDGER_DRIVER=json` 选中它）。它的多进程语义缺口（文本文件没有写锁，账号级封禁
// 在 cluster 下会退化成每进程一份）写在 `JsonlTrafficLedgerOptions.slot` 的注释里 ——
// 所以它是**备选实现**，不是默认。
export {
  DEFAULT_LEDGER_COMPACT_BYTES,
  JSONL_LEDGER_FILE_NAME,
  JsonlTrafficLedger,
  compactEntries,
  parseLedger,
  sharedLedgerFileName,
  summarizeCurrent,
} from "./jsonl-ledger.js";
export type { JsonlTrafficLedgerOptions, LedgerEntry } from "./jsonl-ledger.js";

export { startFlushLoop } from "./flush-loop.js";
export type { FlushLoopHandle } from "./flush-loop.js";

export { meterStream, openLinkMeter } from "./meter.js";
export type {
  BufferedCharge,
  ByteSource,
  QuotaExceededHandler,
  StreamMeter,
} from "./meter.js";
