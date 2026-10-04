/**
 * @fileoverview 模型 provider 的**读面与写面**：三样东西（地址 / 模型名 / 凭据）落在 `meta` 里，而判据在 `./validate.ts`
 * @description **凭据与 `targets.token` 同级**（配了它，模型才有资格让本包去动控制面）
 * @description 故防线同一条：`0600` 库 + `0700` 目录 + **绝不进文案、日志、快照**
 */

import fs from "node:fs";
import { LedgerError, validateProviderInput } from "./validate.js";
import { openLedgerDb } from "./db.js";
import { readProviderRow, writeProviderField, type ProviderRow } from "./tables.js";
import type { ProviderInput, ProviderSettings } from "./types.js";

/**
 * 读 provider 那三样东西（**库不存在 ⇒ 全 `null`**：没配就是没配，而本函数**不**因此创建那个库）
 * @throws {LedgerError} `unreadable`：库打不开 / 表的列不对 / 查询失败
 */
export function readProvider(file: string): ProviderSettings {
  if (!fs.existsSync(file)) return { baseUrl: null, model: null, apiKey: null };
  let row: ProviderRow;
  try {
    row = readProviderRow(openLedgerDb(file));
  } catch (err) {
    throw new LedgerError("unreadable", `provider 读不出来（${file}）：${why(err)}`);
  }
  return row;
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 写 provider 那三样东西（**一次事务**；三行**各自** UPSERT，于是「只改地址」不清掉凭据）
 * @throws {LedgerError} `unreadable`：形状不对（拒写）/ 库写不出去
 */
export function writeProvider(file: string, input: ProviderInput): void {
  // ⚠️ 落盘的字节恒是校验过的形态，故校验**先**于开事务（与 `writeLedger` 同一条纪律）
  const checked = validateProviderInput(input);
  const db = openLedgerDb(file);
  try {
    db.run("BEGIN");
  } catch (err) {
    throw new LedgerError("unreadable", `provider 写不出去（${file}）：${why(err)}`);
  }
  try {
    writeProviderField(db, "baseUrl", checked.baseUrl);
    writeProviderField(db, "model", checked.model);
    writeProviderField(db, "apiKey", checked.apiKey);
    db.run("COMMIT");
  } catch (err) {
    try {
      db.run("ROLLBACK");
    } catch {
      // 回滚失败不盖掉原来那个错：它才是这次写真正的原因
    }
    throw new LedgerError("unreadable", `provider 写不出去（${file}）：${why(err)}`);
  }
}

/**
 * 给界面看的那一份 provider（**唯一的打码出口**，与 `redactTarget` 同一条纪律）
 * @description **「没配」与「配了但不给你看」渲染成不同的东西**：空串保持空串
 */
export function redactProvider(provider: ProviderSettings): ProviderSettings {
  return {
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiKey: provider.apiKey === "" ? "" : REDACTED_PROVIDER_KEY,
  };
}

/** 打码后的 provider 凭据占位符（⚠️ 与 `REDACTED_TOKEN` **同一个形状**：两个不同的真凭据不许看起来一样长） */
export const REDACTED_PROVIDER_KEY = "••••";