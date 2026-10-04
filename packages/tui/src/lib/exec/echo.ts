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
  "show-managers": false,
  clear: true,
  reprobe: true,
};

/** ⚠️ 返回类型是 `boolean` 而不是 `boolean | undefined`：表**穷尽**联合，故「命令表加了新命令而这里没加」时不会静默给出 `false` */
export function leavesTrace(command: Command): boolean {
  return LEAVES_TRACE[command.kind];
}

/** `user add` 建出来的是**空密码**账号（命令表里没有密码形参），说出来是因为「以为账号有密码」的后果是代理认它而操作者不知道它的口令 */
export const NO_PASSWORD_ARG =
  `${COMMAND_PREFIX}user add 没有密码形参，建出来的是空密码账号（要口令用 ${COMMAND_PREFIX}user pass <用户名> <新密码>）`;