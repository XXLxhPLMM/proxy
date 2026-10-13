/**
 * @fileoverview 对表的**判定**：库里那些该跑的 vs 表里这些在跑的 ⇒「谁起、谁重开、谁关掉」
 * @module agents/mcp/plan
 * @description
 * 零 IO、不碰 `ctx`、不 await 任何东西，单子由 `./manager.js` 执行。拆开是因为这一段的价值全在那三条规则上，
 * 而它们夹在一堆 `await` 之间时没人读得下去。
 *
 * 1. **表里有、该跑的那批里没有它 ⇒ 关掉并摘掉那一行**（被 `disabled` 或已删）。留着就是一条僵尸：会话还在、
 *    工具还在，却没人在任何地方指着它。
 * 2. **该跑的、表里没有 ⇒ 起**。⚠️ 形状坏了的行也在这一批里，它落成 `failed` 而不是被跳过——**要让用户在
 *    列表里看见它坏了**，跳过就等于把坏行藏起来。
 * 3. **该跑的、表里有的 ⇒ 只有「动过」才重开**（那一行的 `updatedAt` 对不上，或上一轮落的是 `failed`）。
 *    ⚠️ 这一条是**数据源换成库之后才有的**：改一行数据就可能触发对表，全量重开会把每一台都换一批工具
 *    （几十秒，且模型手里那批工具键全变）。「没动过就不动」是对表能成立的前提。
 *
 * ⚠️ **判据是那一行的 `updatedAt`，不是逐字段比配置**：逐字段比就得再写一份「有哪些列参与连接」的清单，
 *   它与 `mcpConfigFromRow` 读的那几列一旦分叉，就会出现「改了却没重开」或「没改却重开」。
 */

import type { ResolvedMcp } from "@/db/dto/mcp.js";
import type { McpEntry } from "./status.js";

/**
 * 一台「按库里那一行**该起**」的服务器。
 * @description ⚠️ **两个分支是两种坏法，不是一份数据的两种写法**：`resolved` 是配置读得出来，`failure` 是
 *   那一行形状坏了（`db/read.js` 的形状闸抛的）。后者照样进单子，只是执行时直接落 `failed`。
 */
export type McpDesired =
  | {
      readonly name: string;
      /** 库里那一行的 `updatedAt`；与 {@link McpEntry.rowStamp} 不等 = 改过了 */
      readonly stamp: number;
      /** 怎么起它 */
      readonly resolved: ResolvedMcp;
    }
  | {
      readonly name: string;
      readonly stamp: number;
      /** 这一行读不出「怎么起它」；⚠️ 照样要出现在列表里，只是落 `failed` */
      readonly failure: Error;
    };

/** 判定结果：两张要起的单子 + 一串要关的名字 */
export interface McpPlan {
  /** 该起、但表里没有的（规则 2；`failure` 分支也在其中） */
  readonly start: readonly McpDesired[];
  /** 该起、表里有的、且**动过**的（规则 3；带着它原来那一行，好让执行方先关掉旧的） */
  readonly reopen: readonly McpDesired[];
  /** 表里有、而该跑的那一批里没有的名字（规则 1） */
  readonly stop: readonly string[];
}

/**
 * 算出对表要做的事。**纯函数**：只看两张单子，不改任何一张，也不起任何会话。
 * @description ⚠️ 两个入参**必须同为本次范围**：`manager.ts` 对单台对表时会把两边都缩到那一个名字，
 *   否则全量对表会把「不在这一批里的名字」全判成该关（规则 1）。
 */
export function planMcp(
  entries: Iterable<readonly [string, McpEntry]>,
  desired: Iterable<McpDesired>,
): McpPlan {
  // ⚠️ 先把入参铺成一张 map 再据此分三处判定：分三遍扫同一个迭代器也行，但那样「谁在跑」「谁该跑」得在
  //   三处各写一遍同样的查表——漏一处就是一台服务器被起两次
  const byName = new Map(entries);
  const start: McpDesired[] = [];
  const reopen: McpDesired[] = [];
  const stop: string[] = [];

  for (const [name] of byName) stop.push(name);
  for (const want of desired) {
    const at = stop.indexOf(want.name);
    // ⚠️ 先从「要关」里划掉：它在「该跑」这一批里，规则 1 就不该管它
    if (at !== -1) stop.splice(at, 1);
    const entry = byName.get(want.name);
    if (entry === undefined) {
      start.push(want);
      continue;
    }
    // 规则 3：动过（戳对不上）或上一轮没起来（重试）
    if (entry.rowStamp !== want.stamp || entry.state === "failed") reopen.push(want);
  }
  return { start, reopen, stop };
}