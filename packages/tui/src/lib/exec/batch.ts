/** @fileoverview `/batch` 的扇出：一条命令 → N 个控制面；⚠️ **一个挂了的那个不许把别的也带走**（三条取舍见 `src/lib/exec/AGENTS.md`） */

import type { BatchPeer, BatchReport, Effect, ExecDeps, ExecResult } from "./run.js";
import { exec } from "./run.js";
import type { Command } from "@/commands/index.js";
import type { LogRow } from "@/lib/log/index.js";

/** 一条命令 → N 份结果（**永不抛**：⚠️ 一个目标的失败必须变成它自己那一档，而不是让整批消失） */
export async function fanOut(
  command: Command,
  peers: readonly BatchPeer[],
  depsFor: (peer: BatchPeer) => ExecDeps,
): Promise<{ reports: readonly BatchReport[]; effects: readonly Effect[] }> {
  const reports: BatchReport[] = [];
  const effects: Effect[] = [];
  for (const peer of peers) {
    // ⚠️ **`try` 包住每一次**：不包的话第一个挂掉就整批丢失，而「三台里两台成功」必须看得见
    try {
      const result: ExecResult = await exec(command, depsFor(peer));
      reports.push({ name: peer.name, ok: succeeded(result.rows), rows: result.rows });
      effects.push(...result.effects);
    } catch (err) {
      reports.push({ name: peer.name, ok: false, rows: [rowOfCrash(err)] });
    }
  }
  return { reports, effects };
}

/** 这一台**成功了吗**（⚠️ 判据是「`rows` 里一个 `err` 都没有」，**不是**「`exec` 没抛」） */
// `exec` 把控制面的失败**收进行里**而很少抛出去，故「没抛」几乎恒真 ——
// 拿它当 `ok` 的话屏上永远是「N 台全部成功」，而那是一句**假事实**
function succeeded(rows: readonly LogRow[]): boolean {
  return !rows.some((row) => row.kind === "err");
}

/** 一次崩了 → 那一档要说清楚是「**这一台**」崩了（⚠️ 只取 `err.name`，不转述 `message`） */
function rowOfCrash(err: unknown): LogRow {
  return {
    kind: "err",
    text: `这一台在执行这条命令时崩了（不是控制面的回答）：${err instanceof Error ? err.name : "未知"}`,
  };
}