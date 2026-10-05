/** @fileoverview 回显边界：这一条留不留痕（`leavesTrace`），留痕的那一行怎么写（`echoOf` 的凭据掩码） */

import { COMMAND_PREFIX, type Command } from "@/commands/index.js";
import { maskEcho, type LogRow } from "@/lib/log/index.js";

/** 回显用户敲的那一行（凭据已掩码）；⚠️ 含凭据的那三条**由命令重建**——在原文里做位置替换会打错位置（`user pass bob bob` 里第一个 `bob` 是用户名） */
export function echoOf(command: Command, line: string): LogRow {
  switch (command.kind) {
    case "user-pass":
      return {
        kind: "echo",
        text: `${COMMAND_PREFIX}user pass ${command.username} ${maskEcho("user-pass", command.password)}`,
      };
    case "target-add": {
      const tail = command.timeoutMs === null ? "" : ` ${String(command.timeoutMs)}`;
      return {
        kind: "echo",
        text: `${COMMAND_PREFIX}target add ${command.name} ${command.baseUrl} ${maskEcho("target-add", command.token)}${tail}`,
      };
    }
    // ⚠️ **由命令重建而不是就地替换**：凭据可能在原文里出现在第三个位置（地址里也可能有它），
    // 而按位置替换会把地址里的那一段也打码 —— 于是回显说的不是用户敲的那条命令
    case "provider-set":
      return {
        kind: "echo",
        text: `${COMMAND_PREFIX}provider set ${command.baseUrl} ${command.model} ${maskEcho("provider-key", command.apiKey)}`,
      };
    case "provider-key":
      return {
        kind: "echo",
        text: `${COMMAND_PREFIX}provider key ${maskEcho("provider-key", command.apiKey)}`,
      };
    case "user-set":
      if (command.field === "password") {
        return {
          kind: "echo",
          text: `${COMMAND_PREFIX}user set ${command.username} password ${maskEcho("user-pass", command.value)}`,
        };
      }
      return { kind: "echo", text: line };
    default:
      return { kind: "echo", text: line };
  }
}

/** 每一条命令在结果区**留不留痕**（`false` = 一个字都不留，只剩副作用说的事） */
/** ⚠️ 这张表**逐条对齐** {@link Command} 那张判别联合而不是一份普通清单（清单是**可数据**，加一条命令忘了加一项编译期一声不吭，于是新命令默认落到「不需要客户端」那一支而测试全绿） */
const LEAVES_TRACE: Readonly<Record<Command["kind"], boolean>> = {
  help: true,
  status: true,
  config: true,
  usage: true,
  acl: true,
  users: true,
  "user-add": true,
  "user-set": true,
  "user-on": true,
  "user-off": true,
  "user-del": true,
  "user-pass": true,
  "target-add": true,
  "target-del": true,
  "target-switch": true,
  "session-new": false,
  "session-rename": false,
  "sessions-open": false,
  // ⚠️ `/batch` **不留痕**：内层那条命令的回显由扇出那一圈**逐台**加（而那一圈才有原文可掩码），
  // 这里再加一行的话同一条命令会在屏上出现 N+1 次 —— 而凭据那一格会被多打码一次
  "batch": false,
  "show-managers": false,
  "provider-show": true,
  "provider-set": true,
  "provider-key": true,
  clear: true,
  reprobe: true,
  // ⚠️ 纯界面动作（退出）：一个字节都不留，而「它退了」由终端回到提示符这一件事自己回答
  exit: false,
};

/** ⚠️ 返回类型是 `boolean` 而不是 `boolean | undefined`：表**穷尽**联合，故「命令表加了新命令而这里没加」时不会静默给出 `false` */
export function leavesTrace(command: Command): boolean {
  return LEAVES_TRACE[command.kind];
}

/** `user add` 建出来的是**空密码**账号（命令表里没有密码形参），说出来是因为「以为账号有密码」的后果是代理认它而操作者不知道它的口令 */
export const NO_PASSWORD_ARG =
  `${COMMAND_PREFIX}user add 没有密码形参，建出来的是空密码账号（要口令用 ${COMMAND_PREFIX}user pass <用户名> <新密码>）`;