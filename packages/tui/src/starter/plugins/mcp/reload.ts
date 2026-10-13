/**
 * @fileoverview 重载的**判定**：一张配置表 + 现有的表 ⇒「谁关掉、谁重开、谁原样留着」
 * @module starter/plugins/mcp/reload
 * @description
 * 本文件**只判定、不动手**：零 IO、不碰 `ctx`、不 await 任何东西。算出来的单子由
 * `@/starter/plugins/mcp/table.js` 执行。拆开是因为这一段的价值全在那几条规则上，
 * 而它们夹在一堆 `await` 之间时没人读得下去。
 *
 * ## 三条规则（每条都有非它不可的理由）
 * 1. **运行期 `register` 进来的原样保留**（既不关也不重开）：它们的配置不来自配置文件，
 *    重启它们没有道理——「重载」动的是**配置驱动**的那一份。
 * 2. **配置里已经删掉 / 改名了的 ⇒ 关掉并从表里移除**：留着就是一条僵尸（会话还在、工具还在，
 *    但没人能在配置里指着它）。更糟的是下一次重载还会把它当成「配置里有的」而反复重启。
 * 3. **配置里有的照配置重开**；表里已有的**就地换配置再起**（`existing`），没有的**新建一行**。
 *    ⚠️ 「就地」是刻意的：换对象会让「重载进行中」这件事失去锚点——外面谁还持有那一行，
 *    看到的会是一个已经不属于任何地方的对象。
 *
 * ⚠️ **重载不重读配置文件**——判定的是**当前生效**的表（`ctx.cfg` 里此刻的值）。
 *   `ctx.cfg.reload()` 会丢弃 `set()` 过的内存值，让重载偷偷去调等于越权。要连文件一起重读，
 *   用户自己先 `ctx.cfg.reload()` 再 `ctx.mcp.reload()` 两步走。
 *
 * ⚠️ **规则 1 会盖掉规则 3，而这件事要喊出来**：先 `unregister` 掉配置里那台、再 `register`
 *   同名的一台运行期服务器，是走得通的（表里没这个名字了，`register` 的撞名闸门就放行）。
 *   此时这个名字既在配置里又被运行期占着 ⇒ 按规则 1 保留运行期那份，但这**是配置作者没打算的**，
 *   所以判出来要交给调用方 `warn` 一声，不许静默。
 */

import type { McpServerConfig } from "@/config/agents/defaults.js";
import type { McpTableEntry } from "./table.js";

/** 一台要照配置重开的服务器 */
export interface McpReloadTarget {
  /** 服务器名 */
  readonly name: string;
  /** 当前生效的配置表里它那份 */
  readonly config: McpServerConfig;
  /** 表里已有的那一行；`undefined` = 重载新加进来的（表里没有） */
  readonly existing?: McpTableEntry;
}

/** 判定结果：两张单子 + 一串需要喊一声的冲突 */
export interface McpReloadPlan {
  /** 关掉并从表里移除的名字（规则 2） */
  readonly drop: readonly string[];
  /** 照配置重开的（规则 3；被规则 1 挡住的已剔除） */
  readonly reopen: readonly McpReloadTarget[];
  /** **既在配置里、又已被运行期占名**的名字（规则 1 盖掉了规则 3；见文件头） */
  readonly shadowed: readonly string[];
}

/**
 * 算出重载要做的事。**纯函数**：只看两张表，不改任何一张，也不起任何会话。
 * @param entries - 表里的全部行（迭代器即可，本函数不持有它）
 * @param fromConfig - 当前生效的 `agents.mcpServers`
 */
export function planReload(
  entries: Iterable<readonly [string, McpTableEntry]>,
  fromConfig: Readonly<Record<string, McpServerConfig>>,
): McpReloadPlan {
  // ⚠️ **先把整张表铺开成一张 map**，再据此分三处判定。分三遍扫同一个迭代器当然也行，
  //   但那样「运行期的钉住谁」「配置里还有谁」就得在三处各写一遍同样的过滤——漏一处
  //   就是一台服务器被重启两次，而重启两次的代价是「白起一遍 + 工具换了一批没人看见」。
  const byName = new Map(entries);
  const pinned = new Set([...byName].filter(([, e]) => e.source === "runtime").map(([n]) => n));

  const drop: string[] = [];
  for (const [name, entry] of byName) {
    // 规则 2：配置里没有它了。⚠️ `pinned` 那张是运行期的，压根不归这条管（规则 1 保留它们）。
    if (entry.source !== "runtime" && !(name in fromConfig)) drop.push(name);
  }

  const shadowed: string[] = [];
  const reopen: McpReloadTarget[] = [];
  for (const [name, config] of Object.entries(fromConfig)) {
    if (pinned.has(name)) {
      // 规则 1 赢，但要留痕（见文件头 ⚠️）
      shadowed.push(name);
      continue;
    }
    const existing = byName.get(name);
    reopen.push(existing === undefined ? { name, config } : { name, config, existing });
  }
  return { drop, reopen, shadowed };
}