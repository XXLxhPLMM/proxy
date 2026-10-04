/**
 * 本目录各档共用的两条便捷断言。
 *
 * ⚠️ 收件门槛是「**两个以上文件真用到**」，不是「看起来通用」：四档全部用到 `ok` / `fails`，
 * 故它们在这里；而只服务一档的（`VALID_ARG`、`quotaOf`、`expectNoLeak`）留在那个档里 ——
 * 搬进来就成了一份没人能单独删掉、也没人说得清谁在用的间接层。
 *
 * ⚠️ 两条都**自己补上 `COMMAND_PREFIX`**：本目录的用例写的是命令名（多级用空格连写），而前缀
 * 那条形状不变量由 `command-table.test.ts` 里专门一组断言管（见本目录 `AGENTS.md`
 * 「用例写的是命令名」）。
 *
 * @module tests/parse
 */

import { COMMAND_PREFIX, parseLine, type Command, type ParseResult } from "@/commands/parse.js";

/**
 * 必须是 `ok`，并把命令交出来（失败时让 vitest 打印那一档的实际形状）
 * @description ⚠️ **这里补上 {@link COMMAND_PREFIX}**：本目录的用例写的是命令名，而前缀那条
 * 不变量由 `command-table.test.ts` 里专门一组断言管（见本目录 `AGENTS.md`「用例写的是命令名」）。
 */
export function ok(line: string): Command {
  const result = parseLine(COMMAND_PREFIX + line);
  if (result.kind !== "ok") {
    throw new Error(`期望 ok，实际是 ${result.kind}：${JSON.stringify(result)}`);
  }
  return result.command;
}

/** 必须是某一档失败 */
export function fails(line: string, kind: ParseResult["kind"]): ParseResult {
  const result = parseLine(COMMAND_PREFIX + line);
  if (result.kind !== kind) {
    throw new Error(`期望 ${kind}，实际是 ${result.kind}：${JSON.stringify(result)}`);
  }
  return result;
}
