/**
 * @fileoverview 把一次失败变成一行字（零 React、零终端）
 * @module app/failures
 * @description
 * ⚠️ 这与 `@/exec/run.ts:controlFailure` / `ledgerFailure` 是三份同一种形状的实现，被目录形状逼出来
 * 的（执行层是纯函数、不挂 React，而本层没法被纯函数层 import）。三处都不许引用 token 的内容，
 * 也不许转述非 `LedgerError` 的异常：那串字节可能带得出下层的凭据。
 */

import type { ParseResult } from "@/cmd/index.js";
import { LedgerError, readLedger, type Ledger } from "@/ledger/index.js";
import { dropped, type LogRow } from "@/log/index.js";

import { LOG_KEEP, type Bucket } from "./state.js";

/** 一次失败 → 一句话 */
export function describe(err: unknown): string {
  if (err instanceof LedgerError) return `台账 ${err.code}：${err.message}`;
  return "本包遇到一个未预期的错误（不是控制面的回答，请查本包的问题）";
}

/** 台账读不出来时给 `null`（**不抛**）：写完盘紧接着刷新内存那一份，读失败就留着旧的那份 */
export function readLedgerSafe(file: string): Ledger | null {
  try {
    return readLedger(file);
  } catch {
    return null;
  }
}

/**
 * 按**显示名**找目标 `id`（`target switch <名字>` / `target del <名字>` 的落点）
 * @description ⚠️ 名字**可以重复**，故这里取**第一个**匹配并把这一个选择**说出口**：静默取第一个
 * 是对的，而**不说**就会让操作者以为「我切到了第二个」。
 * @throws {LedgerError} 台账里没有这个名字
 */
export function idOfName(ledger: Ledger | null, name: string): string {
  const found = ledger?.targets.find((one) => one.name === name);
  if (found === undefined) throw new LedgerError("invalid-target", "台账里没有这个名字的控制面");
  return found.id;
}

/** 结果区底部那一行：被环形缓冲丢掉的最早一条是第几条（`null` = 没丢过） */
export function droppedHint(bucket: Bucket): string | null {
  const first = dropped(bucket.entries, LOG_KEEP);
  return first === 0 ? null : `（更早的 ${first - 1} 条已被丢弃）`;
}

/**
 * 解析失败 → 若干行
 * @description ⚠️ **文案里没有用户输入**：凭据敲错一个字符时，「你输入错了：x#k2」会把凭据
 * 抄进可滚动、可复制的结果区。
 */
export function rowsOfFailure(failed: Exclude<ParseResult, { kind: "ok" }>): LogRow[] {
  switch (failed.kind) {
    case "empty":
      return [];
    case "missing-prefix":
    case "unknown-command":
      return [
        { kind: "err", text: failed.message },
        ...(failed.suggestions.length > 0
          ? [{ kind: "note" as const, text: `是不是想写 ${failed.suggestions.join(" / ")}？` }]
          : []),
      ];
    case "bad-args":
    case "bad-value": {
      const rows: LogRow[] = [{ kind: "err", text: failed.message }];
      if (failed.usage !== null) rows.push({ kind: "note", text: `用法：${failed.usage}` });
      return rows;
    }
  }
}
