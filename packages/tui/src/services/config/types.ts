/**
 * @fileoverview 台账的**数据契约**：一个 target = 一个控制面端点 = 一个地址 + 一份凭据；⚠️ `timeoutMs` 住在 target 上而不做成全局设置（跨机房时两个数量级的超时共存是常态）
 */

import type { ManagerEndpoint } from "@/services/index.js";

/** 台账里的一个控制面端点 */
// ⚠️ **`token` 等价于主机上的 root shell**，故本类型的任何字段都**不许**进日志 / 错误文案 / 快照。
export interface Target extends ManagerEndpoint {
  /** 台账内唯一，人读 slug（`[a-z0-9-]`）——它是 `selected` 指的那种引用，故不许含路径分隔符 */
  readonly id: string;
  /** 人给的显示名（非空、trim 后不超过 {@link NAME_MAX_LEN}、不含控制字符） */
  readonly name: string;
  /** ⚠️ 归一后的基址（`http(s)://host:port`，无尾斜杠）；恒等于 `normalizeBaseUrl` 的产物 */
  readonly baseUrl: string;
}

/** 一份台账（`version` 是**数字字面量 1**：本仓零兼容，故「不是 1」= 这份库不是本包写的） */
export interface Ledger {
  readonly version: 1;
  /** 上次选中的 target `id`；`null` = 一个都没选 */
  readonly selected: string | null;
  readonly targets: readonly Target[];
}

/** 新建 target 时的默认单次请求超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 5000;

/** 超时的允许区间（下界挡「一个必然先超时的值」，上界挡「配了个 30 分钟」的值） */
export interface TimeoutBounds {
  readonly min: number;
  readonly max: number;
}

export const TIMEOUT_BOUNDS: TimeoutBounds = { min: 200, max: 60000 };

export const NAME_MAX_LEN = 64;

/** 用户在界面上填的一个端点（还没有 `id`） */
export interface TargetInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
}

/** provider 的三样东西（⚠️ **每一格都可能是 `null`** = 没配；`apiKey` 与 {@link Target.token} 同级） */
export interface ProviderSettings {
  readonly baseUrl: string | null;
  readonly model: string | null;
  /** ⚠️ **本类型的任何字段都不许进日志 / 错误文案 / 快照**，理由与 `Target.token` 同一条 */
  readonly apiKey: string | null;
}

/** {@link ./provider.ts:writeProvider} 的入参（与 {@link ProviderSettings} 同形：没配的写 `null`） */
export type ProviderInput = ProviderSettings;

/** {@link ./edit.ts:upsertTarget} 的入参：给 `id` = 改那条，不给 = 新建 */
export type UpsertInput = TargetInput & { readonly id?: string };