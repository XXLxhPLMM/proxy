/**
 * @fileoverview 台账的**数据契约**：一份控制面端点清单 + 一份提供商清单（每份带一份模型清单）+ 会话级的模型选择
 */

// ⚠️ **`ManagerTarget` 住在 `@/api`**（那边是拨号的那一层，而 `ManagerTarget` 就是它要的入参形状）——
// 不是从 `@/services` 转出：台账这一格是**数据**，而拨号那一侧已经不在本目录了。
import type { ManagerTarget } from "@/api/index.js";
// ⚠️ **四档与缺省的定义住在 `@/store` 而这里只转出**：它是 `Session.reasoning` 那一格的取值闭集，
// 而那一格的缺省必须与 `newSession` 同住一处。⚠️ 转出而不是搬走：建表那一列与读写两面的缺省、
// 模型请求那几档的参数名全走本文件的出口 —— 那些调用方不许被一次搬家连坐。
import { DEFAULT_REASONING_EFFORT, REASONING_EFFORTS, type ReasoningEffort } from "@/store/index.js";

export { DEFAULT_REASONING_EFFORT, REASONING_EFFORTS, type ReasoningEffort };

/** 台账里的一个控制面端点 */
// ⚠️ **`token` 等价于主机上的 root shell**，故本类型的任何字段都**不许**进日志 / 错误文案 / 快照。
export interface Target extends ManagerTarget {
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

/** {@link ./edit.ts:upsertTarget} 的入参：给 `id` = 改那条，不给 = 新建 */
export type UpsertInput = TargetInput & { readonly id?: string };

/** 模型 API 格式 —— 决定用哪套请求形状去问模型 */
export type ModelApiFormat = "openai" | "anthropic" | "gemini";

/** 全部 API 格式（⚠️ **顺序 = 下拉框顺序**，增档要顺带想清楚插在哪一档） */
export const MODEL_API_FORMATS: readonly ModelApiFormat[] = ["openai", "anthropic", "gemini"];

/** 落盘的一个提供商 */
// ⚠️ **`apiKey` 与 {@link Target.token} 同级**，故它一个字都不许进日志 / 错误文案 / 快照
export interface ProviderRecord {
  /** 稳定标识；⚠️ **不许含 `/`**（模型存储键按第一个 `/` 切，含了会把键切错，见 {@link splitModelRef}） */
  readonly id: string;
  /** 显示名（非空、trim 后不超过 {@link NAME_MAX_LEN}） */
  readonly name: string;
  /** ⚠️ **不归一**（provider 可以是任何兼容端点；`normalizeBaseUrl` 是控制面那份判据） */
  readonly baseUrl: string;
  readonly api: ModelApiFormat;
  readonly apiKey: string;
}

/** 落盘的一个模型（⚠️ `pinned` 是**全局**置顶，不按会话） */
export interface ModelRecord {
  readonly providerId: string;
  /** 协议标识，**可含 `/`**（openrouter 的 `anthropic/claude-x`） */
  readonly modelId: string;
  /** 显示名（可改；`modelId` 是协议标识，不给人改） */
  readonly label: string;
  readonly pinned: boolean;
}

/** 一个会话选中的模型与推理强度（⚠️ 与会话的身份那几列分开读，故那一侧的形状一个字都不用动） */
export interface SessionModelRef {
  readonly modelRef: string | null;
  readonly reasoning: ReasoningEffort;
}

/** 模型存储键 → providerId + modelId（`null` = 这不是一个键）；⚠️ **按第一个 `/` 切**（不是 `split("/")`，`modelId` 自己可含 `/`） */
export function splitModelRef(ref: string): { providerId: string; modelId: string } | null {
  const at = ref.indexOf("/");
  // ⚠️ `at < 1` 一句判两件事：没有 `/`，以及 providerId 是空串（两种都构不成一个键）
  if (at < 1) return null;
  const modelId = ref.slice(at + 1);
  return modelId === "" ? null : { providerId: ref.slice(0, at), modelId };
}

/** providerId + modelId → 模型存储键；⚠️ `providerId` 含 `/` 时**抛**（那一对参数自相矛盾，而「选中了另一个模型」屏上看不出来） */
// 抛的是编程错误而不是用户输入错误，故不是 `LedgerError` 那一档
export function joinModelRef(providerId: string, modelId: string): string {
  if (providerId === "" || providerId.includes("/")) {
    throw new Error("providerId 必须非空且不含「/」");
  }
  if (modelId === "") throw new Error("modelId 不能为空");
  return `${providerId}/${modelId}`;
}