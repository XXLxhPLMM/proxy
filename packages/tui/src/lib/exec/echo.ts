/** @fileoverview 回显边界：这一条留不留痕（`leavesTrace`，一张**逐条对齐 `Command` 联合**的 `Record`） */

import type { Command } from "@/commands/index.js";

/** 每一条命令在结果区**留不留痕**（`false` = 一个字都不留，只剩副作用说的事） */
/** ⚠️ 这张表**逐条对齐** {@link Command} 那张判别联合而不是一份普通清单（清单是**可数据**，加一条命令忘了加一项编译期一声不吭，于是新命令默认落到「不需要客户端」那一支而测试全绿） */
const LEAVES_TRACE: Readonly<Record<Command["kind"], boolean>> = {
  help: true,
  status: true,
  config: true,
  usage: true,
  acl: true,
  accounts: true,
  // ⚠️ 这一族是**纯界面动作**：一个请求都不发、一个字节都不留（效果由侧边栏 / 改名框 / 弹窗自己回答），
  // 而在结果区留一行等于把同一件事说第二遍 —— 且那一行会落进**敲它那个会话**的桶里
  "session-new": false,
  "session-rename": false,
  "sessions-open": false,
  "targets-open": false,
  "users-open": false,
  "providers-open": false,
  "models-open": false,
  // ⚠️ `/batch` **不留痕**：内层那条命令的回显由扇出那一圈**逐台**加（而那一圈才有原文可复现），
  // 这里再加一行的话同一条命令会在屏上出现 N+1 次
  batch: false,
  clear: true,
  reprobe: true,
  // ⚠️ 纯界面动作（退出）：一个字节都不留，而「它退了」由终端回到提示符这一件事自己回答
  exit: false,
};

/** ⚠️ 返回类型是 `boolean` 而不是 `boolean | undefined`：表**穷尽**联合，故「命令表加了新命令而这里没加」时不会静默给出 `false` */
export function leavesTrace(command: Command): boolean {
  return LEAVES_TRACE[command.kind];
}