/**
 * @fileoverview 回显那一行：含凭据的三条命令在这里把凭据换成掩码
 * @module exec/echo
 * @description
 * 无凭据的命令回显**用户敲的原文**；`user pass` / `user set … password` / `target add` 这三条回显**由命令
 * 重建**、把凭据那一格换成掩码。⚠️ 原因是在原文里做位置替换会打错位置：`user pass bob bob` 里第一个 `bob`
 * 是用户名，替换它就把用户名打了码而**密码留在屏幕上**。原文里没有「哪个位置是凭据」这件事（引号、空格、
 * 引号内空格都会让下标推不出来），而命令表里有 —— 掩码的判据必须住在有那个信息的地方。
 */

import { COMMAND_PREFIX, type Command } from "@/cmd/index.js";
import { maskEcho, type LogRow } from "@/log/index.js";

/**
 * 回显用户敲的那一行（凭据已掩码）
 * @description ⚠️ 掩码判据是「这是哪一类凭据」而不是「哪条命令」：`maskEcho` 的第一个形参是凭据
 * 类别，而 `user set <用户名> password <值>` 的值就在第 3 位（与 `user pass` 同一位，故走同一档）。
 */
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

/**
 * `user add` 建出来的账号是**空密码**，而命令表里没有密码形参
 * @description 说出来是因为「以为账号有密码」的后果是**代理认它而操作者不知道它的口令是什么**。⚠️
 * 这不是本层编的结论：命令表（`@/cmd/specs.js` 的 `user add`）只有用户名与流量上限两个形参。
 */
export const NO_PASSWORD_ARG =
  `${COMMAND_PREFIX}user add 没有密码形参，建出来的是空密码账号（要口令用 ${COMMAND_PREFIX}user pass <用户名> <新密码>）`;