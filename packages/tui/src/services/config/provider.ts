/**
 * @fileoverview 模型 provider 的**读写面**：一份提供商清单（`providers`）+ 每份一份模型清单（`provider_models`）
 * @description 凭据与 `targets.token` 同级，故防线同一条：`0600` 库 + `0700` 目录 + 打码出口唯一
 */
// ⚠️ 打码出口只有 `redactProviderView` 一处（`targets.token` 那一条同规格）

import fs from "node:fs";
import { LedgerError, validateModelRecord, validateProviderRecord } from "./validate.js";
import { openLedgerDb } from "./db.js";
import {
  deleteProviderModelRow,
  deleteProviderModelRows,
  deleteProviderRow,
  readProviderModelRows,
  readProviderRows,
  upsertProviderRow,
  writeProviderModelRows,
  writeProviderRows,
} from "./tables.js";
import { transact } from "./store.js";
import type { ModelRecord, ProviderRecord } from "./types.js";

/**
 * 可以放心显示的提供商
 * @description 与 {@link ProviderRecord} 同形，**除了** `apiKey`：那一位是 {@link REDACTED_PROVIDER_KEY} 或空串。
 * 做成独立类型是为了让「界面拿到的东西」与「真凭据」在类型上就分得开。
 */
export interface ProviderView extends Omit<ProviderRecord, "apiKey"> {
  /** 配了凭据时恒为 {@link REDACTED_PROVIDER_KEY}；**空串保持空串**（不是星号） */
  readonly apiKey: string;
}

/** 打码后的 provider 凭据占位符（⚠️ 与 `REDACTED_TOKEN` **同一个形状**：两个不同的真凭据不许看起来一样长） */
export const REDACTED_PROVIDER_KEY = "••••";

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 落盘的提供商清单（⚠️ 顺序恒等于 `rowid` = 插入序；库不存在 ⇒ 空清单且**不**因此创建那个库） */
export function readProviders(file: string): readonly ProviderRecord[] {
  if (!fs.existsSync(file)) return [];
  try {
    return readProviderRows(openLedgerDb(file)).map((row, index) =>
      validateProviderRecord(row, `providers[${index}]`),
    );
  } catch (err) {
    throw new LedgerError("unreadable", `提供商清单读不出来（${file}）：${why(err)}`);
  }
}

/** 整份提供商清单换掉（**一次事务**：不在清单里的那些提供商连同它们的模型先级联删掉，再按数组序插回去） */
// ⚠️ 级联删**必须在**换清单之前：被换掉的那几行 provider 随后就没了，而它们的模型行还在
export function writeProviders(file: string, list: readonly ProviderRecord[]): void {
  const checked = list.map((one, index) => validateProviderRecord(one, `providers[${index}]`));
  const kept = new Set(checked.map((one) => one.id));
  transact(file, "提供商清单存不进去", (db) => {
    for (const row of readProviderRows(db)) {
      const id = row["id"];
      if (typeof id === "string" && !kept.has(id)) deleteProviderModelRows(db, id);
    }
    writeProviderRows(db, checked);
  });
}

/** 新增或改一个提供商（⚠️ 新增与编辑**同一个入口**：那条形别在 `id` 上，故落盘是一次 UPSERT） */
export function upsertProvider(file: string, record: ProviderRecord): void {
  const checked = validateProviderRecord(record);
  try {
    upsertProviderRow(openLedgerDb(file), checked);
  } catch (err) {
    throw new LedgerError("unreadable", `提供商存不进去（${file}）：${why(err)}`);
  }
}

/** 删一个提供商**连同它的全部模型**（删一个不存在的 `id` 是**成功的一次 no-op**） */
export function removeProvider(file: string, id: string): void {
  transact(file, "提供商删不掉", (db) => {
    deleteProviderModelRows(db, id);
    deleteProviderRow(db, id);
  });
}

/** 某个提供商的模型清单（⚠️ 顺序恒等于 `rowid` = 写入顺序；库不存在 ⇒ 空清单） */
export function readProviderModels(file: string, providerId: string): readonly ModelRecord[] {
  if (!fs.existsSync(file)) return [];
  try {
    return readProviderModelRows(openLedgerDb(file), providerId).map((row, index) =>
      validateModelRecord(row, `provider_models[${index}]`),
    );
  } catch (err) {
    throw new LedgerError("unreadable", `模型清单读不出来（${file}）：${why(err)}`);
  }
}

/** 某个提供商的整份模型清单换掉（**一次事务**；`providerId` 与每条自带的 `providerId` 必须一致，不一致即拒） */
// ⚠️ 那道一致性判据不是洁癖：两者不一致时**要么**按参数写（`model.providerId` 被静默忽略）
// **要么**按记录写（模型落到另一个提供商名下），两种解释都会让「保存之后模型不见了」变成静默事故
export function writeProviderModels(
  file: string,
  providerId: string,
  models: readonly ModelRecord[],
): void {
  const checked = models.map((one, index) => validateModelRecord(one, `provider_models[${index}]`));
  const stray = checked.filter((one) => one.providerId !== providerId);
  if (stray.length > 0) {
    throw new LedgerError("unreadable", "模型所属的提供商与要保存的那一个不一致（文案不转述任何一格）");
  }
  transact(file, "模型清单存不进去", (db) => writeProviderModelRows(db, providerId, checked));
}

/** 从某个提供商的清单里去一个模型（去一个不在清单上的 `(provider, model)` 是**成功的一次 no-op**） */
export function removeModel(file: string, providerId: string, modelId: string): void {
  transact(file, "模型删不掉", (db) => deleteProviderModelRow(db, providerId, modelId));
}

/** 给界面看的那一份提供商（**唯一的打码出口**，与 `redactTarget` 同一条纪律） */
export function redactProviderView(record: ProviderRecord): ProviderView {
  const { apiKey, ...rest } = record;
  return { ...rest, apiKey: apiKey === "" ? "" : REDACTED_PROVIDER_KEY };
}