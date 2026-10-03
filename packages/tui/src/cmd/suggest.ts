/**
 * @fileoverview 「你是不是想写…」：敲错命令名时给最接近的几条
 * @module cmd/suggest
 * @description
 * 本文件只回答「哪几个名字离敲出来的那一串最近」，与分词、参数校验无关。三个排序判据全部是「两个
 * 字符串」的纯函数，故结果只由它们决定 —— ⚠️ **不按「哪个更常用」**：那会随实现细节漂移，而调用方
 * 拿到的顺序只需要**稳定**。
 */

import { COMMAND_PREFIX, TOP_LEVEL_NAMES } from "./specs.js";

/** 相邻换位算一次编辑（`staus` → `status` 只算 1 —— 不然一个手滑的换位会给不出建议） */
function editDistance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) rows.push([i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) (rows[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        (rows[i - 1] as number[])[j] as number,
        (rows[i] as number[])[j - 1] as number,
        (rows[i - 1] as number[])[j - 1] as number,
      );
      // 换位：斜着再退一格（只看紧邻的那一对）
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, ((rows[i - 2] as number[])[j - 2] as number) + 1);
      }
      (rows[i] as number[])[j] = best + cost;
    }
  }
  return (rows[a.length] as number[])[b.length] as number;
}

/** 两个字符串的公共前缀长度（排序的第二判据，见 {@link suggestCommands}） */
function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/** 建议最多给几个 */
const SUGGEST_LIMIT = 3;

/** 短到不可能是手滑的输入（1–2 个字母）一律不给建议：那时候的「接近」全是噪声 */
const SHORTEST_SUGGESTABLE = 3;

/**
 * 最接近的那几个命令名
 * @description 编辑距离小的在前（相邻换位算一次）；同距离时公共前缀长的在前（`usr` 该指向 `users`
 * 而不是 `r`）；还一样就按**候选自身的字典序**。距离上限随长度长（`2` 起、`3` 封顶）。
 *
 * @param typed - 用户敲的那一段（**不**出现在任何失败文案里，见 `./values.js` 文件头那条纪律）
 * @param pool - 候选池（缺省 = 第一段命令名）
 */
export function suggestCommands(
  typed: string,
  pool: readonly string[] = TOP_LEVEL_NAMES,
): readonly string[] {
  const text = typed.trim().toLowerCase();
  if (text.length < SHORTEST_SUGGESTABLE) return [];
  const limit = Math.min(3, Math.max(2, Math.floor(text.length / 2)));
  return pool
    .map((name) => ({ name, distance: editDistance(text, name) }))
    .filter((one) => one.distance <= limit)
    .sort(
      (x, y) =>
        x.distance - y.distance ||
        commonPrefixLength(text, y.name) - commonPrefixLength(text, x.name) ||
        (x.name < y.name ? -1 : x.name > y.name ? 1 : 0),
    )
    .slice(0, SUGGEST_LIMIT)
    .map((one) => one.name);
}

/**
 * 命令名数组 → **给人看**的路径数组（每个前面补上 {@link COMMAND_PREFIX}）
 * @description ⚠️ 「给人看」这件事只许有**这一个**出口：错误文案、`help`、命令面板三处都读它，而它们
 * 拿到的是**命令名**。写成三处 `"/" + name` 漂出来的症状是「建议里写 `/status`、回车却因为少个斜杠
 * 被拒」。
 *
 * @param names - 命令名（**不带**前缀）
 */
export function withPrefix(names: readonly string[]): readonly string[] {
  return names.map((one) => COMMAND_PREFIX + one);
}