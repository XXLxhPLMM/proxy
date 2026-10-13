/**
 * @fileoverview 一台服务器的两个形状：表里那一行（运行期）与对外那一行（`ctx.mcp.list()` 交出的）
 * @module agents/mcp/status
 */

import type { McpSession } from "./session.js";

/**
 * 一台此刻的状态：五档，从「有意不起」到「已经能用」。
 * @description `disabled` = **这一行被标了不自动起**，本进程压根没动它；`stopped` = 启用了但当前没有会话
 * （刚建行还没起，或刚被关掉）；`starting` = 正在起（子进程 + `initialize` 往返，可达几十秒）；
 * `connected` = 接上了，工具已登记；`failed` = 起不来（外部没接上，**或**它那一行形状坏了）。
 */
export type McpServerState = "disabled" | "stopped" | "starting" | "connected" | "failed";

/**
 * 运行期表里的一行。
 * @description ⚠️ **没有 `config` 那一格**：真值是 `mcps` 那一行，这里只记一个 `rowStamp`，存一份配置对象
 *   就是第二份会过期的真值（它永远是「当初那一份」，而库里已经是新的了）。
 */
export interface McpEntry {
  /** 据以起 / 关的那一行的 `updatedAt`（epoch 毫秒）；与库里现在的对不上 = 改过了 ⇒ 重开 */
  rowStamp: number;
  /** 现在什么状态；只有它进 {@link McpEntry.session} */
  state: McpServerState;
  /** 活着的会话；`starting` / `failed` / `disabled` / `stopped` 时为 `undefined` */
  session?: McpSession;
  /** 为什么没接上（`failed` 才有，消息里带子进程 stderr 尾巴或点名到列） */
  error?: Error;
}

/** `ctx.mcp.list()` 交出的一行；配置那一半不在这儿（去 `ctx.services.mcps`） */
export interface McpServerStatus {
  /** 服务器名（工具名 `mcp__<它>__<工具>` 里那一段） */
  readonly name: string;
  /** 现在什么状态（五档，见 {@link McpServerState}） */
  readonly state: McpServerState;
  /** 它自报的名字与版本；没有会话时为空 */
  readonly serverInfo: string;
  /** 已登记的工具键（含 `mcp__` 前缀）；没有会话时为空 */
  readonly tools: readonly string[];
  /** 登记不上的工具**它自己的名字**；空 = 全上来了 */
  readonly skipped: readonly string[];
  /** 为什么没接上（`failed` 才有，消息里带子进程 stderr 尾巴） */
  readonly error?: string;
}

/**
 * 一行运行期状态 + `mcps` 那一行的 `disabled` ⇒ 对外那一行。
 * @description ⚠️ **`entry` 可以没有**：库里有一行而表里没有它，那正是两件事——「有意不起」（`disabled`）
 *   与「启用了但还没起 / 刚关掉」（`stopped`）。运行期是同一种「没有会话」，可它们要说的是不同的意思，
 *   所以状态必须从那一行补出来。
 */
export function toStatus(name: string, entry: McpEntry | undefined, disabled: boolean): McpServerStatus {
  const session = entry?.session;
  return {
    name,
    state: entry?.state ?? (disabled ? "disabled" : "stopped"),
    serverInfo: session?.serverInfo ?? "",
    tools: session?.toolNames ?? [],
    skipped: session?.skipped ?? [],
    ...(entry?.error === undefined ? {} : { error: entry.error.message }),
  };
}