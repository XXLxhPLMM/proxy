/** @fileoverview 一次失败 → 给人看的那几行；⚠️ **失败文案一个字节的用户输入都不许进去**（token 与密码经过这里落进可滚动的结果区） */

import type { LogRow, LogTone } from "@/lib/log/index.js";
import { TuiError, isRetryable, type TuiCode } from "@/lib/index.js";
import type { ExecResult } from "./run.js";

/** 只有若干行、没有副作用的成品 */
export function plain(rows: readonly LogRow[]): ExecResult {
  return { rows, effects: [] };
}

const NO_TARGET_TEXT = "先在左边选一个控制面（这一条要访问控制面，现在没有客户端）";

/** 什么都没选中时的那一句（不许在这里发请求，见 `./run.js` 文件头） */
export function noTarget(): ExecResult {
  return plain([{ kind: "err", text: NO_TARGET_TEXT }]);
}

/** ⚠️ 刻意**不**转述 `err.message`、更不转述堆栈（那个串来自本包某一层，可能顺手带出下层的字节） */
function unknownFailure(): LogRow {
  return {
    kind: "err",
    text: "本包遇到一个未预期的错误（不是控制面的回答，请查本包的问题）",
  };
}

/** 失败码（{@link TuiCode}）→ 色档（呈现决定，故在本层） */
function toneOfCode(code: TuiCode): LogTone {
  if (code === "unauthorized" || code === "timeout") return "warn";
  return "danger";
}

/** 一次控制面失败 → 人读的判据；⚠️ `requestId` 缺省时**不编一个**（编一个 id 比没有更糟：它会让人去 grep 一条不存在的日志） */
export function controlFailure(err: unknown): readonly LogRow[] {
  if (!(err instanceof TuiError)) return [unknownFailure()];
  const text =
    err.requestId === null
      ? `${err.code}：${err.message}`
      : `${err.code}：${err.message}（requestId ${err.requestId}）`;
  const rows: LogRow[] = [{ kind: "err", text, tone: toneOfCode(err.code) }];
  if (isRetryable(err)) rows.push({ kind: "note", text: "可重试：按 r 再来一次" });
  return rows;
}

/** 把一次异步动作包成「要么若干行，要么一句判据」 */
export async function attempt(work: () => Promise<readonly LogRow[]>): Promise<readonly LogRow[]> {
  try {
    return await work();
  } catch (err) {
    return controlFailure(err);
  }
}